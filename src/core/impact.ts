import type { MatchFormat } from "./types";
import type { InningsScorecard } from "./simulator";
import { ballsToOvers, oversToBalls } from "./overs";

export type Side = "USER" | "AI";

/**
 * One impact score per player, shared by Player of the Match, Best/Weakest pick and the
 * "decisive difference" text so they can never disagree. Everything is measured in runs against
 * what a typical side would have done:
 *  - batting: runs above what the balls faced would normally yield, plus a share of the chase
 *  - bowling: runs saved against par, plus wickets valued by the batter dismissed (an opener is
 *    worth far more than #11)
 *  - fielding: catches, run outs and stumpings
 */
export interface Contribution {
  team: Side;
  playerId: string;
  name: string;
  batImpact: number;
  bowlImpact: number;
  fieldImpact: number;
  impact: number;
  // batting line
  batted: boolean;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  notOut: boolean;
  // bowling line
  wickets: number;
  conceded: number;
  ballsBowled: number;
}

export const PAR_RPO: Record<MatchFormat, number> = { T20: 9.0, ODI: 5.6, TEST: 3.7 };
/** How much faster or slower than the format's par a pitch type scores. */
export const PITCH_PAR_FACTOR: Record<string, number> = { GREEN_SEAMER: 0.92, DUSTBOWL: 0.95, SLOW_LOW: 0.9, HIGH_SCORING_FLAT: 1.12 };
/** Tail-enders are not expected to keep pace: the balls they use are worth less against par. */
const SLOT_RATE = [1, 1, 1, 1, 1, 1, 0.8, 0.8, 0.6, 0.6, 0.6];

/**
 * Par run rate for this match: half the venue's par for the format, half what the two sides actually
 * scored, so a bowling-friendly day is not judged against a flat-track yardstick.
 */
export function matchParRpo(format: MatchFormat, pitch: string | undefined, innings: { totalRuns: number; totalBalls: number }[]): number {
  const venue = PAR_RPO[format] * (pitch ? PITCH_PAR_FACTOR[pitch] ?? 1 : 1);
  const balls = innings.reduce((n, i) => n + i.totalBalls, 0);
  const runs = innings.reduce((n, i) => n + i.totalRuns, 0);
  return balls >= 60 ? 0.5 * venue + 0.5 * ((runs / balls) * 6) : venue;
}
const PAR_TOTAL: Record<MatchFormat, number> = { T20: 165, ODI: 260, TEST: 245 };
// Share of a typical innings total scored from each batting position (sums to 1)
const SLOT_SHARE = [0.17, 0.17, 0.15, 0.13, 0.11, 0.09, 0.07, 0.05, 0.03, 0.02, 0.01];

/** Runs a batter at this position would normally add: what a dismissal there takes away. */
export const expectedRunsAtSlot = (format: MatchFormat, slot: number): number =>
  (SLOT_SHARE[Math.min(slot, 10)] ?? 0.01) * PAR_TOTAL[format];

const wicketValue = (format: MatchFormat, slot: number, runsMade: number): number =>
  5 + 0.35 * expectedRunsAtSlot(format, slot) + (runsMade < 5 ? 2 : 0);

export interface ContributionInput {
  format: MatchFormat;
  userInnings: InningsScorecard[];
  aiInnings: InningsScorecard[];
  winner: "USER" | "AI" | "TIE" | "DRAW";
  /** Limited overs only: which side chased and what it had to reach. */
  chase?: { team: Side; target: number };
  /** Pitch type, for the venue par. */
  pitch?: string;
}

