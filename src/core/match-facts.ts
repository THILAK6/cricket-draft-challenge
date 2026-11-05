import type { MatchFormat, PlayerWithStats } from "./types";
import type { InningsScorecard } from "./simulator";
import { computeContributions, describeContribution, type Contribution, type Side } from "./impact";
import { phasesReached, collapsedEarly, comparablePhases, findWicketCluster, PHASE_BOUNDS, type PhasesReached } from "./phases";

/**
 * The single source of truth for the match report. Built once from the scorecard, before any
 * narrative is written; every section (awards, turning points, decisive difference, picks, tactics,
 * team report) reads from it and no section computes its own version of a fact.
 */
export type BowlerType = "SEAM" | "SPIN" | "PART_TIME";

export interface PlayerFact {
  team: Side;
  playerId: string;
  name: string;
  /** Position in the XI as drafted (0-based). */
  lineupPos: number;
  /** Position actually batted at, first innings batted (0-based); -1 = did not bat. */
  battingPos: number;
  dismissal: string | null;
  notOut: boolean;
  ballsBowled: number;
  bowlerType: BowlerType;
}

export interface SideFacts {
  reached: PhasesReached;
  runs: number;
  wickets: number;
  balls: number;
  allOut: boolean;
  /** Bowled out well before the overs were up (or, in Tests, never applies). */
  collapsed: boolean;
  /** 5+ wickets for very few runs, even if the side was not bowled out. */
  cluster: { fromWicket: number; toWicket: number; runs: number; startScore: number; endScore: number } | null;
  phaseRuns: { powerplay: number; middle: number; death: number };
}

export interface VenueTraits {
  seam: boolean;
  spin: boolean;
  flat: boolean;
  slow: boolean;
}

export interface Award {
  name: string;
  team: Side;
  impact: number;
  line: string;
}

export interface MatchFacts {
  format: MatchFormat;
  winner: Side | "TIE" | "DRAW";
  contributions: Contribution[];
  players: PlayerFact[];
  sides: Record<Side, SideFacts>;
  /** Phases that BOTH sides batted in: the only ones that can be compared. */
  commonPhases: PhasesReached;
  margin: { type: "runs" | "wickets" | "innings" | "none"; size: number; tier: "narrow" | "clear" | "dominant" | "none" };
  venue: VenueTraits;
  awards: { playerOfMatch: Award | null; bestPick: Award | null; weakestPick: Award | null };
}

export interface FactsInput {
  format: MatchFormat;
  winner: Side | "TIE" | "DRAW";
  userInnings: InningsScorecard[];
  aiInnings: InningsScorecard[];
  userSquad: (PlayerWithStats | null)[];
  aiSquad: (PlayerWithStats | null)[];
  pitch: string;
  chase?: { team: Side; target: number };
  contributions?: Contribution[];
}

export function bowlerTypeOf(p: PlayerWithStats, format: MatchFormat): BowlerType {
  const need = format === "TEST" ? 40 : 25;
  const frontline = p.primary_role === "BOWL" || (p.primary_role === "AR" && p.stats.bowl_wickets >= need);
  if (!frontline) return "PART_TIME";
  return p.bowling_category === "SPIN" ? "SPIN" : "SEAM";
}

export const venueTraits = (pitch: string): VenueTraits => ({
  seam: pitch === "GREEN_SEAMER",
  spin: pitch === "DUSTBOWL",
  flat: pitch === "HIGH_SCORING_FLAT",
  slow: pitch === "SLOW_LOW",
});

const sumPhase = (inns: InningsScorecard[], k: "powerplay" | "middle" | "death") =>
  inns.reduce((n, i) => n + (i.phaseRuns?.[k] ?? 0), 0);

