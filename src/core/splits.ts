import type { MatchFormat, PlayerSplitData, PlayerWithStats } from "./types";
import { DATA_NORMS } from "./data-norms.generated";
import { IPL_NORMS } from "./data-norms-ipl.generated";

/**
 * Player splits from Cricsheet ball-by-ball data (data/player-splits.sql): a player's record by
 * batting position, by region of the ground, and batting first v chasing. Each becomes a "shape":
 * how much better or worse than his own level he is in that situation, against what a typical
 * international does there, and pulled towards "no different" when the sample is small.
 *
 * All shapes multiply: sr (scoring rate), out (chance of being dismissed), econ (runs conceded),
 * wkt (chance of taking a wicket). 1 = no different.
 */

export type PosKey = "open" | "three" | "four5" | "six7" | "tail";
export type RegionKey = "asia" | "sena" | "other";
export type SplitData = PlayerSplitData;

export interface Shape {
  sr: number;
  out: number;
  econ: number;
  wkt: number;
}
export const NEUTRAL_SHAPE: Shape = { sr: 1, out: 1, econ: 1, wkt: 1 };

type BatNorm = { sr: number; bpo: number };
type BowlNorm = { econ: number; bpw: number };
const NORMS = DATA_NORMS as unknown as Record<
  MatchFormat,
  {
    all: BatNorm & BowlNorm;
    phase: Record<string, BatNorm & BowlNorm>;
    pos: Record<PosKey, BatNorm>;
    region: Record<RegionKey, BatNorm & BowlNorm>;
    chase: Record<"first" | "second", BatNorm>;
    par: { all: number; ground: Record<string, { avg: number; n: number }> };
  }
>;
type Norms = (typeof NORMS)[MatchFormat];
/** The IPL's norms when the data has been built (src/etl/ipl.ts); its Twenty20 stand-in until then. */
const IPL = (IPL_NORMS as unknown as (Norms & { midYear: Record<string, number> }) | null) ?? null;
export const iplNormsLoaded = () => !!IPL;
export const iplMidYear = (id: string): number | undefined => IPL?.midYear?.[id];
/** The franchises (codes) a player turned out for, most matches first; none until the data job has run. */
export const iplFranchisesOf = (id: string): string[] => ((IPL as unknown as { franchises?: Record<string, string[]> } | null)?.franchises?.[id]) ?? [];
/** The norms for a format; a league's players are judged against that league's own. */
export const formatNorms = (f: MatchFormat, league?: "IPL"): Norms => (league === "IPL" && IPL ? IPL : NORMS[f]);

/** Balls before a split's own numbers count for half. */
const K = { sr: 150, out: 300, econ: 150, wkt: 300 };
/** Too few balls in total to read anything into the splits. */
const MIN_BALLS = 60;

export const posOf = (position: number): PosKey => (position <= 2 ? "open" : position === 3 ? "three" : position <= 5 ? "four5" : position <= 7 ? "six7" : "tail");

const REGION_OF: Record<string, RegionKey> = {
  IND: "asia", PAK: "asia", SL: "asia", BAN: "asia", UAE: "asia", AFG: "asia", NEP: "asia", OMA: "asia",
  ENG: "sena", AUS: "sena", NZL: "sena", RSA: "sena", IRE: "sena", SCO: "sena", NED: "sena",
};
export const regionOf = (country: string): RegionKey => REGION_OF[country] ?? "other";
export const REGION_LABEL: Record<RegionKey, string> = { asia: "in Asia", sena: "in England, Australia, NZ and South Africa", other: "elsewhere" };

const shrink = (raw: number, n: number, k: number) => (Number.isFinite(raw) && raw > 0 ? 1 + (raw - 1) * (n / (n + k)) : 1);

/**
 * Batting shape for one split from {key: [runs, balls, outs]} lines and the norms for each key:
 * his rate in the split against the norm there, divided by his overall rate against the norm his
 * own mix of splits would expect.
 */
function batShape<K extends string>(lines: Partial<Record<K, readonly number[]>>, norms: Record<K, BatNorm>, key: K): Pick<Shape, "sr" | "out"> {
  const keys = (Object.keys(lines) as K[]).filter((k) => norms[k] && (lines[k]?.[1] ?? 0) > 0);
  const balls = keys.reduce((s, k) => s + lines[k]![1], 0);
  const mine = lines[key];
  if (balls < MIN_BALLS || !mine || !mine[1] || !norms[key]) return { sr: 1, out: 1 };
  const runs = keys.reduce((s, k) => s + lines[k]![0], 0);
  const outs = keys.reduce((s, k) => s + lines[k]![2], 0);
  const expSr = keys.reduce((s, k) => s + lines[k]![1] * norms[k].sr, 0) / balls;
  const expBpo = keys.reduce((s, k) => s + lines[k]![1] * norms[k].bpo, 0) / balls;
  const relSr = (runs / balls) * 100 / expSr;
  const relOut = Math.max(0.2, (outs / balls) * expBpo);
  const [r, b, o] = mine;
  return {
    sr: shrink(((r / b) * 100) / norms[key].sr / relSr, b, K.sr),
    out: shrink(((o / b) * norms[key].bpo) / relOut, b, K.out),
  };
}

