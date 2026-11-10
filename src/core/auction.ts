import type { AuctionLot, AuctionState, PlayerWithStats } from "./types";

/**
 * The auction draft (IPL). Each side has a purse to fill an XI; players come up one at a time, a
 * marquee round of the six best first, then sets (batters, keepers, all-rounders, fast bowlers,
 * spinners). The two sides bid or pass in turn; whoever holds the last bid wins the player for it.
 *
 * Money is in crore. What a player is worth to the AI comes from the same stats-only valuation its
 * draft uses (quality, what its XI needs, the pitch), turned into a price. Pure functions only:
 * the draft room applies them.
 */

type Side = "USER" | "AI";
const other = (s: Side): Side => (s === "USER" ? "AI" : "USER");

/** Crore each side has to spend: 60 is where a fair-value bidder spends nearly all of it and about one auction in six needs the fill-up round (tests/auction-sim.test.ts). */
export const AUCTION = { purse: 60 };
export const PURSE = AUCTION.purse;
/** The least any player can cost, and so what an unfilled slot is held back for. */
export const MIN_PRICE = 0.2;
/** Players in the opening marquee round. */
export const MARQUEE = 6;

const r2 = (x: number) => Math.round(x * 100) / 100;

/** What a player worth this many rating points is worth in crore: about 15 for the very best, 4.5 for a 70, under 1 for a squad player. */
export const fairPrice = (points: number) => r2(MIN_PRICE + 15 * Math.pow(Math.max(0, Math.min(110, points) - 30) / 70, 2.2));

/** Where bidding opens, by quality: stars start higher. */
export const basePrice = (quality: number) => (quality >= 90 ? 2 : quality >= 75 ? 1 : quality >= 55 ? 0.5 : MIN_PRICE);

/** The step a bid goes up by: 25 lakh below 2 crore, 50 lakh to 5, then a crore. */
export const increment = (price: number) => (price < 2 ? 0.25 : price < 5 ? 0.5 : 1);

/** The next bid on a lot: the base price for the first, then a step up. */
export const nextBid = (lot: Pick<AuctionLot, "bid" | "base">) => (lot.bid === null ? lot.base : r2(lot.bid + increment(lot.bid)));

/** The most a side can bid and still afford to fill the rest of its XI at the minimum. */
export const affordable = (purse: number, slotsLeft: number) => (slotsLeft <= 0 ? 0 : r2(purse - (slotsLeft - 1) * MIN_PRICE));

const SETS = ["Batters", "Wicketkeepers", "All-rounders", "Fast bowlers", "Spinners"] as const;
export const setOf = (p: PlayerWithStats): (typeof SETS)[number] =>
  p.primary_role === "WK" ? "Wicketkeepers" : p.primary_role === "BAT" ? "Batters" : p.primary_role === "AR" ? "All-rounders" : p.bowling_category === "SPIN" ? "Spinners" : "Fast bowlers";

function shuffled<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The order players come up in: the marquee six (in a random order), then each set in turn (random within it). */
export function lotOrder(pool: PlayerWithStats[], quality: (p: PlayerWithStats) => number, rand: () => number): { id: string; set: string }[] {
  const ranked = [...pool].sort((a, b) => quality(b) - quality(a) || a.id.localeCompare(b.id));
  const marquee = ranked.slice(0, MARQUEE);
  const taken = new Set(marquee.map((p) => p.id));
  const out = shuffled(marquee, rand).map((p) => ({ id: p.id, set: "Marquee" }));
  for (const set of SETS) for (const p of shuffled(pool.filter((q) => !taken.has(q.id) && setOf(q) === set), rand)) out.push({ id: p.id, set });
  return out;
}

// ---- One lot ----------------------------------------------------------------------------------

/** Puts a player on the block; the sides open the bidding in turn. */
export function startLot(a: Pick<AuctionState, "log">, p: PlayerWithStats, set: string, quality: number): AuctionLot {
  return { playerId: p.id, set, base: basePrice(quality), bid: null, holder: null, turn: a.log.length % 2 === 0 ? "USER" : "AI", passes: 0, raises: 0 };
}

export const bidOn = (lot: AuctionLot, side: Side): AuctionLot => ({ ...lot, bid: nextBid(lot), holder: side, turn: other(side), passes: 0, raises: lot.raises + 1 });

export type LotOutcome = { sold: { to: Side; price: number } } | { unsold: true } | null;

/** A side passes: the lot is sold to whoever holds the bid, or goes unsold if both pass at the start. */
export function passOn(lot: AuctionLot, side: Side): { lot: AuctionLot; outcome: LotOutcome } {
  if (lot.holder && lot.holder !== side) return { lot, outcome: { sold: { to: lot.holder, price: lot.bid! } } };
  if (lot.passes >= 1) return { lot, outcome: { unsold: true } };
  return { lot: { ...lot, turn: other(side), passes: lot.passes + 1 }, outcome: null };
}

// ---- The AI bidder ------------------------------------------------------------------------------

const hash = (...xs: (string | number)[]): number => {
  let h = 2166136261;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 0x9e37, 2654435761);
  }
  return (h >>> 0) / 4294967296;
};

export interface BidInput {
  style: AuctionState["style"];
  /** What the player is worth to the AI's XI, in crore (fairPrice of the AI's own valuation) */
  valuation: number;
  /** Seed parts: the room and the player, so a person-like bidder is the same on a replay */
  seed: string;
  playerId: string;
  /** Matches played: a famous name draws a crowd */
  matches: number;
  /** How many times the other side has bid on this lot */
  heat: number;
}

/**
 * The most the AI will pay. "calculated": exactly its valuation. "impulsive": its valuation seen
 * through a bad day or a good one (-25% to +35%), plus a premium for a famous name, plus the heat of a
 * bidding war: it gets carried away, and sometimes lets a bargain go.
 */
export function aiCeiling(i: BidInput): number {
  if (i.style === "calculated") return i.valuation;
  const mood = 0.75 + 0.6 * hash(i.seed, i.playerId);
  const fame = 1 + 0.2 * Math.min(1, i.matches / 150);
  const heat = 1 + 0.12 * Math.min(4, i.heat);
  return r2(i.valuation * mood * fame * heat);
}

/** Would the AI bid this price? Never above what it can afford. */
export const aiBids = (i: BidInput, price: number, canAfford: number) => price <= canAfford && price <= aiCeiling(i);