/** Player of the Match, Best Pick and Weakest Pick, all ranked by the one impact score. */
export function computeAwards(
  contribs: Contribution[],
  winner: Side | "TIE" | "DRAW"
): { playerOfMatch: Award | null; bestPick: Award | null; weakestPick: Award | null } {
  const mk = (c: Contribution | undefined): Award | null =>
    c ? { name: c.name, team: c.team, impact: c.impact, line: describeContribution(c) } : null;
  const potmPool = winner === "USER" || winner === "AI" ? contribs.filter((c) => c.team === winner) : contribs;
  const potm = [...potmPool].sort((a, b) => b.impact - a.impact)[0];

  const user = contribs.filter((c) => c.team === "USER" && (c.batted || c.ballsBowled > 0));
  const ranked = [...user].sort((a, b) => b.impact - a.impact);
  const best = ranked[0];
  // Weakest = lowest impact, and only someone who really fell short; never a player with a positive impact
  const worst = ranked[ranked.length - 1];
  return {
    playerOfMatch: mk(potm),
    bestPick: best && best.impact >= 10 ? mk(best) : null,
    weakestPick: worst && worst !== best && worst.impact <= -8 ? mk(worst) : null,
  };
}

export function buildMatchFacts(input: FactsInput): MatchFacts {
  const { format, winner, userInnings, aiInnings } = input;
  const contributions =
    input.contributions ?? computeContributions({ format, userInnings, aiInnings, winner, chase: input.chase, pitch: input.pitch });

  const sideFacts = (batting: InningsScorecard[]): SideFacts => {
    const lim = format !== "TEST";
    const cluster = batting.map((i) => findWicketCluster(format, i.fallOfWickets)).find((c) => c) ?? null;
    const collapsed = lim && (batting.some((i) => collapsedEarly(format, i)) || cluster !== null);
    return {
      reached: phasesReached(format, batting),
      runs: batting.reduce((n, i) => n + i.totalRuns, 0),
      wickets: batting.reduce((n, i) => n + i.totalWickets, 0),
      balls: batting.reduce((n, i) => n + i.totalBalls, 0),
      allOut: batting.some((i) => i.totalWickets >= 10),
      cluster,
      collapsed,
      phaseRuns: { powerplay: sumPhase(batting, "powerplay"), middle: sumPhase(batting, "middle"), death: sumPhase(batting, "death") },
    };
  };
  const sides = { USER: sideFacts(userInnings), AI: sideFacts(aiInnings) };
  // Comparable = both sides faced at least half of the phase's balls
  const commonPhases: PhasesReached =
    userInnings[0] && aiInnings[0]
      ? comparablePhases(format, { totalBalls: sides.USER.balls }, { totalBalls: sides.AI.balls })
      : { powerplay: false, middle: false, death: false };

  const players: PlayerFact[] = [];
  const addSide = (team: Side, squad: (PlayerWithStats | null)[], batting: InningsScorecard[], bowling: InningsScorecard[]) => {
    const lineup = squad.filter((p): p is PlayerWithStats => p !== null);
    lineup.forEach((p, lineupPos) => {
      let battingPos = -1;
      let dismissal: string | null = null;
      let notOut = false;
      for (const inn of batting) {
        const i = inn.batters.findIndex((b) => b.playerId === p.id);
        if (i < 0) continue;
        const b = inn.batters[i];
        if (!(b.balls > 0 || b.isOut)) continue;
        if (battingPos < 0) battingPos = i;
        dismissal = b.isOut ? b.dismissal ?? null : dismissal;
        if (!b.isOut) notOut = true;
      }
      let ballsBowled = 0;
      for (const inn of bowling) {
        const bw = inn.bowlers.find((x) => x.playerId === p.id);
        if (bw) {
          const [o, b] = bw.overs.split(".").map(Number);
          ballsBowled += (o || 0) * 6 + (b || 0);
        }
      }
      players.push({ team, playerId: p.id, name: p.name, lineupPos, battingPos, dismissal, notOut, ballsBowled, bowlerType: bowlerTypeOf(p, format) });
    });
  };
  addSide("USER", input.userSquad, userInnings, aiInnings);
  addSide("AI", input.aiSquad, aiInnings, userInnings);

  return {
    format,
    winner,
    contributions,
    players,
    sides,
    commonPhases,
    margin: computeMargin(format, winner, sides, input.chase, userInnings, aiInnings),
    venue: venueTraits(input.pitch),
    awards: computeAwards(contributions, winner),
  };
}