/** Bowling shape for one split from {key: [balls, runs, wkts]} lines. */
function bowlShape<K extends string>(lines: Partial<Record<K, readonly number[]>>, norms: Record<K, BowlNorm>, key: K): Pick<Shape, "econ" | "wkt"> {
  const keys = (Object.keys(lines) as K[]).filter((k) => norms[k] && (lines[k]?.[0] ?? 0) > 0);
  const balls = keys.reduce((s, k) => s + lines[k]![0], 0);
  const mine = lines[key];
  if (balls < MIN_BALLS || !mine || !mine[0] || !norms[key]) return { econ: 1, wkt: 1 };
  const runs = keys.reduce((s, k) => s + lines[k]![1], 0);
  const wkts = keys.reduce((s, k) => s + lines[k]![2], 0);
  const expEcon = keys.reduce((s, k) => s + lines[k]![0] * norms[k].econ, 0) / balls;
  const expBpw = keys.reduce((s, k) => s + lines[k]![0] * norms[k].bpw, 0) / balls;
  const relEcon = ((runs / balls) * 6) / expEcon;
  const relWkt = Math.max(0.2, (wkts / balls) * expBpw);
  const [b, r, w] = mine;
  return {
    econ: shrink(((r / b) * 6) / norms[key].econ / relEcon, b, K.econ),
    wkt: shrink(((w / b) * norms[key].bpw) / relWkt, b, K.wkt),
  };
}

const cache = new WeakMap<SplitData, Map<string, Shape>>();
function memo(d: SplitData, key: string, fn: () => Shape): Shape {
  let m = cache.get(d);
  if (!m) cache.set(d, (m = new Map()));
  let v = m.get(key);
  if (!v) m.set(key, (v = fn()));
  return v;
}

/** How he bats at this position (1-based) compared with his own level. */
export function positionShape(p: PlayerWithStats, f: MatchFormat, position: number): Shape {
  const d = p.stats.splits;
  if (!d?.pos) return NEUTRAL_SHAPE;
  const key = posOf(position);
  return memo(d, `${f}:pos:${key}`, () => ({ ...NEUTRAL_SHAPE, ...batShape(d.pos!, formatNorms(f, p.stats.league).pos, key) }));
}

/** How he bats and bowls in this region compared with his own level. */
export function regionShape(p: PlayerWithStats, f: MatchFormat, venueCountry: string): Shape {
  const d = p.stats.splits;
  if (!d?.region) return NEUTRAL_SHAPE;
  const key = regionOf(venueCountry);
  return memo(d, `${f}:region:${key}`, () => {
    const bat = Object.fromEntries(Object.entries(d.region!).map(([k, v]) => [k, v!.slice(0, 3)])) as Partial<Record<RegionKey, number[]>>;
    const bowl = Object.fromEntries(Object.entries(d.region!).map(([k, v]) => [k, v!.slice(3, 6)])) as Partial<Record<RegionKey, number[]>>;
    const region = formatNorms(f, p.stats.league).region;
    return { ...batShape(bat, region, key), ...bowlShape(bowl, region, key) };
  });
}

/** Limited overs: how he bats chasing (or setting a total) compared with his own level. */
export function chaseShape(p: PlayerWithStats, f: MatchFormat, chasing: boolean): Shape {
  const d = p.stats.splits;
  if (f === "TEST" || !d?.chase) return NEUTRAL_SHAPE;
  const key = chasing ? "second" : "first";
  return memo(d, `${f}:chase:${key}`, () => ({ ...NEUTRAL_SHAPE, ...batShape(d.chase!, formatNorms(f, p.stats.league).chase, key) }));
}

/** Matches at a ground before its own par counts for half. */
const VENUE_K = 10;
/**
 * How high-scoring the ground is: its average first-innings total in internationals against the
 * format's, pulled towards 1 for grounds with few matches. 1 for grounds without data.
 */
export function venueParFactor(f: MatchFormat, venueName: string, league?: "IPL"): number {
  const par = formatNorms(f, league)?.par;
  const g = par?.ground[venueName];
  if (!par || !g || !par.all) return 1;
  return shrink(g.avg / par.all, g.n, VENUE_K);
}

/** The ground's real par score (average first innings), when there is enough data to quote it. */
export function venuePar(f: MatchFormat, venueName: string, league?: "IPL"): { avg: number; matches: number } | null {
  const g = formatNorms(f, league)?.par.ground[venueName];
  return g && g.n >= 5 ? { avg: g.avg, matches: g.n } : null;
}

/** "at #3: avg 52.1 · SR 135 · 40 inns": his record at a position, when he has batted there. */
export function positionRecord(p: PlayerWithStats, position: number): { avg?: number; sr?: number; innings: number } {
  const line = p.stats.splits?.pos?.[posOf(position)];
  if (!line || !line[3]) return { innings: 0 };
  const [r, b, o, inns] = line;
  return { avg: o ? r / o : undefined, sr: b ? (r / b) * 100 : undefined, innings: inns };
}
