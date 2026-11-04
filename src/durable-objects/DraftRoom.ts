import type { Challenge, DraftState, PlayerWithStats, ScoringBreakdown } from "../core/types";
import { validateSquad, canPickPlayer } from "../core/validator";
import { calculateDeterministicScore, applyBoundedAdjustment } from "../core/scoring";
import { evaluateGroundConditionsWithGemini } from "../core/gemini-referee";
import { simulateCricketMatch } from "../core/simulator";

export class DraftRoom implements DurableObject {
  private state: DurableObjectState;
  private env: any;
  private draftState: DraftState | null = null;
  private sockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Load persisted state if not in memory
    if (!this.draftState) {
      this.draftState = (await this.state.storage.get<DraftState>("draftState")) ?? null;
      if (this.draftState) {
        this.normalizeSquads(this.draftState);
      }
    }

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      const body = await request.json<DraftState>();
      this.normalizeSquads(body);
      this.draftState = body;
      await this.state.storage.put("draftState", this.draftState);
      this.broadcast({ type: "INIT", state: this.draftState });
      return Response.json({ success: true, state: this.draftState });
    }

    if (url.pathname.endsWith("/state") && request.method === "GET") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 404 });
      }
      return Response.json({ state: this.draftState });
    }

    if (url.pathname.endsWith("/pick") && request.method === "POST") {
      if (!this.draftState || (this.draftState.status !== "DRAFTING" && this.draftState.status !== "SOLO_PICK")) {
        return Response.json({ error: "Draft not in drafting state" }, { status: 400 });
      }

      const { playerId, targetIndex } = await request.json<{ playerId: string; targetIndex?: number }>();

      if (this.draftState.currentTurn !== "USER") {
        return Response.json({ error: "Not user turn" }, { status: 403 });
      }

      const userPickResult = this.executePick(playerId, "USER", targetIndex);
      if (!userPickResult.success) {
        return Response.json({ error: userPickResult.error }, { status: 400 });
      }

      const userFilled = this.draftState.userPicks.filter(Boolean).length;
      const aiFilled = this.draftState.aiPicks.filter(Boolean).length;

      // Check if draft complete
      if (userFilled >= 11 && aiFilled >= 11) {
        await this.finishDraft();
      } else {
        // Trigger AI Pick if AI still needs players
        if (aiFilled < 11) {
          this.executeAiPick();
        } else {
          this.draftState.currentTurn = "USER";
        }

        const userFilledAfter = this.draftState.userPicks.filter(Boolean).length;
        const aiFilledAfter = this.draftState.aiPicks.filter(Boolean).length;
        if (userFilledAfter >= 11 && aiFilledAfter >= 11) {
          await this.finishDraft();
        }
      }

      await this.state.storage.put("draftState", this.draftState);
      this.broadcast({ type: "UPDATE", state: this.draftState });

      return Response.json({ success: true, state: this.draftState });
    }

    if (url.pathname.endsWith("/referee") && request.method === "POST") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 400 });
      }

      await this.finishDraft();
      return Response.json({ success: true, results: (this.draftState as any).results });
    }

    if (url.pathname.endsWith("/remove") && request.method === "POST") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 400 });
      }

      const { playerId, slotIndex } = await request.json<{ playerId?: string; slotIndex?: number }>();

      let targetIdx = -1;
      if (typeof slotIndex === "number" && slotIndex >= 0 && slotIndex < 11) {
        targetIdx = slotIndex;
      } else if (playerId) {
        targetIdx = this.draftState.userPicks.findIndex((p) => p !== null && p.id === playerId);
      }

      if (targetIdx === -1 || !this.draftState.userPicks[targetIdx]) {
        return Response.json({ error: "Player not found in chosen slot" }, { status: 400 });
      }

      // Return player to available pool
      const removed = this.draftState.userPicks[targetIdx]!;
      this.draftState.userPicks[targetIdx] = null;
      this.draftState.pool.unshift(removed);

      // Revert from completed state if necessary
      if (this.draftState.status === "COMPLETED") {
        this.draftState.status = "DRAFTING";
      }

      // Set turn back to user so they can pick their replacement
      this.draftState.currentTurn = "USER";
      this.draftState.lastActionTimestamp = Date.now();

      await this.state.storage.put("draftState", this.draftState);
      this.broadcast({ type: "UPDATE", state: this.draftState });

      return Response.json({ success: true, state: this.draftState });
    }

    if (url.pathname.endsWith("/reorder") && request.method === "POST") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 400 });
      }

      const { fromIndex, toIndex } = await request.json<{ fromIndex: number; toIndex: number }>();

      if (fromIndex < 0 || fromIndex >= 11 || toIndex < 0 || toIndex >= 11) {
        return Response.json({ error: "Invalid slot indices (must be 0-10)" }, { status: 400 });
      }

      // Swap positions
      const temp = this.draftState.userPicks[fromIndex];
      this.draftState.userPicks[fromIndex] = this.draftState.userPicks[toIndex];
      this.draftState.userPicks[toIndex] = temp;

      await this.state.storage.put("draftState", this.draftState);
      this.broadcast({ type: "UPDATE", state: this.draftState });

      return Response.json({ success: true, state: this.draftState });
    }

    return new Response("Not found", { status: 404 });
  }

  private normalizeSquads(state: DraftState) {
    if (!Array.isArray(state.userPicks) || state.userPicks.length !== 11) {
      const existing = (state.userPicks || []).filter(Boolean);
      state.userPicks = Array(11).fill(null);
      for (let i = 0; i < Math.min(11, existing.length); i++) {
        state.userPicks[i] = existing[i];
      }
    }
    if (!Array.isArray(state.aiPicks) || state.aiPicks.length !== 11) {
      const existing = (state.aiPicks || []).filter(Boolean);
      state.aiPicks = Array(11).fill(null);
      for (let i = 0; i < Math.min(11, existing.length); i++) {
        state.aiPicks[i] = existing[i];
      }
    }
  }

  private handleWebSocket(ws: WebSocket) {
    ws.accept();
    this.sockets.add(ws);

    if (this.draftState) {
      ws.send(JSON.stringify({ type: "SYNC", state: this.draftState }));
    }

    ws.addEventListener("close", () => {
      this.sockets.delete(ws);
    });

    ws.addEventListener("message", async (msg) => {
      try {
        const data = JSON.parse(msg.data as string);
        if (data.type === "PICK" && this.draftState?.currentTurn === "USER") {
          this.executePick(data.playerId, "USER", data.targetIndex);
          const userFilled = this.draftState.userPicks.filter(Boolean).length;
          const aiFilled = this.draftState.aiPicks.filter(Boolean).length;

          if (userFilled >= 11 && aiFilled >= 11) {
            await this.finishDraft();
          } else if (aiFilled < 11) {
            this.executeAiPick();
            if (this.draftState.userPicks.filter(Boolean).length >= 11 && this.draftState.aiPicks.filter(Boolean).length >= 11) {
              await this.finishDraft();
            }
          }
          await this.state.storage.put("draftState", this.draftState);
          this.broadcast({ type: "UPDATE", state: this.draftState });
        }
      } catch (err) {
        // ignore malformed socket payload
      }
    });
  }

  private broadcast(message: any) {
    const raw = JSON.stringify(message);
    for (const ws of this.sockets) {
      try {
        ws.send(raw);
      } catch (e) {
        this.sockets.delete(ws);
      }
    }
  }

  private executePick(
    playerId: string,
    actor: "USER" | "AI",
    targetIndex?: number
  ): { success: boolean; error?: string } {
    if (!this.draftState) return { success: false, error: "No state" };

    const pIdx = this.draftState.pool.findIndex((p) => p.id === playerId);
    if (pIdx === -1) {
      return { success: false, error: "Player not in available pool" };
    }

    const candidate = this.draftState.pool[pIdx];
    const squad = actor === "USER" ? this.draftState.userPicks : this.draftState.aiPicks;

    // Determine target slot
    let slotIdx: number;
    if (typeof targetIndex === "number" && targetIndex >= 0 && targetIndex < 11) {
      slotIdx = targetIndex;
    } else {
      slotIdx = squad.findIndex((p) => p === null);
      if (slotIdx === -1) {
        return { success: false, error: "Squad is already full (11 players)" };
      }
    }

    const check = canPickPlayer(candidate, squad, this.draftState.challenge, slotIdx);
    if (!check.allowed) {
      return { success: false, error: check.reason || "Illegal pick" };
    }

    // Remove candidate from pool
    const [picked] = this.draftState.pool.splice(pIdx, 1);

    // If target slot already had a player, return that player to pool
    const existing = squad[slotIdx];
    if (existing) {
      this.draftState.pool.push(existing);
    }

    // Place player directly in target slot
    squad[slotIdx] = picked;

    if (actor === "USER") {
      this.draftState.currentTurn = "AI";
    } else {
      this.draftState.currentTurn = "USER";
      this.draftState.round += 1;
    }

    this.draftState.lastActionTimestamp = Date.now();
    return { success: true };
  }

  /**
   * Slot-Aware, Pitch-Aware AI Draft Logic:
   * AI NEVER picks Hardik as an opener (slots 0-1 reserved for top order).
   * AI NEVER picks 5 spinners at Wankhede or Lord's (max 1 spinner on flat/seam tracks).
   */
  private executeAiPick() {
    if (!this.draftState || this.draftState.pool.length === 0) return;

    const squad = this.draftState.aiPicks;
    const challenge = this.draftState.challenge;
    const pitchType = challenge.venue.pitch_type;

    // Find all vacant slots
    const emptyIndices: number[] = [];
    for (let i = 0; i < 11; i++) {
      if (squad[i] === null) emptyIndices.push(i);
    }

    if (emptyIndices.length === 0) return;

    const nonNullAi = squad.filter((p): p is PlayerWithStats => p !== null);
    const hasKeeper = nonNullAi.some((p) => p.primary_role === "WK");
    const spinnerCount = nonNullAi.filter((p) => p.bowling_category === "SPIN").length;
    const pacerCount = nonNullAi.filter((p) => p.bowling_category === "PACE").length;
    const bowlerCount = nonNullAi.filter((p) => p.primary_role === "BOWL" || p.primary_role === "AR").length;

    // Target slot prioritization:
    let targetSlotIndex = emptyIndices[0];
    if (emptyIndices.includes(0)) targetSlotIndex = 0;
    else if (emptyIndices.includes(1)) targetSlotIndex = 1;
    else if (emptyIndices.includes(2)) targetSlotIndex = 2;
    else if (emptyIndices.some((idx) => idx >= 8) && bowlerCount < 4) {
      targetSlotIndex = emptyIndices.find((idx) => idx >= 8)!;
    } else if (emptyIndices.includes(5) || emptyIndices.includes(6)) {
      targetSlotIndex = emptyIndices.find((idx) => idx === 5 || idx === 6)!;
    }

    // Find legal candidates for this target slot
    let legal = this.draftState.pool.filter(
      (p) => canPickPlayer(p, squad, challenge, targetSlotIndex).allowed
    );

    if (legal.length === 0) {
      // Try alternate empty slots
      for (const slotIdx of emptyIndices) {
        const alt = this.draftState.pool.filter(
          (p) => canPickPlayer(p, squad, challenge, slotIdx).allowed
        );
        if (alt.length > 0) {
          targetSlotIndex = slotIdx;
          legal = alt;
          break;
        }
      }
    }

    const poolToScore = legal.length > 0 ? legal : this.draftState.pool;

    // Strict Pitch Quota Check:
    // Flat / Seam tracks: Max 1 spinner in the entire XI!
    const disallowMoreSpinners =
      (pitchType === "HIGH_SCORING_FLAT" || pitchType === "GREEN_SEAMER") && spinnerCount >= 1;

    const needsKeeperUrgent = !hasKeeper && emptyIndices.length <= 4;

    const scored = poolToScore.map((p) => {
      let score = 0;
      const isPacer = p.bowling_category === "PACE";
      const isSpinner = p.bowling_category === "SPIN";
      const isWK = p.primary_role === "WK";
      const isAR = p.primary_role === "AR";
      const isBat = p.primary_role === "BAT";
      const isBowl = p.primary_role === "BOWL";

      // Positional role evaluation
      if (targetSlotIndex === 0 || targetSlotIndex === 1) {
        // OPENERS: Must be genuine openers (Kohli, Rohit, Warner, de Kock, Buttler, etc.)
        if (isBowl) {
          score -= 1000;
        } else if (p.stats.top_order_innings >= 10 || (isBat && p.stats.top_order_innings / Math.max(1, p.stats.bat_innings) >= 0.35)) {
          score += 100 + p.stats.bat_average * 1.5 + (p.stats.bat_strike_rate / 130) * 20 + p.stats.top_order_innings * 0.4;
        } else if (isBat || isWK) {
          score += 25 + p.stats.bat_average;
        } else {
          score -= 500; // Finishers/ARs (Hardik) penalized as openers
        }
      } else if (targetSlotIndex === 2) {
        // TOP ORDER ANCHOR (No. 3)
        if (isBowl) {
          score -= 1000;
        } else if (p.stats.bat_average >= 38.0 && (isBat || isWK)) {
          score += 100 + p.stats.bat_average * 2.0 + (p.stats.matches / 10);
        } else if (isBat || isWK) {
          score += 50 + p.stats.bat_average * 1.2;
        } else {
          score -= 300;
        }
      } else if (targetSlotIndex === 3 || targetSlotIndex === 4) {
        // MIDDLE ORDER (No. 4 & 5)
        if (isBowl) {
          score -= 800;
        } else if (isBat || isWK || isAR) {
          score += 80 + p.stats.bat_average * 1.2 + (p.stats.bat_strike_rate / 130) * 15;
          if (p.stats.middle_order_innings >= 8) score += 20;
        }
      } else if (targetSlotIndex === 5 || targetSlotIndex === 6) {
        // FINISHERS & ALL-ROUNDERS (No. 6 & 7 - Hardik, Stokes, Maxwell, Russell)
        if (isAR) {
          score += 90 + (p.stats.bat_strike_rate / 135) * 25 + p.stats.finisher_innings * 2;
        } else if (p.stats.finisher_innings >= 5 || p.stats.bat_strike_rate >= 140) {
          score += 75 + (p.stats.bat_strike_rate / 135) * 25 + p.stats.bat_average * 0.8;
        } else if (isBat) {
          score += 30 + (p.stats.bat_strike_rate / 130) * 15;
        } else {
          score -= 200;
        }
      } else if (targetSlotIndex === 7) {
        // LOWER ORDER / BOWLING AR (No. 8)
        if (isAR || (isBowl && p.stats.bat_average >= 14.0)) {
          score += 90 + p.stats.bat_average * 1.5 + (p.stats.bowl_wickets / Math.max(1, p.stats.matches)) * 20;
        } else if (isBowl) {
          score += 60;
        } else {
          score -= 100;
        }
      } else {
        // FRONTLINE BOWLERS (Slots 8, 9, 10 - No. 9, 10, 11)
        if (isBowl || isAR) {
          score += 80 + (7.8 / Math.max(5.5, p.stats.bowl_economy || 8.0)) * 30 + (p.stats.bowl_wickets / Math.max(1, p.stats.matches)) * 25;
        } else {
          score -= 1000; // Never pick pure batter at No. 11
        }
      }

      // Pitch Suitability Quotas:
      if (disallowMoreSpinners && isSpinner) {
        score -= 500; // Strictly prevent 5 spinners at Wankhede or Lord's
      }
      if (pitchType === "HIGH_SCORING_FLAT" && isPacer) {
        score += 35; // Wankhede pace boost
      }
      if (pitchType === "GREEN_SEAMER" && isPacer) {
        score += 40; // Lord's seam boost
      }
      if (pitchType === "DUSTBOWL" && isSpinner) {
        score += 40; // Chepauk spin boost
      }

      // Mandatory keeper guard
      if (needsKeeperUrgent && isWK) {
        score += 150;
      }

      return { player: p, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const chosen = scored[0].player;

    const pIdx = this.draftState.pool.findIndex((p) => p.id === chosen.id);
    if (pIdx !== -1) {
      const [picked] = this.draftState.pool.splice(pIdx, 1);
      squad[targetSlotIndex] = picked;
      this.draftState.currentTurn = "USER";
      this.draftState.round += 1;
      this.draftState.lastActionTimestamp = Date.now();
    }
  }

  private async finishDraft() {
    if (!this.draftState) return;

    this.draftState.status = "COMPLETED";

    // 1. Run realistic ball-by-ball match simulation
    const simulation = simulateCricketMatch(
      this.draftState.userPicks,
      this.draftState.aiPicks,
      this.draftState.challenge
    );
    this.draftState.simulation = simulation;

    // 2. Compute deterministic scores
    const userBreakdown = calculateDeterministicScore(this.draftState.userPicks, this.draftState.challenge);
    const aiBreakdown = calculateDeterministicScore(this.draftState.aiPicks, this.draftState.challenge);

    // 3. Ground conditions & referee report
    const apiKey = this.env?.GEMINI_API_KEY;
    const evaluation = await evaluateGroundConditionsWithGemini(
      this.draftState.userPicks,
      this.draftState.aiPicks,
      this.draftState.challenge,
      apiKey
    );

    const completedResults = {
      userScore: evaluation.user_score,
      aiScore: evaluation.ai_score,
      userAdjustment: evaluation.user_adjustment,
      aiAdjustment: evaluation.ai_adjustment,
      winner: simulation.winner !== "TIE" && simulation.winner !== "DRAW" ? simulation.winner : evaluation.winner,
      decisiveDifference: simulation.decisiveDifference || evaluation.decisive_difference,
      whyWinnerWon: simulation.whyWinnerWon?.length ? simulation.whyWinnerWon : evaluation.why_winner_won,
      whyLoserLost: simulation.whyLoserLost?.length ? simulation.whyLoserLost : evaluation.why_loser_lost,
      groundConditionsAnalysis: simulation.groundConditionsAnalysis || evaluation.ground_conditions_analysis,
      verdictSummary: simulation.summary || evaluation.verdict_summary,
      simulation,
      userBreakdown,
      aiBreakdown,
    };

    (this.draftState as any).results = completedResults;

    await this.state.storage.put("draftState", this.draftState);
    this.broadcast({
      type: "COMPLETED",
      results: completedResults,
    });
  }
}
