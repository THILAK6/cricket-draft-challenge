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
