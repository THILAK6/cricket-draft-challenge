import type { AiSnipeInfo, DraftState, MatchFormat, PlayerWithStats } from "../core/types";
import { snakeOrder } from "../core/types";
import { canPickPlayer, type PickContext } from "../core/validator";
import { generateRefereeReport } from "../core/gemini-referee";
import { simulateCricketMatch } from "../core/simulator";
import { buildMatchReview } from "../core/match-review";
import { chooseAiPick } from "../core/ai-draft";
import { affordable, AUCTION, aiBids, bidOn, fairPrice, lotOrder, MIN_PRICE, nextBid, passOn, startLot } from "../core/auction";
import { playerQuality } from "../core/player-quality";
import { askVoice, type VoiceUsage } from "../core/ai-voice";
import { arrangeSquad } from "../core/batting-order";
import { buildRandomDraft, saveChallenge } from "../worker/challenge-generator";
import { buildSnapshot, isDeviceId, newMatchId, saveMatch } from "../worker/match-store";

/** Rooms delete themselves this long after they were created, so storage never fills up (5 GB on the Free plan). */
export const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A small seeded random number generator. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

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
      const body = await readJson<{ roomId?: string; format?: MatchFormat; league?: string; difficulty?: DraftState["difficulty"]; theme?: string; deviceId?: string; draftMode?: string; auctionStyle?: string }>(request);
      if (!body?.roomId || !this.env?.DB) return Response.json({ error: "Invalid create payload" }, { status: 400 });
      const league = body.league === "IPL" ? "IPL" : undefined;
      const format: MatchFormat = league ? "T20" : body.format === "ODI" || body.format === "TEST" ? body.format : "T20";
      const { challenge, pool, theme } = await buildRandomDraft(this.env.DB, format, Math.random, body.theme, league);
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
        deviceId: isDeviceId(body.deviceId) ? body.deviceId : undefined,
        // The auction is an IPL option
        ...(league === "IPL" && body.draftMode === "auction"
          ? { draftMode: "auction" as const, auction: { purse: { USER: AUCTION.purse, AI: AUCTION.purse }, queue: [], log: [], style: body.auctionStyle === "impulsive" ? ("impulsive" as const) : ("calculated" as const) } }
          : {}),
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
      const result = await this.applyUserPick(body.playerId);
      if (!result.success) return Response.json({ error: result.error }, { status: result.status });
      await this.persistAndBroadcast();
      return Response.json({ success: true, state: this.draftState, aiPicks: this.draftState!.lastAiPicks });
    }

    if (url.pathname.endsWith("/bid") && request.method === "POST") {
      const body = await readJson<{ action?: unknown }>(request);
      if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      const result = await this.applyBid(body.action);
      if (!result.success) return Response.json({ error: result.error }, { status: result.status });
      await this.persistAndBroadcast();
      return Response.json({ success: true, state: this.draftState });
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
    if (body.draftMode === "auction" && body.auction) {
      // The auction: lots in order (marquee, then sets), and the first lot goes up
      body.firstPick = "USER";
      body.currentTurn = "USER";
      const rand = lcg(roomSeed(body.roomId));
      body.auction.queue = lotOrder(body.pool, (p) => playerQuality(p, this.format()), rand);
      await this.runAuction();
      await this.persistAndBroadcast("INIT");
      await this.state.storage.setAlarm?.(Date.now() + ROOM_TTL_MS);
      return Response.json({ success: true, state: this.draftState });
    }
    body.currentTurn = body.pickOrder[0];
    await this.runAiTurns();
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

  // ---- The auction ---------------------------------------------------------------------------

  private slotsLeft(side: "USER" | "AI") {
    const ds = this.draftState!;
    return (side === "USER" ? ds.userPicks : ds.aiPicks).filter((p) => !p).length;
  }

  /** May this side take the player on the block? The squad rules, with the draft's safety valve when nobody legal is left. */
  private legalToHold(side: "USER" | "AI", player: PlayerWithStats): { ok: boolean; reason?: string } {
    const ds = this.draftState!;
    const squad = side === "USER" ? ds.userPicks : ds.aiPicks;
    const ctx: PickContext = { pool: ds.pool, opponentSquad: side === "USER" ? ds.aiPicks : ds.userPicks };
    const check = canPickPlayer(player, squad, ds.challenge, undefined, ctx);
    if (check.allowed || this.noLegalPick(squad, ctx)) return { ok: true };
    return { ok: false, reason: check.reason };
  }

  /** What the player is worth to the AI's XI in crore, from the same valuation its draft uses (0 when it may not take him). */
  private aiValuation(player: PlayerWithStats): number {
    const ds = this.draftState!;
    const priced = chooseAiPick({
      pool: ds.pool, squad: ds.aiPicks, opponentSquad: ds.userPicks, challenge: ds.challenge, difficulty: ds.difficulty ?? "normal",
      noiseSeed: roomSeed(ds.roomId), round: ds.auction!.log.length, candidates: [player],
    });
    if (!priced) return this.legalToHold("AI", player).ok ? fairPrice(playerQuality(player, this.format())) : 0;
    // A need can lift what he is worth, but only so far
    return fairPrice(Math.min(priced.total ?? 0, playerQuality(player, this.format()) + 25));
  }

  /** Can the user take part in this lot? (He still has a slot, can afford the next bid, and may legally hold the player.) */
  private userMayBid(): { ok: boolean; reason?: string } {
    const ds = this.draftState!;
    const a = ds.auction!;
    const lot = a.lot;
    const player = lot && ds.pool.find((p) => p.id === lot.playerId);
    if (!lot || !player) return { ok: false };
    const slots = this.slotsLeft("USER");
    if (slots === 0) return { ok: false, reason: "Your XI is full" };
    const price = nextBid(lot);
    const cap = affordable(a.purse.USER, slots);
    if (price > cap) return { ok: false, reason: cap < price ? `You can spend at most ${cap} crore here and still fill your XI` : undefined };
    return this.legalToHold("USER", player);
  }

  /** The sale goes into the squad like a pick: out of the pool, price off the purse, onto the log. */
  private placeSale(by: "USER" | "AI", player: PlayerWithStats, price: number) {
    const ds = this.draftState!;
    ds.pool = ds.pool.filter((p) => p.id !== player.id);
    const key = by === "USER" ? "userPicks" : "aiPicks";
    const squad = ds[key].slice();
    squad[squad.indexOf(null)] = player;
    ds[key] = by === "USER" && ds.userOrderManual ? squad : arrangeSquad(squad, this.format());
    ds.auction!.purse[by] = Math.round((ds.auction!.purse[by] - price) * 100) / 100;
    ds.pickIndex = (ds.pickIndex ?? 0) + 1;
    ds.pickLog = [...(ds.pickLog ?? []), { n: ds.pickIndex, by, playerId: player.id, name: player.name, country: player.country, role: player.primary_role, price }];
    ds.lastActionTimestamp = Date.now();
  }

  /** The next player comes up. False when the auction is over (both XIs full, or nobody left to sell). */
  private openNextLot(): boolean {
    const ds = this.draftState!;
    const a = ds.auction!;
    const full = this.slotsLeft("USER") === 0 && this.slotsLeft("AI") === 0;
    if (full || ds.pool.length === 0) return false;
    let next = a.queue.shift();
    // Planned lots done: whoever has not been sold goes back up at the minimum price, best first, until the XIs are full
    if (!next && !a.accelerated) {
      a.accelerated = true;
      const sold = new Set((ds.pickLog ?? []).map((e) => e.playerId));
      a.queue = [...ds.pool].filter((p) => !sold.has(p.id)).sort((x, y) => playerQuality(y, this.format()) - playerQuality(x, this.format())).map((p) => ({ id: p.id, set: "Accelerated" }));
      next = a.queue.shift();
    }
    if (!next) {
      // Nobody left to offer and an XI still short (rules the pool cannot meet): fill the slots with the best left, at the minimum
      this.fillRemaining();
      return false;
    }
    const player = ds.pool.find((p) => p.id === next!.id);
    if (!player) return this.openNextLot();
    a.lot = startLot(a, player, next.set, a.accelerated ? 0 : playerQuality(player, this.format()));
    return true;
  }

  private fillRemaining() {
    const ds = this.draftState!;
    for (const side of ["USER", "AI"] as const) {
      while (this.slotsLeft(side) > 0 && ds.pool.length > 0) {
        const best = [...ds.pool].sort((x, y) => playerQuality(y, this.format()) - playerQuality(x, this.format()))[0];
        this.placeSale(side, best, MIN_PRICE);
      }
    }
  }

  private closeLot(outcome: NonNullable<ReturnType<typeof passOn>["outcome"]>) {
    const ds = this.draftState!;
    const a = ds.auction!;
    const lot = a.lot!;
    const player = ds.pool.find((p) => p.id === lot.playerId)!;
    if ("sold" in outcome) {
      this.placeSale(outcome.sold.to, player, outcome.sold.price);
      a.log.push({ playerId: player.id, name: player.name, set: lot.set, price: outcome.sold.price, to: outcome.sold.to });
    } else {
      a.log.push({ playerId: player.id, name: player.name, set: lot.set, price: null, to: null });
    }
    a.lot = undefined;
  }

  /**
   * Plays the auction forward until the user has something to decide: the AI bids or passes in its
   * turn, a side that cannot take the player passes for itself, lots close and the next goes up.
   * Ends the draft when both XIs are full.
   */
  private async runAuction() {
    const ds = this.draftState!;
    const a = ds.auction!;
    ds.lastAiPicks = [];
    for (let guard = 0; ds.status === "DRAFTING" && guard < 600; guard++) {
      if (!a.lot && !this.openNextLot()) {
        ds.status = "READY_TO_PLAY";
        ds.currentTurn = "USER";
        return;
      }
      const lot = a.lot!;
      const player = ds.pool.find((p) => p.id === lot.playerId)!;
      let action: "bid" | "pass";
      if (lot.turn === "USER") {
        // Waits for the user, unless he cannot take part (then he passes for himself)
        if (this.userMayBid().ok) {
          ds.currentTurn = "USER";
          return;
        }
        action = "pass";
      } else {
        const price = nextBid(lot);
        const slots = this.slotsLeft("AI");
        const valuation = slots > 0 && this.legalToHold("AI", player).ok ? this.aiValuation(player) : 0;
        action = aiBids({ style: a.style, valuation, seed: ds.roomId, playerId: player.id, matches: player.stats.matches, heat: lot.raises }, price, affordable(a.purse.AI, slots)) ? "bid" : "pass";
      }
      this.applyLot(lot.turn, action);
    }
  }

  private applyLot(side: "USER" | "AI", action: "bid" | "pass") {
    const a = this.draftState!.auction!;
    if (action === "bid") {
      a.lot = bidOn(a.lot!, side);
      return;
    }
    const { lot, outcome } = passOn(a.lot!, side);
    a.lot = lot;
    if (outcome) this.closeLot(outcome);
  }

  /** The user bids the next step or passes on the player on the block. */
  private async applyBid(action: unknown): Promise<Result> {
    const ds = this.draftState;
    if (!ds || ds.status !== "DRAFTING") return { success: false, error: "The auction is over", status: 400 };
    if (ds.draftMode !== "auction" || !ds.auction?.lot) return { success: false, error: "There is no auction running", status: 400 };
    if (ds.auction.lot.turn !== "USER") return { success: false, error: "Not your turn to bid", status: 403 };
    if (action !== "bid" && action !== "pass") return { success: false, error: "action must be bid or pass", status: 400 };
    if (action === "bid") {
      const may = this.userMayBid();
      if (!may.ok) return { success: false, error: may.reason || "You can't bid on this player", status: 400 };
    }
    this.applyLot("USER", action);
    await this.runAuction();
    return { success: true };
  }

  /** Validates and applies a user pick, then lets the AI make its pick(s). Shared by HTTP and WebSocket. */
  private async applyUserPick(playerId: unknown): Promise<Result> {
    const ds = this.draftState;
    if (!ds || ds.status !== "DRAFTING") return { success: false, error: "The draft is over", status: 400 };
    if (ds.draftMode === "auction") return { success: false, error: "This is an auction: bid for the player on the block", status: 400 };
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
    await this.runAiTurns();
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
    // Once the user has set his own order, his squad stays as he left it (new picks take the next empty spot)
    ds[key] = by === "USER" && ds.userOrderManual ? squad : arrangeSquad(squad, this.format());
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

  /**
   * The AI makes every pick it is due (two in a row in a snake draft) until it is the user's turn.
   * With Workers AI available, its voice chooses between the rules' near-equal options and says a
   * line; otherwise (or on any failure) the rules' own pick stands.
   */
  private async runAiTurns() {
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
      let player = result.player;
      let reason = result.reason;
      let line: string | undefined;
      if (this.voiceOn() && !result.fallback) {
        const usage: VoiceUsage = (ds.voiceUsage ??= { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 });
        const reply = await askVoice(this.env?.AI, {
          difficulty: ds.difficulty ?? "normal",
          challenge: ds.challenge,
          mine: ds.aiPicks,
          theirs: ds.userPicks,
          options: result.shortlist,
          pickNumber: (ds.pickIndex ?? 0) + 1,
        }, usage, this.env?.AI_VOICE_MODEL || undefined);
        const chosen = reply ? result.shortlist[reply.index] : undefined;
        // The shortlist came from the pool a moment ago, but check again: the pick must still be there
        if (chosen && ds.pool.some((p) => p.id === chosen.player.id)) {
          player = chosen.player;
          reason = chosen.reason;
          line = reply!.line || undefined;
        }
      }
      this.place("AI", player, player === result.player ? result.slotIndex : undefined);
      const info: AiSnipeInfo = {
        player,
        slotIndex: ds.aiPicks.findIndex((p) => p?.id === player.id),
        reason,
        pickNumber: ds.pickIndex,
        ...(line ? { line } : {}),
      };
      ds.lastAiPicks = [...(ds.lastAiPicks ?? []), info];
      ds.lastAiSnipe = info;
    }
  }

  /**
   * The opponent's Workers AI voice is off unless AI_VOICE is "on": the small free model got cricket
   * facts wrong (an off-spinner called a leg-spinner) and its puns wore thin, so the rules' own
   * reasons, which are always accurate, are shown instead.
   */
  private voiceOn(): boolean {
    return !!this.env?.AI && this.env?.AI_VOICE === "on";
  }

  private noLegalPick(squad: (PlayerWithStats | null)[], ctx: PickContext): boolean {
    const ds = this.draftState!;
    return !ds.pool.some((p) => canPickPlayer(p, squad, ds.challenge, undefined, ctx).allowed);
  }

  /** The batting order is the user's to set from the first pick until the match is played. */
  private reorder(fromIndex: unknown, toIndex: unknown): Result {
    const ds = this.draftState;
    if (!ds) return { success: false, error: "Draft room not initialized", status: 400 };
    if (!isValidSlot(fromIndex) || !isValidSlot(toIndex)) return { success: false, error: "Invalid slot indices (must be integers 0-10)", status: 400 };
    if (ds.status === "COMPLETED") return { success: false, error: "The match has been played", status: 409 };
    if (!ds.userPicks[fromIndex]) return { success: false, error: "There is nobody in that slot to move", status: 400 };
    const order = ds.userPicks.slice();
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);
    ds.userPicks = order;
    ds.userOrderManual = true;
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
        const result = await this.applyUserPick(data.playerId);
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
      // Everyone who was on the board at the start: what is left of the pool, and both squads
      // (not for an auction: players did not come up as a board to choose from)
      ...(ds.draftMode === "auction"
        ? { auction: true }
        : { draftPool: [...ds.pool, ...ds.userPicks.filter((p): p is PlayerWithStats => !!p), ...ds.aiPicks.filter((p): p is PlayerWithStats => !!p)] }),
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

    // 4. Keep the match for good (the room itself is deleted after a week). Never fail the match over it.
    if (this.env?.DB && !ds.matchId) {
      const id = newMatchId();
      try {
        await saveMatch(this.env.DB, buildSnapshot(ds, id), ds.deviceId);
        ds.matchId = id;
      } catch (err) {
        console.error("[DraftRoom] Failed to save match:", err);
      }
    }

    await this.state.storage.put("draftState", ds);
    this.broadcast({ type: "COMPLETED", results: completedResults });
  }
}
