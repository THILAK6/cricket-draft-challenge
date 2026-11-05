import type { Challenge, DraftState, PlayerWithStats, ScoringBreakdown } from "../core/types";
import { validateSquad, canPickPlayer, type PickContext } from "../core/validator";
import { calculateDeterministicScore, applyBoundedAdjustment } from "../core/scoring";
import { evaluateGroundConditionsWithGemini } from "../core/gemini-referee";
import { simulateCricketMatch } from "../core/simulator";

function isValidSlot(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 11;
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    const body = await request.json<T>();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function generateSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646) + 1;
}

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

    // Load persisted state if not in memory (before WS upgrade so SYNC works after eviction)
    if (!this.draftState) {
      this.draftState = (await this.state.storage.get<DraftState>("draftState")) ?? null;
      if (this.draftState) {
        this.normalizeSquads(this.draftState);
      }
    }

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      // A room can only be initialized once; the public proxy also blocks this path.
      if (this.draftState) {
        return Response.json({ error: "Draft room already initialized" }, { status: 409 });
      }
      const body = await readJson<DraftState>(request);
      if (!body || !body.challenge || !Array.isArray(body.pool)) {
        return Response.json({ error: "Invalid init payload" }, { status: 400 });
      }
      this.normalizeSquads(body);
      body.matchSeed = body.matchSeed ?? generateSeed();
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
      const body = await readJson<{ playerId?: unknown; targetIndex?: unknown }>(request);
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });

      const result = this.applyUserPick(body.playerId, body.targetIndex);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: result.status });
      }

      await this.persistAndBroadcast();
      return Response.json({ success: true, state: this.draftState, aiPick: this.draftState!.lastAiSnipe });
    }

    // "/referee" is kept as a legacy alias of "/start-match" with identical guards.
    if ((url.pathname.endsWith("/start-match") || url.pathname.endsWith("/referee")) && request.method === "POST") {
      const result = await this.startMatch();
      if (!result.success) {
        return Response.json({ error: result.error }, { status: result.status });
      }
      return Response.json({ success: true, results: this.draftState!.results, state: this.draftState });
    }

    if (url.pathname.endsWith("/remove") && request.method === "POST") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 400 });
      }

      const body = await readJson<{ playerId?: unknown; slotIndex?: unknown }>(request);
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });

      let targetIdx = -1;
      if (isValidSlot(body.slotIndex)) {
        targetIdx = body.slotIndex;
      } else if (typeof body.playerId === "string") {
        targetIdx = this.draftState.userPicks.findIndex((p) => p !== null && p.id === body.playerId);
      }

      if (targetIdx === -1 || !this.draftState.userPicks[targetIdx]) {
        return Response.json({ error: "Player not found in chosen slot" }, { status: 400 });
      }

      // Return player to available pool
      const removed = this.draftState.userPicks[targetIdx]!;
      this.draftState.userPicks[targetIdx] = null;
      this.draftState.pool.unshift(removed);

      // Squad changed: a fresh simulation is required once it is full again
      if (this.draftState.status === "COMPLETED" || this.draftState.status === "READY_TO_PLAY") {
        this.draftState.status = "DRAFTING";
      }

      // Set turn back to user so they can pick their replacement
      this.draftState.currentTurn = "USER";
      this.draftState.lastActionTimestamp = Date.now();

      await this.persistAndBroadcast();
      return Response.json({ success: true, state: this.draftState, aiPick: this.draftState.lastAiSnipe });
    }

    if (url.pathname.endsWith("/reorder") && request.method === "POST") {
      if (!this.draftState) {
        return Response.json({ error: "Draft room not initialized" }, { status: 400 });
      }

      const body = await readJson<{ fromIndex?: unknown; toIndex?: unknown }>(request);
      if (!body || !isValidSlot(body.fromIndex) || !isValidSlot(body.toIndex)) {
        return Response.json({ error: "Invalid slot indices (must be integers 0-10)" }, { status: 400 });
      }
      const { fromIndex, toIndex } = body;

      // Validate the swap against slot rules (e.g. batting-hand order) before applying it
      const swapped = [...this.draftState.userPicks];
      [swapped[fromIndex], swapped[toIndex]] = [swapped[toIndex], swapped[fromIndex]];
      for (const idx of [fromIndex, toIndex]) {
        const moved = swapped[idx];
        if (!moved) continue;
        const check = canPickPlayer(moved, swapped, this.draftState.challenge, idx);
        if (!check.allowed) {
          return Response.json({ error: check.reason || "Illegal reorder" }, { status: 400 });
        }
      }
      this.draftState.userPicks = swapped;

      // Batting order changed after a completed match: allow a fresh simulation
      if (this.draftState.status === "COMPLETED") {
        this.draftState.status = "READY_TO_PLAY";
      }
      this.draftState.lastActionTimestamp = Date.now();

      await this.persistAndBroadcast();
      return Response.json({ success: true, state: this.draftState, aiPick: this.draftState.lastAiSnipe });
    }

    return new Response("Not found", { status: 404 });
  }

  /**
   * Validates and applies a user pick, then lets the AI respond. Shared by HTTP and WebSocket.
   */
  private applyUserPick(
    playerId: unknown,
    targetIndex: unknown
  ): { success: true } | { success: false; error: string; status: number } {
    const ds = this.draftState;
    if (!ds || (ds.status !== "DRAFTING" && ds.status !== "SOLO_PICK")) {
      return { success: false, error: "Draft not in drafting state", status: 400 };
    }
    if (ds.currentTurn !== "USER") {
      return { success: false, error: "Not user turn", status: 403 };
    }
    if (typeof playerId !== "string") {
      return { success: false, error: "playerId is required", status: 400 };
    }
    if (targetIndex !== undefined && targetIndex !== null && !isValidSlot(targetIndex)) {
      return { success: false, error: "targetIndex must be an integer 0-10", status: 400 };
    }

    const pick = this.executePick(playerId, "USER", isValidSlot(targetIndex) ? targetIndex : undefined);
    if (!pick.success) {
      return { success: false, error: pick.error || "Illegal pick", status: 400 };
    }

    // Trigger AI pick if AI still needs players; otherwise hand the turn back
    if (ds.aiPicks.filter(Boolean).length < 11) {
      this.executeAiPick();
    } else {
      ds.currentTurn = "USER";
    }

    if (ds.userPicks.filter(Boolean).length >= 11 && ds.aiPicks.filter(Boolean).length >= 11) {
      ds.status = "READY_TO_PLAY";
      ds.currentTurn = "USER";
    }
    return { success: true };
  }

  /**
   * Runs the match once per squad configuration. Repeat calls return the stored result,
   * and the room's fixed seed means re-submitting identical squads cannot re-roll it.
   */
  private async startMatch(): Promise<{ success: true } | { success: false; error: string; status: number }> {
    const ds = this.draftState;
    if (!ds) {
      return { success: false, error: "Draft room not initialized", status: 400 };
    }
    if (ds.status === "COMPLETED" && ds.results) {
      return { success: true };
    }

    const userFilled = ds.userPicks.filter(Boolean).length;
    const aiFilled = ds.aiPicks.filter(Boolean).length;
    if (userFilled < 11 || aiFilled < 11) {
      return {
        success: false,
        error: "Both squads must be completely filled (11 players each) before starting match simulation",
        status: 400,
      };
    }

    await this.finishDraft();
    return { success: true };
  }

  private async persistAndBroadcast() {
    await this.state.storage.put("draftState", this.draftState);
    this.broadcast({ type: "UPDATE", state: this.draftState });
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
      let data: any;
      try {
        data = JSON.parse(msg.data as string);
      } catch {
        return; // ignore malformed socket payload
      }

      if (data?.type === "PICK") {
        const result = this.applyUserPick(data.playerId, data.targetIndex);
        if (!result.success) {
          ws.send(JSON.stringify({ type: "ERROR", error: result.error }));
          return;
        }
        await this.persistAndBroadcast();
      } else if (data?.type === "START_MATCH") {
        const result = await this.startMatch();
        if (!result.success) {
          ws.send(JSON.stringify({ type: "ERROR", error: result.error }));
        }
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

    const check = canPickPlayer(candidate, squad, this.draftState.challenge, slotIdx, this.poolContext(squad));
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
  /** Pool + opponent squad, so legality checks can protect the shared pool. */
  private poolContext(squad: (PlayerWithStats | null)[]): PickContext {
    const state = this.draftState!;
    const opponentSquad = squad === state.aiPicks ? state.userPicks : state.aiPicks;
    return { pool: state.pool, opponentSquad };
  }

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

    // Analyze User's Latest Draft Action for Counter-Sniping
    const userNonNull = this.draftState.userPicks.filter((p): p is PlayerWithStats => p !== null);
    const lastUserPick = userNonNull.length > 0 ? userNonNull[userNonNull.length - 1] : null;
    const userHasKeeper = userNonNull.some((p) => p.primary_role === "WK");
    const userBowlersCount = userNonNull.filter((p) => p.primary_role === "BOWL" || p.primary_role === "AR").length;

    // Evaluate every legal (candidate, slot) combination
    interface ScoredPair {
      player: PlayerWithStats;
      slotIndex: number;
      score: number;
      reason: string;
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
        const legalCheck = canPickPlayer(p, squad, challenge, slotIdx); // cheap screen; pool reserve is checked on the chosen pair
        if (!legalCheck.allowed) continue;

        let slotFit = 0;

        if (slotIdx === 0 || slotIdx === 1) {
          // OPENERS
          const isTrueOpener =
            p.stats.top_order_innings >= 8 ||
            (p.stats.bat_innings >= 5 && p.stats.top_order_innings / Math.max(1, p.stats.bat_innings) >= 0.35);

          const isMiddleAnchorOrFinisher =
            p.stats.finisher_innings >= 4 ||
            (p.stats.middle_order_innings >= 12 && p.stats.top_order_innings < 6);

          if (isBowl) {
            slotFit -= 1500;
          } else if (isMiddleAnchorOrFinisher) {
            // Middle-order anchors & legendary finishers (e.g. Dhoni, Miller, DK, Boucher) MUST NEVER OPEN
            slotFit -= 1200;
          } else if (isTrueOpener && (isBat || isWK)) {
            slotFit += 80;
          } else if (isBat && p.stats.top_order_innings >= 3) {
            slotFit += 30;
          } else {
            slotFit -= 600; // Finishers/tailenders penalized
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
            else if (isWK) slotFit += 60;
            else if (isBat && p.stats.bat_average >= 32.0) slotFit += 45;
            else slotFit -= 150;
          } else {
            // In T20 / ODI: Explosive Finishers
            if (p.stats.finisher_innings >= 5 || p.name.includes("Dhoni") || p.name.includes("Miller")) {
              slotFit += 160; // Huge boost for legendary finishers in Slots #6 and #7!
            } else if (isAR) {
              slotFit += 60;
            } else if (p.stats.bat_strike_rate >= (isT20 ? 140 : 100)) {
              slotFit += 50;
            } else if (isWK) {
              slotFit += 45;
            } else if (isBat) {
              slotFit += 25;
            } else {
              slotFit -= 200;
            }
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
        const isTrueOpenerCandidate =
          p.stats.top_order_innings >= 8 ||
          (p.stats.bat_innings >= 5 && p.stats.top_order_innings / Math.max(1, p.stats.bat_innings) >= 0.35);

        if (openerCount < 2 && (slotIdx === 0 || slotIdx === 1) && isTrueOpenerCandidate) {
          urgency += emptyIndices.length <= 4 ? 120 : 50;
        }

        // Strategic Counter-Sniping & Rival Anticipation
        let counterSnipeBonus = 0;
        let snipeReason = "";

        if (lastUserPick) {
          // 1. Nationality Synergy Sniping (e.g., if User took Kohli, AI snipes Rohit / Dhoni / Tendulkar / Bumrah)
          if (p.country === lastUserPick.country && p.country === "IND") {
            const isMarquee = p.name.includes("Rohit") || p.name.includes("Dhoni") || p.name.includes("Tendulkar") || p.name.includes("Bumrah") || p.name.includes("Kohli");
            if (isMarquee) {
              counterSnipeBonus += 140;
              snipeReason = `AI anticipated your next move and snatched ${p.name} before you could pair them with ${lastUserPick.name}!`;
            } else {
              counterSnipeBonus += 50;
              snipeReason = `AI counter-drafted ${p.name} to restrict your Indian combinations!`;
            }
          } else if (p.country === lastUserPick.country && p.country === "AUS") {
            const isMarquee = p.name.includes("Warner") || p.name.includes("Smith") || p.name.includes("Starc") || p.name.includes("Maxwell") || p.name.includes("Cummins");
            if (isMarquee) {
              counterSnipeBonus += 130;
              snipeReason = `AI intercepted ${p.name} to deny you an Australian powerhouse pairing with ${lastUserPick.name}!`;
            }
          } else if (p.country === lastUserPick.country && p.country === "ENG") {
            const isMarquee = p.name.includes("Root") || p.name.includes("Stokes") || p.name.includes("Buttler") || p.name.includes("Anderson");
            if (isMarquee) {
              counterSnipeBonus += 130;
              snipeReason = `AI struck back by seizing ${p.name} before you could expand your English core!`;
            }
          } else if (p.country === lastUserPick.country && p.country === "RSA") {
            const isMarquee = p.name.includes("Villiers") || p.name.includes("Kallis") || p.name.includes("Steyn") || p.name.includes("Rabada");
            if (isMarquee) {
              counterSnipeBonus += 130;
              snipeReason = `AI poached ${p.name} to deny you South Africa's premier match-winner!`;
            }
          }

          // 2. Role Rivalry Counter: User took top anchor/batter -> AI snipes strike bowler
          if ((lastUserPick.primary_role === "BAT" || lastUserPick.primary_role === "WK") && (isBowl && (p.stats.bowl_wickets >= 30 || p.stats.bowl_economy <= 5.2))) {
            counterSnipeBonus += 90;
            if (!snipeReason) snipeReason = `AI counter-drafted strike weapon ${p.name} to neutralize ${lastUserPick.name}!`;
          }

          // 3. Wicketkeeper Starvation
          if (!userHasKeeper && isWK && (p.name.includes("Dhoni") || p.name.includes("Gilchrist") || p.name.includes("Sangakkara") || p.name.includes("Buttler") || p.name.includes("Pant"))) {
            counterSnipeBonus += 125;
            snipeReason = `AI sniped premier wicketkeeper ${p.name}, applying massive squad pressure!`;
          }

          // 4. Bowling Starvation
          if (userBowlersCount < 3 && userNonNull.length >= 6 && isBowl) {
            counterSnipeBonus += 80;
            if (!snipeReason) snipeReason = `AI secured ${p.name} to starve your remaining bowling slots!`;
          }
        } else {
          // Round 1 Marquee Star Sniping
          const isMarqueeIcon = p.name.includes("Kohli") || p.name.includes("Rohit") || p.name.includes("Dhoni") || p.name.includes("Bumrah") || p.name.includes("Kallis") || p.name.includes("Smith") || p.name.includes("Root") || p.name.includes("Villiers") || p.name.includes("Malinga") || p.name.includes("Warne");
          if (isMarqueeIcon) {
            counterSnipeBonus += 150;
            snipeReason = `AI opened the draft aggressively by locking down generational superstar ${p.name}!`;
          }
        }

        const totalScore = quality + pitchBonus + slotFit + urgency + counterSnipeBonus;
        candidatePairs.push({
          player: p,
          slotIndex: slotIdx,
          score: totalScore,
          reason: snipeReason || `AI strategically secured ${p.name} for Slot #${slotIdx + 1}.`,
        });
      }
    }

    // Best-scoring pair that also keeps the shared pool completable for both squads
    candidatePairs.sort((a, b) => b.score - a.score);
    const poolCtx = this.poolContext(squad);
    const best = candidatePairs.find(
      (c) => canPickPlayer(c.player, squad, challenge, c.slotIndex, poolCtx).allowed
    );

    if (!best) {
      // Fallback: pick first legal player into first empty slot
      const fallbackSlot = emptyIndices[0];
      const legal = this.draftState.pool.filter(
        (p) => canPickPlayer(p, squad, challenge, fallbackSlot, this.poolContext(squad)).allowed
      );
      const chosen = legal.length > 0 ? legal[0] : this.draftState.pool[0];
      const pIdx = this.draftState.pool.findIndex((p) => p.id === chosen.id);
      if (pIdx !== -1) {
        const [picked] = this.draftState.pool.splice(pIdx, 1);
        squad[fallbackSlot] = picked;
        this.draftState.lastAiSnipe = {
          player: picked,
          slotIndex: fallbackSlot,
          reason: `AI picked ${picked.name} into Slot #${fallbackSlot + 1}.`,
        };
        this.draftState.currentTurn = "USER";
        this.draftState.round += 1;
        this.draftState.lastActionTimestamp = Date.now();
      }
      return;
    }

    const pIdx = this.draftState.pool.findIndex((p) => p.id === best.player.id);
    if (pIdx !== -1) {
      const [picked] = this.draftState.pool.splice(pIdx, 1);
      squad[best.slotIndex] = picked;
      this.draftState.lastAiSnipe = {
        player: picked,
        slotIndex: best.slotIndex,
        reason: best.reason,
      };
      this.draftState.currentTurn = "USER";
      this.draftState.round += 1;
      this.draftState.lastActionTimestamp = Date.now();
    }
  }

  private async finishDraft() {
    if (!this.draftState) return;

    this.draftState.status = "COMPLETED";
    // Rooms created before seeds existed get one now, persisted below
    this.draftState.matchSeed = this.draftState.matchSeed ?? generateSeed();

    // 1. Run realistic ball-by-ball match simulation (fixed per-room seed: no re-rolls)
    const simulation = simulateCricketMatch(
      this.draftState.userPicks,
      this.draftState.aiPicks,
      this.draftState.challenge,
      this.draftState.matchSeed
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
      apiKey,
      this.env?.GEMINI_MODEL
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
