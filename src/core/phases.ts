import type { MatchFormat } from "./types";

/** The one place that decides which phases of a limited-overs innings a side actually batted in. */
export interface PhasesReached {
  powerplay: boolean;
  middle: boolean;
  death: boolean;
}

export const PHASE_BOUNDS: Record<"T20" | "ODI", { ppBalls: number; deathStartBalls: number; maxBalls: number }> = {
  T20: { ppBalls: 36, deathStartBalls: 90, maxBalls: 120 },
  ODI: { ppBalls: 60, deathStartBalls: 240, maxBalls: 300 },
};

export function phasesReached(format: MatchFormat, innings: { totalBalls: number }[]): PhasesReached {
  if (format === "TEST") return { powerplay: innings.length > 0, middle: innings.length > 0, death: innings.length > 0 };
  const b = PHASE_BOUNDS[format];
  return {
    powerplay: innings.some((i) => i.totalBalls > 0),
    middle: innings.some((i) => i.totalBalls > b.ppBalls),
    death: innings.some((i) => i.totalBalls > b.deathStartBalls),
  };
}

/** A side bowled out well before its overs were up: the story of that innings is the collapse. */
export function collapsedEarly(format: MatchFormat, inn: { totalBalls: number; totalWickets: number }): boolean {
  if (format === "TEST") return false;
  return inn.totalWickets >= 10 && inn.totalBalls < PHASE_BOUNDS[format].maxBalls * 0.8;
}

const PHASE_SPANS: Record<"T20" | "ODI", Record<keyof PhasesReached, [number, number]>> = {
  T20: { powerplay: [0, 36], middle: [36, 90], death: [90, 120] },
  ODI: { powerplay: [0, 60], middle: [60, 240], death: [240, 300] },
};

/** Balls an innings of this length faced inside a phase. */
export function phaseBallsFaced(format: MatchFormat, totalBalls: number, phase: keyof PhasesReached): number {
  if (format === "TEST") return totalBalls;
  const [from, to] = PHASE_SPANS[format][phase];
  return Math.max(0, Math.min(to, totalBalls) - from);
}

/** Phases both innings faced at least half the balls of: the only ones a fair comparison can use. */
export function comparablePhases(format: MatchFormat, a: { totalBalls: number }, b: { totalBalls: number }): PhasesReached {
  if (format === "TEST") return { powerplay: true, middle: true, death: true };
  const ok = (phase: keyof PhasesReached) => {
    const [from, to] = PHASE_SPANS[format][phase];
    const half = (to - from) / 2;
    return phaseBallsFaced(format, a.totalBalls, phase) >= half && phaseBallsFaced(format, b.totalBalls, phase) >= half;
  };
  return { powerplay: ok("powerplay"), middle: ok("middle"), death: ok("death") };
}

/** Run rate scored inside a phase. */
export function phaseRunRate(format: MatchFormat, inn: { totalBalls: number; phaseRuns: Record<keyof PhasesReached, number> }, phase: keyof PhasesReached): number {
  const balls = phaseBallsFaced(format, inn.totalBalls, phase);
  return balls > 0 ? (inn.phaseRuns[phase] / balls) * 6 : 0;
}

const CLUSTER_RUNS: Record<MatchFormat, number> = { T20: 20, ODI: 30, TEST: 30 };

/**
 * A run of 5 wickets for few runs, whether or not the side was finally bowled out.
 * Uses the score at each fall of wicket.
 */
export function findWicketCluster(
  format: MatchFormat,
  fall: { wicket: number; runs: number }[] | undefined
): { fromWicket: number; toWicket: number; runs: number; startScore: number; endScore: number } | null {
  if (!fall || fall.length < 5) return null;
  const limit = CLUSTER_RUNS[format];
  let best: ReturnType<typeof findWicketCluster> = null;
  for (let i = 0; i + 4 < fall.length; i++) {
    const before = i === 0 ? 0 : fall[i - 1].runs;
    const runs = fall[i + 4].runs - before;
    if (runs <= limit && (!best || runs < best.runs)) {
      best = { fromWicket: fall[i].wicket, toWicket: fall[i + 4].wicket, runs, startScore: before, endScore: fall[i + 4].runs };
    }
  }
  return best;
}
