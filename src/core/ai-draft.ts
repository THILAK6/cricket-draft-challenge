import type { Challenge, MatchFormat, PlayerWithStats } from "./types";
import { canPickPlayer, isOpenerCapable, isTailCapable, type PickContext } from "./validator";
import { calculateDeterministicScore, isCutter } from "./scoring";
import { playerQuality } from "./player-quality";
import { eraAdjusted } from "./era";

export type Difficulty = "easy" | "normal" | "hard";
type Squad = (PlayerWithStats | null)[];

export interface AiPickInput {
  /** Players still available to both sides. */
  pool: PlayerWithStats[];
  /** The AI's own squad (11 slots, null = empty). */
  squad: Squad;
  /** The human's squad. */
  opponentSquad: Squad;
  challenge: Challenge;
  difficulty: Difficulty;
  /** Per-match seed (e.g. from the room id): Easy's misjudgements differ from match to match but replay identically. */
  noiseSeed: number;
  /** Pick number within the match, so noise changes pick to pick. */
  round: number;
}

export interface AiPickResult {
  player: PlayerWithStats;
  slotIndex: number;
  reason: string;
  /** True only when no candidate cleared the normal scoring and the best-quality legal player was taken instead. */
  fallback: boolean;
  /** Selection points the pick adds to the AI's completed XI. */
  ownGain: number;
  /** Selection points the human's best completed XI loses because the AI took this player. */
  denial: number;
}

/** How many selection points a unit of quality is worth when two candidates are otherwise tied. */
const QUALITY_TIEBREAK = 1e-4;
/** Weight on denial per difficulty (Easy ignores the human's squad). */
const DENIAL_WEIGHT: Record<Difficulty, number> = { easy: 0, normal: 0.5, hard: 1.0 };
/** Slots to try per player: the best fits only, to keep a pick cheap. */
const SLOTS_PER_PLAYER = 2;
/** Hard looks one reply ahead for this many leading candidates. */
const LOOKAHEAD_CANDIDATES = 4;
const LOOKAHEAD_REPLIES = 8;

const hash = (...xs: (string | number)[]): number => {
  let h = 2166136261;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 0x9e37, 2654435761);
  }
  return (h >>> 0) / 4294967296;
};

/** Selection score of an XI, unrounded so that small improvements register. */
export const selectionValue = (squad: Squad, challenge: Challenge): number =>
  calculateDeterministicScore(squad, challenge, { precise: true }).deterministic_total;

// ---------------------------------------------------------------------------------------------
// Slot rules: what a player may never be asked to do. These were -1500/-2000 score penalties; they
// are legality constraints now, so quality can never outbid them.
// ---------------------------------------------------------------------------------------------

const isMiddleAnchorOrFinisher = (p: PlayerWithStats): boolean =>
  p.stats.finisher_innings >= 4 || (p.stats.middle_order_innings >= 12 && p.stats.top_order_innings < 6);

