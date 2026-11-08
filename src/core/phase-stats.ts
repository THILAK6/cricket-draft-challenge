import type { MatchFormat, PlayerWithStats } from "./types";

/**
 * T20 phase stats: what a player did in the powerplay (overs 1-6), the middle (7-15) and at the
 * death (16-20), from Cricsheet ball-by-ball data (data/phase-stats.sql).
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

/**
 * What a typical international does in each phase: Full Member players in T20Is, from
 * data/phase-stats.sql (re-check with tests/phase-stats.test.ts if the data is rebuilt).
 * sr = batting strike rate, bpo = balls per dismissal, econ = runs per over, bpw = balls per wicket.
 */
export const T20_PHASE_NORM: Record<PhaseKey | "all", { sr: number; bpo: number; econ: number; bpw: number }> = {
  pp: { sr: 124.5, bpo: 21.9, econ: 7.6, bpw: 21.9 },
  mid: { sr: 124.6, bpo: 21.2, econ: 7.55, bpw: 21.3 },
  death: { sr: 150.3, bpo: 11.5, econ: 9.07, bpw: 12.4 },
  all: { sr: 129.9, bpo: 18.1, econ: 7.89, bpw: 18.5 },
};

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

const has = (p: PlayerWithStats, format: MatchFormat) => format === "T20" && !!p.stats.phases;
const sumOf = (l: PhaseLines, i: number) => l.pp[i] + l.mid[i] + l.death[i];

export const hasBattingPhases = (p: PlayerWithStats, format: MatchFormat) => has(p, format) && sumOf(p.stats.phases!, 1) >= MIN_BALLS;
export const hasBowlingPhases = (p: PlayerWithStats, format: MatchFormat) => has(p, format) && sumOf(p.stats.phases!, 3) >= MIN_BALLS;

/** The phase norm a player's own mix of balls would expect (weighted by balls in each phase). */
function expected(l: PhaseLines, ballsAt: number, key: "sr" | "bpo" | "econ" | "bpw"): number {
  const balls = sumOf(l, ballsAt);
  return PHASE_KEYS.reduce((s, k) => s + l[k][ballsAt] * T20_PHASE_NORM[k][key], 0) / balls;
}

/**
 * Multipliers that put a player's career numbers on an average phase mix: a finisher's strike
 * rate comes down, a death bowler's economy comes down, a middle-overs spinner's goes up.
 */
export function phaseMixFactors(p: PlayerWithStats, format: MatchFormat): { sr: number; bpo: number; econ: number; bpw: number } {
  const out = { sr: 1, bpo: 1, econ: 1, bpw: 1 };
  if (!has(p, format)) return out;
  const l = p.stats.phases!;
  const all = T20_PHASE_NORM.all;
  if (hasBattingPhases(p, format)) {
    out.sr = all.sr / expected(l, 1, "sr");
    out.bpo = all.bpo / expected(l, 1, "bpo");
  }
  if (hasBowlingPhases(p, format)) {
    out.econ = all.econ / expected(l, 3, "econ");
    out.bpw = all.bpw / expected(l, 3, "bpw");
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
    const relSr = batBalls ? (sumOf(l, 0) / batBalls) * 100 / expected(l, 1, "sr") : 1;
    const relOut = batBalls ? (sumOf(l, 2) / batBalls) * expected(l, 1, "bpo") : 1;
    const relEcon = bowlBalls ? ((sumOf(l, 4) / bowlBalls) * 6) / expected(l, 3, "econ") : 1;
    const relWkt = bowlBalls ? (sumOf(l, 5) / bowlBalls) * expected(l, 3, "bpw") : 1;
    for (const k of PHASE_KEYS) {
      const [runs, balls, outs, bBalls, bRuns, wkts] = l[k];
      const n = T20_PHASE_NORM[k];
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
