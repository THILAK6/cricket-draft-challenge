import type { Challenge, DraftState, PlayerWithStats, ScoringBreakdown } from "../core/types";
import { validateSquad, canPickPlayer, type PickContext } from "../core/validator";
import { calculateDeterministicScore, applyBoundedAdjustment } from "../core/scoring";
import { generateRefereeReport } from "../core/gemini-referee";
import { simulateCricketMatch } from "../core/simulator";
import { playerQuality } from "../core/player-quality";

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

  /** Scan for a legal move so the UI can tell a stuck user to free a slot. Only runs near the end (cheap). */
  private computeUserStuck(): boolean {
    const st = this.draftState;
    if (!st || st.status === "COMPLETED" || st.status === "READY_TO_PLAY") return false;
    const empties = st.userPicks.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
    if (empties.length === 0 || empties.length > 5) return false;
    const ctx = this.poolContext(st.userPicks);
    for (const slot of empties) {
      for (const p of st.pool) {
        if (canPickPlayer(p, st.userPicks, st.challenge, slot, ctx).allowed) return false;
      }
    }
    return true;
  }

  private async persistAndBroadcast() {
    if (this.draftState) this.draftState.userStuck = this.computeUserStuck();
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
   * pair in the pool. It takes the strongest players on the board (judged by career stats only) early,
   * matches them to their optimal slot, and counters pitch conditions ruthlessly.
   */
  /** Pool + opponent squad, so legality checks can protect the shared pool. */
  private poolContext(squad: (PlayerWithStats | null)[]): PickContext {
    const state = this.draftState!;
    const opponentSquad = squad === state.aiPicks ? state.userPicks : state.aiPicks;
    return { pool: state.pool, opponentSquad };
  }

  /** Format-specific base quality from career stats only (no names, no reputation). */
  private playerQuality(p: PlayerWithStats, format: string): number {
    return playerQuality(p, format);
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

    // Stats-only quality for every available player. "Stars" are simply the top tier of what is
    // left in the pool, so the AI recognises elite players from their numbers, not their names.
    const qualityMap = new Map<string, number>();
    for (const q of this.draftState.pool) qualityMap.set(q.id, this.playerQuality(q, format));
    const percentile = (values: number[], pct: number) => {
      if (values.length === 0) return Infinity;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(pct * sorted.length))];
    };
    const difficulty = this.draftState.difficulty ?? "normal";
    // Easy mode blurs the AI's read of the board with deterministic per-pick noise (no extra randomness source).
    if (difficulty === "easy") {
      const spread = Math.max(...qualityMap.values()) - Math.min(...qualityMap.values());
      let h = this.draftState.round * 2654435761;
      for (const [id, q] of qualityMap) {
        h = Math.imul(h ^ id.split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7), 2246822519) >>> 0;
        qualityMap.set(id, q + ((h % 1000) / 1000 - 0.5) * spread * 1.6);
      }
    }
    const starCut = percentile([...qualityMap.values()], 0.85);
    const keeperStarCut = percentile(
      this.draftState.pool.filter((q) => q.primary_role === "WK").map((q) => qualityMap.get(q.id) ?? 0),
      0.5
    );

    for (const p of this.draftState.pool) {
      const isPacer = p.bowling_category === "PACE";
      const isSpinner = p.bowling_category === "SPIN";
      const isWK = p.primary_role === "WK";
      const isAR = p.primary_role === "AR";
      const isBat = p.primary_role === "BAT";
      const isBowl = p.primary_role === "BOWL";
      const matches = Math.max(1, p.stats.matches);

      // Pitch preference (soft): a second spinner on a flat or green track is unattractive, not illegal
      const spinnerPenalty = disallowMoreSpinners && isSpinner ? -80 : 0;

      const quality = qualityMap.get(p.id) ?? 0;

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
            // Middle-order anchors and finishers (judged by innings played in those roles) must not open
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
            // In Tests: all-rounders or a solid keeper-batter
            if (isAR) slotFit += 65;
            else if (isWK) slotFit += 60;
            else if (isBat && p.stats.bat_average >= 32.0) slotFit += 45;
            else slotFit -= 150;
          } else {
            // In T20 / ODI: Explosive Finishers
            if (p.stats.finisher_innings >= 5) {
              slotFit += 160; // Proven finishers (by innings played in that role) belong in Slots #6 and #7
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

        const isStar = quality >= starCut;
        const starTag = isStar ? "star " : "";
        if (lastUserPick) {
          // 1. Core denial: same country as the user's latest pick (stronger for true stars)
          if (p.country === lastUserPick.country) {
            counterSnipeBonus += isStar ? 110 : 40;
            snipeReason = isStar
              ? `AI took ${starTag}${p.name} so you can't build a ${p.country} core around ${lastUserPick.name}!`
              : `AI picked ${p.name} to limit your ${p.country} combinations.`;
          }

          // 2. Role rivalry: user took a batter/keeper -> AI takes a genuine strike bowler
          if (
            (lastUserPick.primary_role === "BAT" || lastUserPick.primary_role === "WK") &&
            isBowl &&
            (p.stats.bowl_wickets >= 30 || (p.stats.bowl_economy > 0 && p.stats.bowl_economy <= 5.2))
          ) {
            counterSnipeBonus += 90;
            if (!snipeReason) snipeReason = `AI took strike bowler ${p.name} to answer ${lastUserPick.name}.`;
          }

          // 3. Keeper starvation: user has no keeper yet, AI takes a top-half keeper
          if (!userHasKeeper && isWK && quality >= keeperStarCut) {
            counterSnipeBonus += 100;
            snipeReason = `AI took top wicketkeeper ${p.name} while you still need a keeper!`;
          }

          // 4. Bowling starvation: user is short of bowlers
          if (userBowlersCount < 3 && userNonNull.length >= 6 && isBowl) {
            counterSnipeBonus += 70;
            if (!snipeReason) snipeReason = `AI took ${p.name} while you are still short of bowlers.`;
          }
        } else if (isStar) {
          // Opening move: grab the best available player by the numbers
          counterSnipeBonus += 100;
          snipeReason = `AI opened by taking ${starTag}${p.name}, the strongest player on the board.`;
        }

        // Hard: pure best-value drafting. Counter-sniping spends picks on denial, which costs team quality.
        if (difficulty === "hard") counterSnipeBonus = 0;
        const totalScore = quality + pitchBonus + slotFit + urgency + counterSnipeBonus + spinnerPenalty;
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

    // 3. Optional Gemini referee report (commentary only; null when unavailable)
    const refereeReport = await generateRefereeReport(
      this.draftState.userPicks,
      this.draftState.aiPicks,
      this.draftState.challenge,
      simulation,
      this.env?.GEMINI_API_KEY,
      this.env?.GEMINI_MODEL
    );

    // The simulated match is the single source of truth for the outcome. The 0-100 numbers are
    // squad ratings (team balance), shown for context and never used to pick a winner.
    const completedResults = {
      winner: simulation.winner,
      decisiveDifference: simulation.decisiveDifference,
      whyWinnerWon: simulation.whyWinnerWon,
      whyLoserLost: simulation.whyLoserLost,
      groundConditionsAnalysis: simulation.groundConditionsAnalysis,
      verdictSummary: simulation.summary,
      refereeReport,
      userRating: userBreakdown.deterministic_total,
      aiRating: aiBreakdown.deterministic_total,
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