/** Hard slot eligibility for the AI (on top of the validator's own slot-role rules). */
export function slotEligible(p: PlayerWithStats, slot: number, strict = true): boolean {
  const bowler = p.primary_role === "BOWL";
  if (slot <= 1) {
    if (!isOpenerCapable(p) || bowler) return false;
    return strict ? !isMiddleAnchorOrFinisher(p) : true;
  }
  if (slot <= 4) return !bowler;
  if (slot >= 8) return isTailCapable(p);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Rollout: complete an XI greedily. This only has to be a fair, cheap yardstick; the judge's own
// selection score is what decides between candidates.
// ---------------------------------------------------------------------------------------------

interface Ctx {
  challenge: Challenge;
  format: MatchFormat;
  pitch: string;
  quality: Map<string, number>;
  adj: Map<string, PlayerWithStats>;
  /** Pool sorted by quality, best first. */
  sorted: PlayerWithStats[];
}

const frontline = (p: PlayerWithStats, format: MatchFormat) =>
  p.primary_role === "BOWL" || (p.primary_role === "AR" && p.stats.bowl_wickets >= (format === "TEST" ? 40 : 25));

/** Where a player naturally bats, and what the ground wants, on the same scale as quality. */
function affinity(p: PlayerWithStats, slot: number, sq: Squad, c: Ctx): number {
  const { format, pitch } = c;
  const a = c.adj.get(p.id) ?? p;
  const test = format === "TEST";
  const t20 = format === "T20";
  const isBat = p.primary_role === "BAT";
  const isWK = p.primary_role === "WK";
  const isAR = p.primary_role === "AR";
  let v = 0;

  if (slot <= 1) {
    const open = a.stats.top_order_innings >= 8 || (a.stats.bat_innings >= 5 && a.stats.top_order_innings / Math.max(1, a.stats.bat_innings) >= 0.35);
    if (open && (isBat || isWK)) v += 25;
    else if (isBat && a.stats.top_order_innings >= 3) v += 8;
  } else if (slot === 2) {
    if (a.stats.bat_average >= (test ? 42 : 38) && (isBat || isWK)) v += 18;
  } else if (slot <= 4) {
    if (a.stats.middle_order_innings >= 8) v += 8;
  } else if (slot <= 6) {
    if (test) {
      if (isAR) v += 22;
      else if (isWK) v += 18;
      else if (isBat && a.stats.bat_average >= 32) v += 12;
    } else {
      if (a.stats.finisher_innings >= 5) v += 40;
      else if (isAR) v += 16;
      else if (a.stats.bat_strike_rate >= (t20 ? 140 : 100)) v += 12;
    }
  } else if (slot === 7) {
    if (isAR) v += 15;
    else if (p.primary_role === "BOWL" && a.stats.bat_average >= 14) v += 10;
  } else if (a.stats.bowl_wickets >= (test ? 60 : 40)) v += 10;

  // Squad needs the judge pays for
  if (isWK && !sq.some((q) => q && q.primary_role === "WK")) v += 25;
  const bowlers = sq.filter((q) => q && (q.primary_role === "BOWL" || q.primary_role === "AR" || q.stats.bowl_overs >= 2)).length;
  if (bowlers < 6 && (p.primary_role === "BOWL" || isAR)) v += 12;

  // What the ground wants, with diminishing returns so a rollout does not stack one type
  const have = (pred: (q: PlayerWithStats) => boolean) => sq.filter((q) => q && pred(q)).length;
  const fPace = (q: PlayerWithStats) => q.bowling_category === "PACE" && frontline(q, format);
  const fSpin = (q: PlayerWithStats) => q.bowling_category === "SPIN" && frontline(q, format);
  const pace = fPace(p);
  const spin = fSpin(p);
  switch (pitch) {
    case "GREEN_SEAMER":
      if (pace) v += have(fPace) < 3 ? 28 : 6;
      if (spin && have(fSpin) >= 1) v -= 18;
      break;
    case "DUSTBOWL":
      if (spin) v += have(fSpin) < 3 ? 28 : 6;
      if (pace && have(fPace) >= 2) v -= 18;
      break;
    case "SLOW_LOW":
      if (spin && have(fSpin) < 2) v += 22;
      if (isCutter(p) && frontline(p, format)) v += 10;
      if (a.stats.bowl_economy > 0 && a.stats.bowl_economy <= (t20 ? 7.2 : test ? 2.8 : 4.9)) v += 8;
      break;
    case "HIGH_SCORING_FLAT":
      if (isBat && a.stats.bat_strike_rate >= (t20 ? 135 : test ? 55 : 92)) v += 12;
      if ((pace || spin) && a.stats.bowl_economy > 0 && a.stats.bowl_economy <= (t20 ? 7.5 : test ? 3.0 : 5.0)) v += 10;
      break;
  }
  return v;
}

/** Slots in the order a rollout fills them: the hardest to staff first. */
const FILL_ORDER = [10, 9, 8, 0, 1, 7, 2, 3, 4, 5, 6];

/**
 * Completes `squad` to eleven from `pool` (minus `exclude`), best affinity first, only with
 * legal, eligible players. Returns the completed XI (possibly short if the pool cannot finish it).
 */
function complete(squad: Squad, c: Ctx, exclude: Set<string>): Squad {
  const sq = squad.slice();
  const used = new Set<string>(exclude);
  for (const p of sq) if (p) used.add(p.id);
  for (const slot of FILL_ORDER) {
    if (sq[slot]) continue;
    let best: PlayerWithStats | null = null;
    let bestScore = -Infinity;
    const rejected: string[] = [];
    for (let guard = 0; guard < 6; guard++) {
      best = null;
      bestScore = -Infinity;
      for (const p of c.sorted) {
        if (used.has(p.id) || rejected.includes(p.id)) continue;
        if (!slotEligible(p, slot)) continue;
        const s = (c.quality.get(p.id) ?? 0) + affinity(p, slot, sq, c);
        if (s > bestScore) {
          bestScore = s;
          best = p;
        }
      }
      if (!best) break;
      if (canPickPlayer(best, sq, c.challenge, slot).allowed) break;
      rejected.push(best.id);
      best = null;
    }
    if (best) {
      sq[slot] = best;
      used.add(best.id);
    }
  }
  return sq;
}

const completedValue = (squad: Squad, c: Ctx, exclude: Set<string>): number => selectionValue(complete(squad, c, exclude), c.challenge);

function buildCtx(pool: PlayerWithStats[], challenge: Challenge): Ctx {
  const format = (challenge.format || "T20") as MatchFormat;
  const quality = new Map<string, number>();
  const adj = new Map<string, PlayerWithStats>();
  for (const p of pool) {
    quality.set(p.id, playerQuality(p, format));
    adj.set(p.id, eraAdjusted(p, format));
  }
  const sorted = [...pool].sort((a, b) => (quality.get(b.id) ?? 0) - (quality.get(a.id) ?? 0));
  return { challenge, format, pitch: challenge.venue.pitch_type, quality, adj, sorted };
}

// ---------------------------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------------------------

interface Candidate {
  player: PlayerWithStats;
  slot: number;
  own: number; // completed-XI selection value
  denial: number;
  total: number;
}

export function chooseAiPick(input: AiPickInput): AiPickResult | null {
  const { pool, squad, opponentSquad, challenge, difficulty } = input;
  if (pool.length === 0) return null;
  const empties: number[] = [];
  for (let i = 0; i < 11; i++) if (!squad[i]) empties.push(i);
  if (empties.length === 0) return null;

  const ctx = buildCtx(pool, challenge);
  const pickCtx: PickContext = { pool, opponentSquad };
  const none = new Set<string>();
  const baseOwn = completedValue(squad, ctx, none);

  // --- candidate (player, slot) pairs: legal, eligible, best fits only -------------------------
  const build = (strict: boolean | null, shared = true): { player: PlayerWithStats; slot: number }[] => {
    const pairs: { player: PlayerWithStats; slot: number }[] = [];
    for (const p of pool) {
      const slots: { slot: number; fit: number }[] = [];
      for (const slot of empties) {
        if (strict !== null && !slotEligible(p, slot, strict)) continue;
        if (!canPickPlayer(p, squad, challenge, slot, shared ? pickCtx : undefined).allowed) continue;
        slots.push({ slot, fit: affinity(p, slot, squad, ctx) });
      }
      slots.sort((a, b) => b.fit - a.fit);
      for (const s of slots.slice(0, SLOTS_PER_PLAYER)) pairs.push({ player: p, slot: s.slot });
    }
    return pairs;
  };
  // Supply check: taking (p, slot) must not leave the two squads short of players for a slot class
  // (openers, non-bowlers for 3-5, tail-capable for 9-11) that the shared pool can no longer staff.
  const classOf = (slot: number): 0 | 1 | 2 | 3 => (slot <= 1 ? 0 : slot <= 4 ? 1 : slot >= 8 ? 2 : 3);
  const inClass = (q: PlayerWithStats, k: number) => (k === 0 ? slotEligible(q, 0, false) : k === 1 ? q.primary_role !== "BOWL" : k === 2 ? isTailCapable(q) : true);
  const need = [0, 0, 0, 0];
  for (let i = 0; i < 11; i++) {
    if (!squad[i]) need[classOf(i)]++;
    if (!opponentSquad[i]) need[classOf(i)]++;
  }
  const supply = [0, 1, 2].map((k) => pool.filter((q) => inClass(q, k)).length);
  const staffed = (player: PlayerWithStats, slot: number): boolean => {
    const own = classOf(slot);
    for (const k of [0, 1, 2]) {
      const left = supply[k] - (inClass(player, k) ? 1 : 0);
      const needed = need[k] - (own === k ? 1 : 0);
      if (left < needed) return false;
    }
    return pool.length - 1 >= need[0] + need[1] + need[2] + need[3] - 1;
  };
  const staffedPairs = (ps: { player: PlayerWithStats; slot: number }[]) => ps.filter((x) => staffed(x.player, x.slot));
  let pairs = staffedPairs(build(true));
  if (pairs.length === 0) pairs = build(true);
  if (pairs.length === 0) pairs = staffedPairs(build(false));
  if (pairs.length === 0) pairs = build(false);
  // Last scored tier: anything the validator allows (the judge still decides between them)
  if (pairs.length === 0) pairs = build(null);
  // If the shared pool is already too thin for the opponent, protect only this squad's own legality
  if (pairs.length === 0) pairs = build(false, false);
  if (pairs.length === 0) pairs = build(null, false); // strict role fit left nothing: relax it before giving up

  // --- own gain: the judge's score of the completed XI ----------------------------------------
  const cands: Candidate[] = pairs.map(({ player, slot }) => {
    const sq = squad.slice();
    sq[slot] = player;
    return { player, slot, own: completedValue(sq, ctx, new Set([player.id])), denial: 0, total: 0 };
  });

  // --- denial: how far the human's best completed XI falls without this player ------------------
  const weight = DENIAL_WEIGHT[difficulty];
  if (weight > 0 && cands.length > 0) {
    const userBase = completedValue(opponentSquad, ctx, none);
    const cache = new Map<string, number>();
    for (const c of cands) {
      let d = cache.get(c.player.id);
      if (d === undefined) {
        d = Math.max(0, userBase - completedValue(opponentSquad, ctx, new Set([c.player.id])));
        cache.set(c.player.id, d);
      }
      c.denial = d;
    }
  }

  // Easy: the AI misreads the board. Noise is seeded per match and per pick, so it differs between
  // matches but a given match always replays the same way.
  let noise: (c: Candidate) => number = () => 0;
  if (difficulty === "easy" && cands.length > 1) {
    const owns = cands.map((c) => c.own);
    const spread = Math.max(...owns) - Math.min(...owns);
    noise = (c) => (hash(input.noiseSeed, input.round, c.player.id) - 0.5) * spread * 1.2;
  }

  for (const c of cands) {
    c.total = c.own + weight * c.denial + noise(c) + QUALITY_TIEBREAK * (ctx.quality.get(c.player.id) ?? 0);
  }
  cands.sort((a, b) => b.total - a.total);

  // --- Hard: one-pick lookahead. Assume the human takes the reply that suits them best. ----------
  if (difficulty === "hard" && cands.length > 1) {
    const head = cands.slice(0, LOOKAHEAD_CANDIDATES);
    for (const c of head) {
      const taken = new Set([c.player.id]);
      const mine = squad.slice();
      mine[c.slot] = c.player;
      // The human's best reply: whichever remaining player lifts their completed XI most
      const replies = ctx.sorted.filter((p) => !taken.has(p.id)).slice(0, 40);
      let bestReply: PlayerWithStats | null = null;
      let bestValue = -Infinity;
      const replyPool = replies
        .map((p) => ({ p, slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((s) => !opponentSquad[s]) }))
        .slice(0, LOOKAHEAD_REPLIES + 12);
      let tried = 0;
      for (const { p, slots } of replyPool) {
        if (tried >= LOOKAHEAD_REPLIES) break;
        const slot = slots.find((s) => slotEligible(p, s) && canPickPlayer(p, opponentSquad, challenge, s).allowed);
        if (slot === undefined) continue;
        tried++;
        const sq = opponentSquad.slice();
        sq[slot] = p;
        const v = completedValue(sq, ctx, new Set([...taken, p.id]));
        if (v > bestValue) {
          bestValue = v;
          bestReply = p;
        }
      }
      if (bestReply) {
        const after = completedValue(mine, ctx, new Set([...taken, bestReply.id]));
        c.total = after + weight * c.denial + QUALITY_TIEBREAK * (ctx.quality.get(c.player.id) ?? 0);
        c.own = after;
      }
    }
    // Only the head was re-scored (a different scale), so reorder within it and keep it on top
    head.sort((a, b) => b.total - a.total);
    cands.splice(0, head.length, ...head);
  }

  // --- the best candidate that also keeps the shared pool completable for both squads -------------
  for (const c of cands) {
    if (!canPickPlayer(c.player, squad, challenge, c.slot).allowed) continue;
    const gain = c.own - baseOwn;
    const name = c.player.name;
    let reason: string;
    if (weight > 0 && c.denial >= 1 && weight * c.denial >= 0.4 * Math.max(0.01, c.own - baseOwn + weight * c.denial)) {
      reason = `AI took ${name} to keep him from you: without ${name}, your best XI would lose about ${c.denial.toFixed(1)} selection points.`;
    } else if (squad.every((p) => !p)) {
      reason = `AI opened with ${name}, the pick that builds the strongest XI for ${challenge.venue.pitch_type.replace(/_/g, " ").toLowerCase()} conditions.`;
    } else {
      reason = `AI strategically secured ${name} for Slot #${c.slot + 1} (+${gain.toFixed(1)} selection points).`;
    }
    return { player: c.player, slotIndex: c.slot, reason, fallback: false, ownGain: gain, denial: c.denial };
  }

  // --- fallback: nothing cleared the normal scoring, so take the best-quality legal player ----------
  const slotsOpen = empties.slice();
  for (const p of ctx.sorted) {
    for (const slot of slotsOpen) {
      if (canPickPlayer(p, squad, challenge, slot, pickCtx).allowed) {
        return { player: p, slotIndex: slot, reason: `AI picked ${p.name} into Slot #${slot + 1}.`, fallback: true, ownGain: 0, denial: 0 };
      }
    }
  }
  // Last resort: any player into any slot, so the draft never stalls
  const p = ctx.sorted[0];
  return { player: p, slotIndex: slotsOpen[0], reason: `AI picked ${p.name} into Slot #${slotsOpen[0] + 1}.`, fallback: true, ownGain: 0, denial: 0 };
}
