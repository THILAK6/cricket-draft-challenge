import type { MatchFormat } from "./types";
import type { InningsScorecard } from "./simulator";

/** Everything the results screen shows for one side, derived only from the simulated scorecards. */
export interface TeamPerformance {
  /** 0-100 scores. */
  battingScore: number;
  bowlingScore: number;
  fieldingScore: number;
  overallScore: number;
  stats: {
    runs: number;
    overs: string;
    runRate: number;
    strikeRate: number;
    fours: number;
    sixes: number;
    boundaryPct: number; // share of runs that came from boundaries
    fifties: number;
    hundreds: number;
    highestScore: { name: string; runs: number } | null;
    powerplayRuns: number;
    middleRuns: number;
    deathRuns: number;
    wicketsTaken: number;
    oversBowled: string;
    economy: number;
    bestBowler: { name: string; figures: string } | null;
    catches: number;
    runOuts: number;
    stumpings: number;
    droppedCatches: number;
  };
}

export interface MatchPerformance {
  USER: TeamPerformance;
  AI: TeamPerformance;
}

const PAR: Record<MatchFormat, { runsPerInnings: number; economy: number }> = {
  // Par values sit at what the match engine produces for an even contest, so 50 means "par".
  T20: { runsPerInnings: 125, economy: 6.1 },
  ODI: { runsPerInnings: 190, economy: 4.0 },
  TEST: { runsPerInnings: 200, economy: 2.6 },
};

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const oversToBalls = (o: string) => {
  const [w, b] = o.split(".").map(Number);
  return (w || 0) * 6 + (b || 0);
};
const ballsToOvers = (balls: number) => `${Math.floor(balls / 6)}.${balls % 6}`;

/**
 * @param batting  innings this side batted in
 * @param bowling  innings this side bowled in (the opponent's batting innings)
 */
function buildTeam(format: MatchFormat, batting: InningsScorecard[], bowling: InningsScorecard[]): TeamPerformance {
  const par = PAR[format];

  // ---- Batting -----------------------------------------------------------------------------
  const batters = batting.flatMap((i) => i.batters);
  const runs = batting.reduce((n, i) => n + i.totalRuns, 0);
  const balls = batting.reduce((n, i) => n + i.totalBalls, 0);
  const fours = batters.reduce((n, b) => n + b.fours, 0);
  const sixes = batters.reduce((n, b) => n + b.sixes, 0);
  const fifties = batters.filter((b) => b.runs >= 50 && b.runs < 100).length;
  const hundreds = batters.filter((b) => b.runs >= 100).length;
  const top = batters.reduce<{ name: string; runs: number } | null>((best, b) => (!best || b.runs > best.runs ? { name: b.name, runs: b.runs } : best), null);
  const batInnings = Math.max(1, batting.length);
  // Runs against a par score, with credit for big individual innings. Test scores are judged per innings.
  const battingScore = clamp(Math.round(50 * (runs / (par.runsPerInnings * batInnings)) + 4 * fifties + 8 * hundreds));

  // ---- Bowling -----------------------------------------------------------------------------
  const wicketsTaken = bowling.reduce(
    (n, i) => n + i.bowlers.reduce((m, b) => m + b.wickets, 0),
    0
  );
  const ballsBowled = bowling.reduce((n, i) => n + i.bowlers.reduce((m, b) => m + oversToBalls(b.overs), 0), 0);
  const runsConceded = bowling.reduce((n, i) => n + i.bowlers.reduce((m, b) => m + b.runs, 0), 0);
  const economy = ballsBowled > 0 ? runsConceded / (ballsBowled / 6) : 0;
  const bowlInnings = Math.max(1, bowling.length);
  // Up to 50 points for wickets (3 of 10 per innings earns nothing, all ten earns full marks)
  // and up to 50 for economy (par earns 25, a 40% tighter economy earns full marks).
  const wicketPart = 50 * clamp((wicketsTaken / (10 * bowlInnings) - 0.3) / 0.7, 0, 1);
  const econPart = economy > 0 ? 50 * clamp((par.economy / economy - 0.6) / 0.8, 0, 1) : 0;
  const bowlerRows = bowling.flatMap((i) => i.bowlers);
  const fiveFors = bowlerRows.filter((b) => b.wickets >= 5).length;
  const bowlingScore = clamp(Math.round(wicketPart + econPart + 4 * fiveFors));
  const bestRow = bowlerRows.reduce<(typeof bowlerRows)[number] | null>(
    (best, b) => (!best || b.wickets > best.wickets || (b.wickets === best.wickets && b.runs < best.runs) ? b : best),
    null
  );

  // ---- Fielding ----------------------------------------------------------------------------
  const fielders = bowling.flatMap((i) => i.fielders ?? []);
  const catches = fielders.reduce((n, f) => n + f.catches, 0);
  const runOuts = fielders.reduce((n, f) => n + f.runOuts, 0);
  const stumpings = fielders.reduce((n, f) => n + f.stumpings, 0);
  const droppedCatches = bowling.reduce((n, i) => n + (i.droppedCatches ?? 0), 0);
  const dismissals = Math.max(1, bowling.reduce((n, i) => n + i.totalWickets, 0));
  // Share of wickets that needed a fielder, weighted by difficulty, minus the chances put down.
  const fieldingScore = clamp(Math.round(40 + (catches * 2.5 + runOuts * 5 + stumpings * 4 - droppedCatches * 4) * (10 / dismissals) * 1.0));

  const overallScore = Math.round(battingScore * 0.4 + bowlingScore * 0.4 + fieldingScore * 0.2);

  return {
    battingScore,
    bowlingScore,
    fieldingScore,
    overallScore,
    stats: {
      runs,
      overs: ballsToOvers(balls),
      runRate: balls > 0 ? Math.round((runs / (balls / 6)) * 100) / 100 : 0,
      strikeRate: balls > 0 ? Math.round((runs / balls) * 1000) / 10 : 0,
      fours,
      sixes,
      boundaryPct: runs > 0 ? Math.round(((fours * 4 + sixes * 6) / runs) * 100) : 0,
      fifties,
      hundreds,
      highestScore: top,
      powerplayRuns: batting.reduce((n, i) => n + i.phaseRuns.powerplay, 0),
      middleRuns: batting.reduce((n, i) => n + i.phaseRuns.middle, 0),
      deathRuns: batting.reduce((n, i) => n + i.phaseRuns.death, 0),
      wicketsTaken,
      oversBowled: ballsToOvers(ballsBowled),
      economy: Math.round(economy * 100) / 100,
      bestBowler: bestRow ? { name: bestRow.name, figures: `${bestRow.wickets}/${bestRow.runs} (${bestRow.overs})` } : null,
      catches,
      runOuts,
      stumpings,
      droppedCatches,
    },
  };
}

export function computeMatchPerformance(
  format: MatchFormat,
  userInnings: InningsScorecard[],
  aiInnings: InningsScorecard[]
): MatchPerformance {
  const played = (i: InningsScorecard) => i.totalBalls > 0 || i.totalRuns > 0;
  const u = userInnings.filter(played);
  const a = aiInnings.filter(played);
  // The innings a side bowled in are the opponent's batting innings.
  return { USER: buildTeam(format, u, a), AI: buildTeam(format, a, u) };
}
