import type { Challenge, DraftState, PlayerWithStats, ScoringBreakdown } from "../core/types";
import { validateSquad, canPickPlayer, type PickContext } from "../core/validator";
import { calculateDeterministicScore, applyBoundedAdjustment } from "../core/scoring";
import { generateRefereeReport } from "../core/gemini-referee";
import { simulateCricketMatch } from "../core/simulator";
import { chooseAiPick } from "../core/ai-draft";

/** Stable per-room number: Easy's misjudgements differ from match to match but replay identically. */
function roomSeed(roomId: string): number {
  let h = 5381;
  for (let i = 0; i < roomId.length; i++) h = (Math.imul(h, 33) + roomId.charCodeAt(i)) | 0;
  return h >>> 0;
}

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
      const body = await readJson<{ newBall?: unknown; death?: unknown }>(request);
      const result = await this.startMatch(body ?? undefined);
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
  private async startMatch(planInput?: { newBall?: unknown; death?: unknown }): Promise<{ success: true } | { success: false; error: string; status: number }> {
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

    // Keep only plan entries that are real bowlers in the user's XI (keepers never bowl)
    const bowlerIds = new Set(ds.userPicks.filter((p): p is PlayerWithStats => !!p && p.primary_role !== "WK").map((p) => p.id));
    const newBall = Array.isArray(planInput?.newBall)
      ? [...new Set((planInput!.newBall as unknown[]).filter((id): id is string => typeof id === "string" && bowlerIds.has(id)))].slice(0, 2)
      : [];
    const death = typeof planInput?.death === "string" && bowlerIds.has(planInput.death) ? planInput.death : undefined;
    ds.bowlingPlan = newBall.length || death ? { newBall, death } : undefined;

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

  /** The AI's reply to the user's pick: see core/ai-draft.ts for how it chooses. */
  private executeAiPick() {
    const ds = this.draftState;
    if (!ds || ds.pool.length === 0) return;
    const result = chooseAiPick({
      pool: ds.pool,
      squad: ds.aiPicks,
      opponentSquad: ds.userPicks,
      challenge: ds.challenge,
      difficulty: ds.difficulty ?? "normal",
      noiseSeed: roomSeed(ds.roomId),
      round: ds.round,
    });
    if (!result) return;
    const pIdx = ds.pool.findIndex((p) => p.id === result.player.id);
    if (pIdx === -1) return;
    const [picked] = ds.pool.splice(pIdx, 1);
    ds.aiPicks[result.slotIndex] = picked;
    ds.lastAiSnipe = { player: picked, slotIndex: result.slotIndex, reason: result.reason };
    ds.currentTurn = "USER";
    ds.round += 1;
    ds.lastActionTimestamp = Date.now();
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
      this.draftState.matchSeed,
      { userPlan: this.draftState.bowlingPlan }
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