function computeMargin(
  format: MatchFormat,
  winner: Side | "TIE" | "DRAW",
  sides: Record<Side, SideFacts>,
  chase: { team: Side; target: number } | undefined,
  userInnings: InningsScorecard[],
  aiInnings: InningsScorecard[]
): MatchFacts["margin"] {
  if (winner !== "USER" && winner !== "AI") return { type: "none", size: 0, tier: "none" };
  const loser: Side = winner === "USER" ? "AI" : "USER";
  if (format === "TEST") {
    const diff = sides[winner].runs - sides[loser].runs;
    const winnerInns = winner === "USER" ? userInnings : aiInnings;
    const inningsWin = winnerInns.length === 2 && sides[loser].allOut && winnerInns.length > (winner === "USER" ? aiInnings : userInnings).length;
    return { type: "runs", size: diff, tier: diff >= 250 || inningsWin ? "dominant" : diff >= 80 ? "clear" : "narrow" };
  }
  const bounds = PHASE_BOUNDS[format];
  if (chase && winner === chase.team) {
    const inn = (winner === "USER" ? userInnings : aiInnings)[0];
    const wkts = 10 - (inn?.totalWickets ?? 0);
    const left = bounds.maxBalls - (inn?.totalBalls ?? bounds.maxBalls);
    return { type: "wickets", size: wkts, tier: wkts >= 8 || left >= bounds.maxBalls * 0.3 ? "dominant" : wkts >= 5 && left >= bounds.maxBalls * 0.05 ? "clear" : "narrow" };
  }
  const diff = sides[winner].runs - sides[loser].runs;
  const rel = diff / Math.max(1, sides[winner].runs);
  return { type: "runs", size: diff, tier: rel >= 0.35 || sides[loser].collapsed ? "dominant" : rel >= 0.12 ? "clear" : "narrow" };
}

// ---------------------------------------------------------------------------------------------
// Claim checking
// ---------------------------------------------------------------------------------------------

export interface TacticClaim {
  text: string;
  side: "Your XI" | "AI XI";
  kind: string;
  playerId?: string;
}

/**
 * Every tactical claim is checked against the scorecard. A claim that does not hold is dropped; a call
 * that was a poor idea for the venue is flagged rather than reported as "as planned".
 */
export function checkTacticClaims(claims: TacticClaim[], facts: MatchFacts): string[] {
  const out: string[] = [];
  for (const c of claims) {
    const team: Side = c.side === "Your XI" ? "USER" : "AI";
    const pf = c.playerId ? facts.players.find((p) => p.team === team && p.playerId === c.playerId) : undefined;
    if (c.kind === "promo") {
      // Promoted means he batted higher than his drafted slot
      if (!pf || pf.battingPos < 0 || pf.battingPos >= pf.lineupPos) continue;
      out.push(c.text);
      continue;
    }
    if (c.kind === "plan" || c.kind === "open") {
      if (pf && pf.bowlerType === "PART_TIME") {
        out.push(`${c.side}: ${pf.name} (part-time) opened the bowling, a risky call.`);
        continue;
      }
      if (pf && pf.bowlerType === "SPIN" && facts.venue.seam && c.kind === "plan") {
        out.push(`${c.side}: ${pf.name} (spin) opened on a green seamer, a poor call for the surface.`);
        continue;
      }
    }
    out.push(c.text);
  }
  return out;
}

/** True when a phase comparison between the sides is fair (both batted in it). */
export const canComparePhase = (facts: MatchFacts, phase: keyof PhasesReached): boolean => facts.commonPhases[phase];