export function computeContributions(input: ContributionInput): Contribution[] {
  const { format, winner, chase } = input;
  const rpo = matchParRpo(format, input.pitch, [...input.userInnings, ...input.aiInnings]);
  const map = new Map<string, Contribution>();
  const get = (team: Side, playerId: string, name: string): Contribution => {
    const key = `${team}:${playerId}`;
    let c = map.get(key);
    if (!c) {
      c = {
        team, playerId, name, batImpact: 0, bowlImpact: 0, fieldImpact: 0, impact: 0,
        batted: false, runs: 0, balls: 0, fours: 0, sixes: 0, notOut: false,
        wickets: 0, conceded: 0, ballsBowled: 0,
      };
      map.set(key, c);
    }
    return c;
  };

  const sides: { team: Side; bat: InningsScorecard[]; bowl: InningsScorecard[] }[] = [
    { team: "USER", bat: input.userInnings, bowl: input.aiInnings },
    { team: "AI", bat: input.aiInnings, bowl: input.userInnings },
  ];

  for (const { team, bat, bowl } of sides) {
    const opp: Side = team === "USER" ? "AI" : "USER";
    // Batting: the scorecard lists batters in the order they actually came in
    for (const inn of bat) {
      inn.batters.forEach((b) => {
        if (!(b.balls > 0 || b.isOut)) return;
        const c = get(team, b.playerId, b.name);
        c.batted = true;
        c.runs += b.runs;
        c.balls += b.balls;
        c.fours += b.fours;
        c.sixes += b.sixes;
        if (!b.isOut) c.notOut = true;
        // Runs, less everything the balls faced would normally have produced (tail-enders are held to a lower rate).
        const slot = inn.batters.indexOf(b);
        const exp = expectedRunsAtSlot(format, slot);
        let v = b.runs - ((b.balls * rpo) / 6) * (SLOT_RATE[Math.min(slot, 10)] ?? 0.6);
        if (b.isOut && b.runs < 0.4 * exp) v -= (0.4 * exp - b.runs) * 0.6; // an early dismissal costs the side
        if (b.runs >= 100) v += 30;
        else if (b.runs >= 50) v += 10;
        if (chase && chase.team === team && winner === team) {
          v += (b.runs / Math.max(1, chase.target)) * 20; // a share of the chase
          if (!b.isOut) v += 5; // finished the job
        }
        c.batImpact += v;
      });
      // Credit each wicket to its bowler, valued by who was dismissed
      inn.batters.forEach((b, slot) => {
        if (!b.isOut || !b.bowlerId) return;
        const bowlerName = inn.bowlers.find((x) => x.playerId === b.bowlerId)?.name ?? "Bowler";
        const bc = get(opp, b.bowlerId, bowlerName);
        bc.bowlImpact += wicketValue(format, slot, b.runs);
      });
      // A dropped catch costs the fielder in proportion to what the reprieved batter went on to make
      for (const d of inn.drops ?? []) {
        if (!d.fielderId) continue;
        const fc = get(opp, d.fielderId, d.fielder);
        fc.fieldImpact -= 2 + 0.7 * (d.reprieveRuns ?? 0);
      }
      for (const f of inn.fielders ?? []) {
        const fc = get(opp, f.playerId, f.name);
        fc.fieldImpact += f.catches * 8 + f.runOuts * 12 + f.stumpings * 10;
      }
    }
    // Bowling lines (the opponent's innings are this side's bowling innings)
    for (const inn of bowl) {
      for (const b of inn.bowlers) {
        const c = get(team, b.playerId, b.name);
        const balls = oversToBalls(b.overs);
        c.ballsBowled += balls;
        c.wickets += b.wickets;
        c.conceded += b.runs;
        c.bowlImpact += (balls / 6) * rpo - b.runs;
      }
    }
  }

  const out = [...map.values()];
  for (const c of out) c.impact = c.batImpact + c.bowlImpact + c.fieldImpact;
  return out;
}

/** Best contribution for a side, optionally restricted to batting or bowling. */
export function topContribution(list: Contribution[], team: Side, by: "impact" | "bat" | "bowl" = "impact"): Contribution | undefined {
  const score = (c: Contribution) => (by === "bat" ? c.batImpact : by === "bowl" ? c.bowlImpact : c.impact);
  return list
    .filter((c) => c.team === team && (by === "bat" ? c.batted : by === "bowl" ? c.ballsBowled > 0 : true))
    .sort((a, b) => score(b) - score(a))[0];
}

/** "79* off 38" / "4/34 (2.4 ov)" for the part of the game that mattered most. */
export function describeContribution(c: Contribution): string {
  const bat = c.batted ? `${c.runs}${c.notOut ? "*" : ""} off ${c.balls}` : "";
  const bowl = c.ballsBowled > 0 ? `${c.wickets}/${c.conceded} (${ballsToOvers(c.ballsBowled)} ov)` : "";
  if (bat && bowl) return c.batImpact >= c.bowlImpact ? `${bat}, ${bowl}` : `${bowl}, ${bat}`;
  return bat || bowl || "all-round contribution";
}
