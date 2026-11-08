import type { MatchFormat, PlayerWithStats } from "./types";
import { formatNorms } from "./splits";

/**
 * Phase stats: what a player did in the powerplay, the middle overs and at the death (T20: 1-6,
 * 7-15, 16-20; ODI: 1-10, 11-40, 41-50), from Cricsheet ball-by-ball data (data/phase-stats.sql).
 *
 * Two uses:
 *  - Level: career numbers depend on WHEN a player batted or bowled. A finisher's strike rate is
 *    inflated by the death overs, a death bowler's economy too, and a spinner's economy is flattered
 *    by the middle overs. `phaseMixFactors` puts every player on an average phase mix.
 *  - Shape: how much better or worse than his own level a player is in each phase (Bumrah at the
 *    death, Narine in the middle), pulled towards "no different" when the sample is small.
 */

export type PhaseKey = "pp" | "mid" | "death";
/** [bat_runs, bat_balls, bat_outs, bowl_balls, bowl_runs, bowl_wkts] */
export type PhaseLine = [number, number, number, number, number, number];
export type PhaseLines = Record<PhaseKey, PhaseLine>; // same shape as PhaseStatLines in types.ts
export const PHASE_KEYS: PhaseKey[] = ["pp", "mid", "death"];
export const PHASE_OF_SIM = { PP: "pp", MID: "mid", DEATH: "death" } as const;

type Norm = { sr: number; bpo: number; econ: number; bpw: number };
/**
 * What a typical international does in each phase: Full Member v Full Member matches, from
 * src/core/data-norms.generated.ts (rebuilt with the data).
 * sr = batting strike rate, bpo = balls per dismissal, econ = runs per over, bpw = balls per wicket.
 */
export function phaseNorm(format: MatchFormat): Record<PhaseKey | "all", Norm> {
  const n = formatNorms(format);
  return { pp: n.phase.pp, mid: n.phase.mid, death: n.phase.death, all: n.all } as Record<PhaseKey | "all", Norm>;
}

/** Balls in a phase before its own numbers count for half (smaller samples lean on the player's level). */
const K = { sr: 120, out: 240, econ: 120, wkt: 240 };
/** Fewer balls than this in all phases together: too little to say anything about phases. */
const MIN_BALLS = 60;

export interface PhaseShape {
  sr: number;
  out: number;
  econ: number;
  wkt: number;
}
const NEUTRAL: PhaseShape = { sr: 1, out: 1, econ: 1, wkt: 1 };

const has = (p: PlayerWithStats, format: MatchFormat) => (format === "T20" || format === "ODI") && !!p.stats.phases;
const sumOf = (l: PhaseLines, i: number) => l.pp[i] + l.mid[i] + l.death[i];

export const hasBattingPhases = (p: PlayerWithStats, format: MatchFormat) => has(p, format) && sumOf(p.stats.phases!, 1) >= MIN_BALLS;
export const hasBowlingPhases = (p: PlayerWithStats, format: MatchFormat) => has(p, format) && sumOf(p.stats.phases!, 3) >= MIN_BALLS;

/** The phase norm a player's own mix of balls would expect (weighted by balls in each phase). */
function expected(l: PhaseLines, ballsAt: number, key: keyof Norm, norm: Record<PhaseKey | "all", Norm>): number {
  const balls = sumOf(l, ballsAt);
  return PHASE_KEYS.reduce((s, k) => s + l[k][ballsAt] * norm[k][key], 0) / balls;
}

/**
 * Multipliers that put a player's career numbers on an average phase mix: a finisher's strike
 * rate comes down, a death bowler's economy comes down, a middle-overs spinner's goes up.
 */
export function phaseMixFactors(p: PlayerWithStats, format: MatchFormat): { sr: number; bpo: number; econ: number; bpw: number } {
  const out = { sr: 1, bpo: 1, econ: 1, bpw: 1 };
  if (!has(p, format)) return out;
  const l = p.stats.phases!;
  const norm = phaseNorm(format);
  const all = norm.all;
  if (hasBattingPhases(p, format)) {
    out.sr = all.sr / expected(l, 1, "sr", norm);
    out.bpo = all.bpo / expected(l, 1, "bpo", norm);
  }
  if (hasBowlingPhases(p, format)) {
    out.econ = all.econ / expected(l, 3, "econ", norm);
    out.bpw = all.bpw / expected(l, 3, "bpw", norm);
  }
  return out;
}

const shapeCache = new WeakMap<PhaseLines, Record<PhaseKey, PhaseShape>>();

/**
 * How a player does in each phase relative to his own level (1 = just as you'd expect from his
 * overall numbers). sr/econ multiply his scoring and conceding rates, out/wkt his chance of being
 * dismissed and of taking a wicket. Shrunk towards 1 for small samples.
 */
export function phaseShape(p: PlayerWithStats, format: MatchFormat, phase: PhaseKey): PhaseShape {
  if (!has(p, format)) return NEUTRAL;
  const l = p.stats.phases!;
  let cached = shapeCache.get(l);
  if (!cached) {
    cached = { pp: { ...NEUTRAL }, mid: { ...NEUTRAL }, death: { ...NEUTRAL } };
    const shrink = (raw: number, n: number, k: number) => (Number.isFinite(raw) && raw > 0 ? 1 + (raw - 1) * (n / (n + k)) : 1);
    const batBalls = sumOf(l, 1);
    const bowlBalls = sumOf(l, 3);
    // His overall rate against what his mix of phases would expect
    const norm = phaseNorm(format);
    const relSr = batBalls ? (sumOf(l, 0) / batBalls) * 100 / expected(l, 1, "sr", norm) : 1;
    const relOut = batBalls ? (sumOf(l, 2) / batBalls) * expected(l, 1, "bpo", norm) : 1;
    const relEcon = bowlBalls ? ((sumOf(l, 4) / bowlBalls) * 6) / expected(l, 3, "econ", norm) : 1;
    const relWkt = bowlBalls ? (sumOf(l, 5) / bowlBalls) * expected(l, 3, "bpw", norm) : 1;
    for (const k of PHASE_KEYS) {
      const [runs, balls, outs, bBalls, bRuns, wkts] = l[k];
      const n = norm[k];
      if (batBalls >= MIN_BALLS && balls > 0) {
        cached[k].sr = shrink(((runs / balls) * 100) / n.sr / relSr, balls, K.sr);
        cached[k].out = shrink(((outs / balls) * n.bpo) / Math.max(0.2, relOut), balls, K.out);
      }
      if (bowlBalls >= MIN_BALLS && bBalls > 0) {
        cached[k].econ = shrink(((bRuns / bBalls) * 6) / n.econ / relEcon, bBalls, K.econ);
        cached[k].wkt = shrink(((wkts / bBalls) * n.bpw) / Math.max(0.2, relWkt), bBalls, K.wkt);
      }
    }
    shapeCache.set(l, cached);
  }
  return cached[phase];
}

/** "7.2 in 724 balls": a player's own numbers in one phase, for the head-to-head. */
export function phaseLine(p: PlayerWithStats, phase: PhaseKey): { econ?: number; sr?: number; bowlBalls: number; batBalls: number } {
  const l = p.stats.phases?.[phase];
  if (!l) return { bowlBalls: 0, batBalls: 0 };
  return {
    sr: l[1] ? (l[0] / l[1]) * 100 : undefined,
    econ: l[3] ? (l[4] / l[3]) * 6 : undefined,
    batBalls: l[1],
    bowlBalls: l[3],
  };
}
