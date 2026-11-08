import type { AiSnipeInfo, DraftState, MatchFormat, PlayerWithStats } from "../core/types";
import { snakeOrder } from "../core/types";
import { canPickPlayer, type PickContext } from "../core/validator";
import { generateRefereeReport } from "../core/gemini-referee";
import { simulateCricketMatch } from "../core/simulator";
import { buildMatchReview } from "../core/match-review";
import { chooseAiPick } from "../core/ai-draft";
import { arrangeSquad } from "../core/batting-order";
import { buildRandomDraft, saveChallenge } from "../worker/challenge-generator";

/** Rooms delete themselves this long after they were created, so storage never fills up (5 GB on the Free plan). */
export const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

const TOTAL_PICKS = 22;
type Result = { success: true } | { success: false; error: string; status: number };

/**
 * One head-to-head draft. Rules of the room:
 * - A toss decides who picks first; picks then follow a snake order (1-2-2-...-2-1).
 * - Picks are final. Players go into a natural batting order automatically.
 * - Once both XIs are full the user can set their batting order, then play the match once.
 */
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
      if (this.draftState) this.normalize(this.draftState);
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Internal: build a fresh draft (pool + scenario) here, where the CPU budget is 30 s, then start it
    if (url.pathname.endsWith("/create") && request.method === "POST") {
      if (this.draftState) return Response.json({ error: "Draft room already initialized" }, { status: 409 });
      const body = await readJson<{ roomId?: string; format?: MatchFormat; difficulty?: DraftState["difficulty"]; theme?: string }>(request);
      if (!body?.roomId || !this.env?.DB) return Response.json({ error: "Invalid create payload" }, { status: 400 });
      const format: MatchFormat = body.format === "ODI" || body.format === "TEST" ? body.format : "T20";
      const { challenge, pool, theme } = await buildRandomDraft(this.env.DB, format, Math.random, body.theme);
      // Keeping a record of the scenario is optional: never fail the draft over it
      await saveChallenge(this.env.DB, challenge).catch(() => {});
      return this.initialise({
        roomId: body.roomId,
        challenge,
        pool,
        userPicks: Array(11).fill(null),
        aiPicks: Array(11).fill(null),
        currentTurn: "USER",
        round: 1,
        maxRounds: 11,
        status: "DRAFTING",
        lastActionTimestamp: Date.now(),
        difficulty: body.difficulty ?? "normal",
        theme,
      });
    }

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      // A room can only be initialized once; the public proxy also blocks this path.
      if (this.draftState) return Response.json({ error: "Draft room already initialized" }, { status: 409 });
      const body = await readJson<DraftState>(request);
      if (!body || !body.challenge || !Array.isArray(body.pool)) {
        return Response.json({ error: "Invalid init payload" }, { status: 400 });
      }
      return this.initialise(body);
    }

    if (url.pathname.endsWith("/state") && request.method === "GET") {
      if (!this.draftState) return Response.json({ error: "Draft room not initialized" }, { status: 404 });
      return Response.json({ state: this.draftState });
    }

    if (url.pathname.endsWith("/pick") && request.method === "POST") {
      const body = await readJson<{ playerId?: unknown }>(request);
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      const result = this.applyUserPick(body.playerId);
      if (!result.success) return Response.json({ error: result.error }, { status: result.status });
      await this.persistAndBroadcast();
      return Response.json({ success: true, state: this.draftState, aiPicks: this.draftState!.lastAiPicks });
    }

    // "/referee" is kept as a legacy alias of "/start-match" with identical guards.
    if ((url.pathname.endsWith("/start-match") || url.pathname.endsWith("/referee")) && request.method === "POST") {
      const body = await readJson<{ newBall?: unknown; death?: unknown }>(request);
      const result = await this.startMatch(body ?? undefined);
      if (!result.success) return Response.json({ error: result.error }, { status: result.status });
      return Response.json({ success: true, results: this.draftState!.results, state: this.draftState });
    }

    if (url.pathname.endsWith("/remove") && request.method === "POST") {
      return Response.json({ error: "Picks are final: a drafted player can't be returned to the pool." }, { status: 409 });
    }

    if (url.pathname.endsWith("/reorder") && request.method === "POST") {
      const body = await readJson<{ fromIndex?: unknown; toIndex?: unknown }>(request);
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      const result = this.reorder(body.fromIndex, body.toIndex);
      if (!result.success) return Response.json({ error: result.error }, { status: result.status });
      await this.persistAndBroadcast();
      return Response.json({ success: true, state: this.draftState });
    }

    return new Response("Not found", { status: 404 });
  }

  /** Toss, snake order, the AI's first pick if it won the toss, and the room's self-deletion alarm. */
  private async initialise(body: DraftState): Promise<Response> {
    body.matchSeed = body.matchSeed ?? generateSeed();
    // The toss: whoever wins it picks first
    body.firstPick = body.firstPick ?? (generateSeed() % 2 === 0 ? "USER" : "AI");
    body.pickOrder = snakeOrder(body.firstPick);
    body.pickIndex = 0;
    body.pickLog = [];
    body.lastAiPicks = [];
    body.status = "DRAFTING";
    this.draftState = body;
    this.normalize(body);
    body.currentTurn = body.pickOrder[0];
    this.runAiTurns();
    await this.persistAndBroadcast("INIT");
    // One alarm per room (a single row written): clean up a week later
    await this.state.storage.setAlarm?.(Date.now() + ROOM_TTL_MS);
    return Response.json({ success: true, state: this.draftState });
  }

  /** The room's week is up: delete everything it stored. */
  async alarm() {
    await this.state.storage.deleteAll();
    this.draftState = null;
  }

  private format(): MatchFormat {
    return (this.draftState?.challenge.format || "T20") as MatchFormat;
  }

  /** Validates and applies a user pick, then lets the AI make its pick(s). Shared by HTTP and WebSocket. */
  private applyUserPick(playerId: unknown): Result {
    const ds = this.draftState;
    if (!ds || ds.status !== "DRAFTING") return { success: false, error: "The draft is over", status: 400 };
    if (ds.currentTurn !== "USER") return { success: false, error: "Not your pick yet", status: 403 };
    if (typeof playerId !== "string") return { success: false, error: "playerId is required", status: 400 };
    if (ds.userPicks.every(Boolean)) return { success: false, error: "Your XI is already full", status: 400 };

    const player = ds.pool.find((p) => p.id === playerId);
    if (!player) return { success: false, error: "That player has already been picked", status: 400 };

    const ctx: PickContext = { pool: ds.pool, opponentSquad: ds.aiPicks };
    const check = canPickPlayer(player, ds.userPicks, ds.challenge, undefined, ctx);
    // Safety valve: if no pool player is legal for the user, any player may be taken so the draft can't stall
    if (!check.allowed && !this.noLegalPick(ds.userPicks, ctx)) {
      return { success: false, error: check.reason || "That pick isn't allowed", status: 400 };
    }

    ds.lastAiPicks = [];
    this.place("USER", player);
    this.runAiTurns();
    return { success: true };
  }

  /** Moves a drafted player to the next pick's squad, logs it, and advances the snake order. */
  private place(by: "USER" | "AI", player: PlayerWithStats, aiSlot?: number) {
    const ds = this.draftState!;
    ds.pool = ds.pool.filter((p) => p.id !== player.id);
    const key = by === "USER" ? "userPicks" : "aiPicks";
    const squad = ds[key].slice();
    if (by === "AI" && isValidSlot(aiSlot) && !squad[aiSlot]) squad[aiSlot] = player;
    else squad[squad.indexOf(null)] = player;
    ds[key] = arrangeSquad(squad, this.format());
    ds.pickIndex = (ds.pickIndex ?? 0) + 1;
    ds.pickLog = [...(ds.pickLog ?? []), { n: ds.pickIndex, by, playerId: player.id, name: player.name, country: player.country, role: player.primary_role }];
    ds.round = Math.floor((ds.pickIndex) / 2) + 1;
    ds.lastActionTimestamp = Date.now();
    this.advance();
  }

  private advance() {
    const ds = this.draftState!;
    const order = ds.pickOrder ?? snakeOrder("USER");
    const full = (sq: (PlayerWithStats | null)[]) => sq.every(Boolean);
    if ((ds.pickIndex ?? 0) >= TOTAL_PICKS || (full(ds.userPicks) && full(ds.aiPicks)) || ds.pool.length === 0) {
      ds.status = "READY_TO_PLAY";
      ds.currentTurn = "USER";
      return;
    }
    let next = order[ds.pickIndex ?? 0] ?? "USER";
    // A side whose XI is already full passes its turn
    if (next === "USER" && full(ds.userPicks)) next = "AI";
    if (next === "AI" && full(ds.aiPicks)) next = "USER";
    ds.currentTurn = next;
  }

  /** The AI makes every pick it is due (two in a row in a snake draft) until it is the user's turn. */
  private runAiTurns() {
    const ds = this.draftState!;
    let guard = 0;
    while (ds.status === "DRAFTING" && ds.currentTurn === "AI" && guard++ < TOTAL_PICKS) {
      const result = chooseAiPick({
        pool: ds.pool,
        squad: ds.aiPicks,
        opponentSquad: ds.userPicks,
        challenge: ds.challenge,
        difficulty: ds.difficulty ?? "normal",
        noiseSeed: roomSeed(ds.roomId),
        round: ds.pickIndex ?? 0,
      });
      if (!result || !ds.pool.some((p) => p.id === result.player.id)) {
        // Nothing the AI can take: hand the turn over rather than stall
        ds.currentTurn = "USER";
        break;
      }
      this.place("AI", result.player, result.slotIndex);
      const info: AiSnipeInfo = {
        player: result.player,
        slotIndex: ds.aiPicks.findIndex((p) => p?.id === result.player.id),
        reason: result.reason,
        pickNumber: ds.pickIndex,
      };
      ds.lastAiPicks = [...(ds.lastAiPicks ?? []), info];
      ds.lastAiSnipe = info;
    }
  }

  private noLegalPick(squad: (PlayerWithStats | null)[], ctx: PickContext): boolean {
    const ds = this.draftState!;
    return !ds.pool.some((p) => canPickPlayer(p, squad, ds.challenge, undefined, ctx).allowed);
  }

  /** The batting order is the user's to set once both XIs are complete, until the match is played. */
  private reorder(fromIndex: unknown, toIndex: unknown): Result {
    const ds = this.draftState;
    if (!ds) return { success: false, error: "Draft room not initialized", status: 400 };
    if (!isValidSlot(fromIndex) || !isValidSlot(toIndex)) return { success: false, error: "Invalid slot indices (must be integers 0-10)", status: 400 };
    if (ds.status === "DRAFTING") return { success: false, error: "Set your batting order once the draft is over", status: 409 };
    if (ds.status === "COMPLETED") return { success: false, error: "The match has been played", status: 409 };
    const order = ds.userPicks.slice();
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);
    ds.userPicks = order;
    ds.lastActionTimestamp = Date.now();
    return { success: true };
  }

  /**
   * Runs the match once. Repeat calls return the stored result, and the room's fixed seed means
   * the result can't be re-rolled.
   */
  private async startMatch(planInput?: { newBall?: unknown; death?: unknown }): Promise<Result> {
    const ds = this.draftState;
    if (!ds) return { success: false, error: "Draft room not initialized", status: 400 };
    if (ds.status === "COMPLETED" && ds.results) return { success: true };
    if (ds.userPicks.filter(Boolean).length < 11 || ds.aiPicks.filter(Boolean).length < 11) {
      return { success: false, error: "Both XIs must be complete (11 players each) before the match", status: 400 };
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

  private async persistAndBroadcast(type: "UPDATE" | "INIT" = "UPDATE") {
    const ds = this.draftState;
    if (ds) ds.userStuck = ds.status === "DRAFTING" && ds.currentTurn === "USER" && this.noLegalPick(ds.userPicks, { pool: ds.pool, opponentSquad: ds.aiPicks });
    await this.state.storage.put("draftState", this.draftState);
    this.broadcast({ type, state: this.draftState });
  }

  /** Fills in fields for rooms saved before toss/snake order existed. */
  private normalize(state: DraftState) {
    const fix = (sq: (PlayerWithStats | null)[] | undefined) => {
      const players = (sq || []).filter((p): p is PlayerWithStats => !!p);
      const out: (PlayerWithStats | null)[] = Array(11).fill(null);
      if (Array.isArray(sq) && sq.length === 11) return sq;
      players.slice(0, 11).forEach((p, i) => (out[i] = p));
      return out;
    };
    state.userPicks = fix(state.userPicks);
    state.aiPicks = fix(state.aiPicks);
    if (!state.pickOrder) {
      state.firstPick = state.firstPick ?? "USER";
      state.pickOrder = snakeOrder(state.firstPick);
    }
    if (state.pickIndex === undefined) state.pickIndex = state.userPicks.filter(Boolean).length + state.aiPicks.filter(Boolean).length;
    state.pickLog = state.pickLog ?? [];
    state.lastAiPicks = state.lastAiPicks ?? [];
  }

  private handleWebSocket(ws: WebSocket) {
    ws.accept();
    this.sockets.add(ws);
    if (this.draftState) ws.send(JSON.stringify({ type: "SYNC", state: this.draftState }));
    ws.addEventListener("close", () => this.sockets.delete(ws));
    ws.addEventListener("message", async (msg) => {
      let data: any;
      try {
        data = JSON.parse(msg.data as string);
      } catch {
        return; // ignore malformed socket payload
      }
      if (data?.type === "PICK") {
        const result = this.applyUserPick(data.playerId);
        if (!result.success) {
          ws.send(JSON.stringify({ type: "ERROR", error: result.error }));
          return;
        }
        await this.persistAndBroadcast();
      } else if (data?.type === "START_MATCH") {
        const result = await this.startMatch();
        if (!result.success) ws.send(JSON.stringify({ type: "ERROR", error: result.error }));
      }
    });
  }

  private broadcast(message: any) {
    const raw = JSON.stringify(message);
    for (const ws of this.sockets) {
      try {
        ws.send(raw);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  private async finishDraft() {
    const ds = this.draftState;
    if (!ds) return;
    ds.status = "COMPLETED";
    // Rooms created before seeds existed get one now, persisted below
    ds.matchSeed = ds.matchSeed ?? generateSeed();

    // 1. Ball-by-ball match simulation (fixed per-room seed: no re-rolls)
    const simulation = simulateCricketMatch(ds.userPicks, ds.aiPicks, ds.challenge, ds.matchSeed, { userPlan: ds.bowlingPlan });
    ds.simulation = simulation;

    // 2. Optional Gemini referee report (commentary only; null when unavailable)
    const refereeReport = await generateRefereeReport(ds.userPicks, ds.aiPicks, ds.challenge, simulation, this.env?.GEMINI_API_KEY, this.env?.GEMINI_MODEL);

    // 3. The argument after the game: head-to-head, draft awards, and how often this XI wins
    const seed = ds.matchSeed;
    const plan = ds.bowlingPlan;
    const review = buildMatchReview({
      userSquad: ds.userPicks,
      aiSquad: ds.aiPicks,
      challenge: ds.challenge,
      simulation,
      pickLog: ds.pickLog,
      seed,
      replay: (s) => simulateCricketMatch(ds.userPicks, ds.aiPicks, ds.challenge, s, { userPlan: plan }),
    });

    const completedResults = {
      winner: simulation.winner,
      decisiveDifference: simulation.decisiveDifference,
      whyWinnerWon: simulation.whyWinnerWon,
      whyLoserLost: simulation.whyLoserLost,
      groundConditionsAnalysis: simulation.groundConditionsAnalysis,
      verdictSummary: simulation.summary,
      refereeReport,
      review,
      simulation,
    };
    ds.results = completedResults;

    await this.state.storage.put("draftState", ds);
    this.broadcast({ type: "COMPLETED", results: completedResults });
  }
}
