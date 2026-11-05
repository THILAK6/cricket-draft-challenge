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
   * Grandmaster AI Draft Algorithm:
   * Format-Aware, Pitch-Aware, Value-Over-Replacement Draft Engine.
   * Instead of rigid sequential slot filling, AI evaluates every legal (candidate, vacantSlot)
   * pair in the pool. It snipes generational stars (Bumrah, Kohli, Cummins, etc.) early,
   * matches them to their optimal slot, and counters pitch conditions ruthlessly.
   */
  private executeAiPick() {
    if (!this.draftState || this.draftState.pool.length === 0) return;

    const squad = this.draftState.aiPicks;
    const challenge = this.draftState.challenge;
    const pitchType = challenge.venue.pitch_type;
    const format = challenge.format || "T20";
    const isTest = format === "TEST";
    const isOdi = format === "ODI";
    const isT20 = format === "T20";

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
    const bowlingOptionsCount = nonNullAi.filter(
      (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0
    ).length;
    const openerCount = (squad[0] ? 1 : 0) + (squad[1] ? 1 : 0);

    // Strict Pitch Quotas:
    // Flat & Green tracks: Max 1 spinner in the entire XI!
    const disallowMoreSpinners =
      (pitchType === "HIGH_SCORING_FLAT" || pitchType === "GREEN_SEAMER") && spinnerCount >= 1;

    // Evaluate every legal (candidate, slot) combination
    interface ScoredPair {
      player: PlayerWithStats;
      slotIndex: number;
      score: number;
    }

    const candidatePairs: ScoredPair[] = [];

    for (const p of this.draftState.pool) {
      const isPacer = p.bowling_category === "PACE";
      const isSpinner = p.bowling_category === "SPIN";
      const isWK = p.primary_role === "WK";
      const isAR = p.primary_role === "AR";
      const isBat = p.primary_role === "BAT";
      const isBowl = p.primary_role === "BOWL";
      const matches = Math.max(1, p.stats.matches);

      // Pitch restriction
      if (disallowMoreSpinners && isSpinner) continue;

      // Calculate Player Base Quality for the specific format
      let quality = 0;
      if (isTest) {
        // TEST: Batting average & resistance are king; Bowling average & wickets per match rule
        if (isBat || isWK || isAR) {
          const avg = p.stats.bat_average || 25;
          quality += Math.pow(Math.min(65, avg) / 38.0, 1.8) * 75;
          if (avg >= 50.0) quality += 40; // Platinum test batters (Smith, Root, Williamson)
          else if (avg >= 42.0) quality += 25;
        }
        if (isBowl || isAR) {
          const bowlAvg = p.stats.bowl_average || 35.0;
          const wpm = p.stats.bowl_wickets / matches;
          quality += (28.0 / Math.max(18.0, bowlAvg)) * 80 + Math.min(3.5, wpm) * 15;
          if (bowlAvg <= 24.0 && matches >= 15) quality += 40; // Elite test strike weapons (Bumrah, Cummins, Anderson)
        }
        // Test Experience / Caps resilience
        quality += Math.min(35, matches * 0.6);
      } else if (isOdi) {
        // ODI: High average + healthy strike rate + low economy
        if (isBat || isWK || isAR) {
          quality += (p.stats.bat_average / 38.0) * 55 + (p.stats.bat_strike_rate / 90.0) * 35;
          if (p.stats.bat_average >= 45.0) quality += 30;
        }
        if (isBowl || isAR) {
          const econ = p.stats.bowl_economy || 5.8;
          quality += (5.2 / Math.max(3.8, econ)) * 55 + (p.stats.bowl_wickets / matches) * 20;
          if (econ <= 4.8) quality += 25;
        }
        quality += Math.min(25, matches * 0.3);
      } else {
        // T20: Boundary hitting strike rate & death economy
        if (isBat || isWK || isAR) {
          quality += (p.stats.bat_strike_rate / 135.0) * 65 + (p.stats.bat_average / 30.0) * 35;
          if (p.stats.bat_strike_rate >= 145.0) quality += 30;
        }
        if (isBowl || isAR) {
          const econ = p.stats.bowl_economy || 8.0;
          quality += (7.6 / Math.max(5.8, econ)) * 55 + (p.stats.bowl_wickets / matches) * 20;
          if (econ <= 7.2) quality += 30;
        }
        quality += Math.min(20, matches * 0.25);
      }

      // Pitch Synergy
      let pitchBonus = 0;
      if (pitchType === "GREEN_SEAMER" && isPacer) {
        pitchBonus += isTest ? 55 : 40; // Seamers rule green tops
      } else if (pitchType === "DUSTBOWL" && isSpinner) {
        pitchBonus += isTest ? 60 : 45; // Spinners dominate turners
      } else if (pitchType === "SLOW_LOW" && isSpinner) {
        pitchBonus += 35;
      } else if (pitchType === "HIGH_SCORING_FLAT") {
        if (isPacer && p.stats.bowl_economy > 0 && p.stats.bowl_economy <= (isT20 ? 7.6 : 5.0)) pitchBonus += 35;
        if (isBat && p.stats.bat_strike_rate >= (isT20 ? 140 : 95)) pitchBonus += 30;
      }

      // Test each vacant slot for positional legality and tactical fit
      for (const slotIdx of emptyIndices) {
        const legalCheck = canPickPlayer(p, squad, challenge, slotIdx);
        if (!legalCheck.allowed) continue;

        let slotFit = 0;

        if (slotIdx === 0 || slotIdx === 1) {
          // OPENERS
          if (isBowl) {
            slotFit -= 1500;
          } else if (p.stats.top_order_innings >= 8 || (isBat && p.stats.top_order_innings / Math.max(1, p.stats.bat_innings) >= 0.35)) {
            slotFit += 60;
          } else if (isBat || isWK) {
            slotFit += 25;
          } else {
            slotFit -= 400; // Finishers/tailenders penalized
          }
        } else if (slotIdx === 2) {
          // #3 ANCHOR
          if (isBowl) {
            slotFit -= 1500;
          } else if (p.stats.bat_average >= (isTest ? 42.0 : 38.0) && (isBat || isWK)) {
            slotFit += 55;
          } else if (isBat || isWK) {
            slotFit += 30;
          } else {
            slotFit -= 350;
          }
        } else if (slotIdx === 3 || slotIdx === 4) {
          // MIDDLE ORDER (4 & 5)
          if (isBowl) {
            slotFit -= 1000;
          } else if (isBat || isWK || isAR) {
            slotFit += 50;
            if (p.stats.middle_order_innings >= 8) slotFit += 15;
          }
        } else if (slotIdx === 5 || slotIdx === 6) {
          // SLOTS 6 & 7: FORMAT SPECIFIC
          if (isTest) {
            // In Tests: All-Rounders (Stokes, Jadeja, Kallis) or solid WK (Gilchrist, Pant, Watling)
            if (isAR) slotFit += 65;
            else if (isWK) slotFit += 55;
            else if (isBat && p.stats.bat_average >= 32.0) slotFit += 45;
            else slotFit -= 150;
          } else {
            // In T20 / ODI: Explosive Finishers
            if (isAR) slotFit += 60;
            else if (p.stats.finisher_innings >= 5 || p.stats.bat_strike_rate >= (isT20 ? 140 : 100)) slotFit += 60;
            else if (isWK) slotFit += 40;
            else if (isBat) slotFit += 25;
            else slotFit -= 200;
          }
        } else if (slotIdx === 7) {
          // LOWER ORDER / BOWLING AR (Slot 8)
          if (isAR) slotFit += 60;
          else if (isBowl && p.stats.bat_average >= 14.0) slotFit += 55;
          else if (isBowl) slotFit += 40;
          else slotFit -= 150;
        } else {
          // FRONTLINE BOWLERS (Slots 8, 9, 10 - #9, 10, 11)
          if (isBowl || isAR) {
            slotFit += 60;
            // Spearheads into slot 9/10
            if (p.stats.bowl_wickets >= (isTest ? 60 : 40)) slotFit += 20;
          } else {
            slotFit -= 2000; // Never pick pure batter at #9-11
          }
        }

        // Squad Need Urgency
        let urgency = 0;
        if (!hasKeeper && isWK) {
          urgency += emptyIndices.length <= 4 ? 200 : 80;
        }
        if (bowlingOptionsCount < 5 && (isBowl || isAR)) {
          urgency += emptyIndices.length <= 5 ? 160 : 70;
        }
        if (openerCount < 2 && (slotIdx === 0 || slotIdx === 1) && (isBat || isWK)) {
          urgency += emptyIndices.length <= 4 ? 120 : 50;
        }

        const totalScore = quality + pitchBonus + slotFit + urgency;
        candidatePairs.push({ player: p, slotIndex: slotIdx, score: totalScore });
      }
    }

    if (candidatePairs.length === 0) {
      // Fallback: pick first legal player into first empty slot
      const fallbackSlot = emptyIndices[0];
      const legal = this.draftState.pool.filter(
        (p) => canPickPlayer(p, squad, challenge, fallbackSlot).allowed
      );
      const chosen = legal.length > 0 ? legal[0] : this.draftState.pool[0];
      const pIdx = this.draftState.pool.findIndex((p) => p.id === chosen.id);
      if (pIdx !== -1) {
        const [picked] = this.draftState.pool.splice(pIdx, 1);
        squad[fallbackSlot] = picked;
        this.draftState.currentTurn = "USER";
        this.draftState.round += 1;
        this.draftState.lastActionTimestamp = Date.now();
      }
      return;
    }

    // Sort by grandmaster score descending
    candidatePairs.sort((a, b) => b.score - a.score);
    const best = candidatePairs[0];

    const pIdx = this.draftState.pool.findIndex((p) => p.id === best.player.id);
    if (pIdx !== -1) {
      const [picked] = this.draftState.pool.splice(pIdx, 1);
      squad[best.slotIndex] = picked;
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
