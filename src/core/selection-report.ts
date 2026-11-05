import type { Challenge, PlayerWithStats } from "./types";
import type { InningsScorecard } from "./simulator";
import type { MatchPerformance } from "./performance";
import { calculateDeterministicScore } from "./scoring";
import { playerQuality } from "./player-quality";
import { computeAwards } from "./match-facts";
import { computeContributions, PAR_RPO, type Contribution } from "./impact";
import { ballsToOvers } from "./overs";

/**
 * "Did the XI you picked deserve to win?" This game is about selecting a better and more balanced
 * eleven, so the result is explained through the picks first: how each squad scored on role balance,
 * pitch fit, player quality and batting depth, and which picks did (or did not) deliver on the day.
 */

type Side = "USER" | "AI";
type Squad = (PlayerWithStats | null)[];

export interface SelectionPoint {
  tone: "good" | "bad";
  text: string;
}

export interface SelectionCategory {
  key: "role" | "pitch" | "quality" | "depth";
  label: string;
  user: number;
  ai: number;
  max: number;
}

export interface PickHighlight {
  name: string;
  slot: number;
  detail: string;
}

export interface SelectionReport {
  headline: string;
  /** Who had the better XI on paper, by selection score. */
  paperEdge: Side | "EVEN";
  totals: { USER: number; AI: number };
  /** Whether the result followed the selection. */
  outcome: "PICKS_DECIDED" | "UPSET" | "CLOSE" | "LEVEL";
  categories: SelectionCategory[];
  userPoints: SelectionPoint[];
  aiPoints: SelectionPoint[];
  bestPick: PickHighlight | null;
  weakestPick: PickHighlight | null;
  nextTime: string[];
}

export interface SelectionInput {
  userSquad: Squad;
  aiSquad: Squad;
  challenge: Challenge;
  winner: "USER" | "AI" | "TIE" | "DRAW";
  /** Innings each side batted in. */
  userInnings: InningsScorecard[];
  aiInnings: InningsScorecard[];
  performance: MatchPerformance;
  /** Shared impact scores (same ones behind Player of the Match). Computed here when omitted. */
  facts?: import("./match-facts").MatchFacts;
  contributions?: Contribution[];
  /** Limited overs: the chasing side and its target. */
  chase?: { team: Side; target: number };
}

const PITCH_LABEL: Record<string, string> = {
  GREEN_SEAMER: "green seamer",
  DUSTBOWL: "dustbowl",
  HIGH_SCORING_FLAT: "flat batting track",
  SLOW_LOW: "slow, low pitch",
};

const PITCH_HINT: Record<string, string> = {
  GREEN_SEAMER: "it rewards three or more seamers",
  DUSTBOWL: "it rewards two or three spinners",
  HIGH_SCORING_FLAT: "it rewards hard hitters and economical bowlers, and seam vs spin matters little",
  SLOW_LOW: "it rewards spinners and accurate bowlers",
};

const players = (s: Squad) => s.filter((p): p is PlayerWithStats => p !== null);
const isBowlingOption = (p: PlayerWithStats) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Profile {
  squad: Squad;
  all: PlayerWithStats[];
  pacers: number;
  spinners: number;
  bowlingOptions: number;
  frontline: number;
  /** Mean batting average of the top seven. */
  topSevenAvg: number;
  /** Mean bowling economy (limited overs) or average (Tests) of the frontline bowlers. */
  attackMetric: number;
  /** Players meeting the same pitch thresholds the selection score uses. */
  hitters: number;
  controlBowlers: number;
  accurateBowlers: number;
  /** Mean stats-only rating of the XI and its three highest-rated picks. */
  avgRating: number;
  topPicks: string[];
}

function profile(squad: Squad, format: string): Profile {
  const isTest = format === "TEST";
  const all = players(squad);
  const rated = all.map((p) => ({ p, q: playerQuality(p, format) })).sort((a, b) => b.q - a.q);
  const bowlers = all.filter((p) => p.primary_role === "BOWL" || p.primary_role === "AR");
  const metric = bowlers
    .map((p) => (isTest ? p.stats.bowl_average : p.stats.bowl_economy))
    .filter((v) => v > 0);
  const t20 = format === "T20";
  const test = format === "TEST";
  const hitSr = t20 ? 135 : test ? 55 : 92;
  const controlEcon = t20 ? 7.5 : test ? 3.0 : 5.0;
  const accurateEcon = t20 ? 7.2 : test ? 2.8 : 4.9;
  return {
    squad,
    all,
    hitters: all.filter((p) => p.stats.bat_strike_rate >= hitSr).length,
    controlBowlers: all.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= controlEcon).length,
    accurateBowlers: all.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= accurateEcon).length,
    pacers: bowlers.filter((p) => p.bowling_category === "PACE").length,
    spinners: bowlers.filter((p) => p.bowling_category === "SPIN").length,
    bowlingOptions: all.filter(isBowlingOption).length,
    frontline: bowlers.length,
    topSevenAvg: mean(squad.slice(0, 7).filter((p): p is PlayerWithStats => p !== null && p.stats.bat_innings > 0).map((p) => p.stats.bat_average)),
    attackMetric: mean(metric),
    avgRating: mean(rated.map((r) => r.q)),
    topPicks: rated.slice(0, 3).map((r) => r.p.name),
  };
}

/** The squad traits the pitch-fit score actually rewards on this surface, in words. */
function pitchTraits(p: Profile, pitch: string): string {
  switch (pitch) {
    case "GREEN_SEAMER":
      return `${p.pacers} seam option${p.pacers === 1 ? "" : "s"}`;
    case "DUSTBOWL":
      return `${p.spinners} spin option${p.spinners === 1 ? "" : "s"}`;
    case "HIGH_SCORING_FLAT":
      return `${p.hitters} hard hitter${p.hitters === 1 ? "" : "s"} and ${p.controlBowlers} economical bowler${p.controlBowlers === 1 ? "" : "s"}`;
    case "SLOW_LOW":
      return `${p.spinners} spinner${p.spinners === 1 ? "" : "s"} and ${p.accurateBowlers} accurate bowler${p.accurateBowlers === 1 ? "" : "s"}`;
    default:
      return `${p.pacers} seam and ${p.spinners} spin options`;
  }
}

/** Concrete composition problems that cost role-balance points. */
function roleIssues(p: Profile, format: string): string[] {
  const issues: string[] = [];
  if (!p.all.some((x) => x.primary_role === "WK")) issues.push("no wicketkeeper");
  if (p.bowlingOptions < 5) issues.push(`only ${p.bowlingOptions} bowling option${p.bowlingOptions === 1 ? "" : "s"}`);
  else if (format !== "TEST" && p.bowlingOptions < 6) issues.push("a thin five-man attack with no spare bowler");
  for (let i = 0; i < 2; i++) {
    const o = p.squad[i];
    if (o && o.primary_role === "BOWL") issues.push(`${o.name} (a bowler) opening the batting`);
    else if (o && o.primary_role !== "WK" && o.stats.top_order_innings < 6 && o.stats.top_order_innings < o.stats.middle_order_innings) {
      issues.push(`${o.name} at #${i + 1} is a middle-order player`);
    }
  }
  for (let i = 2; i < 5; i++) {
    const o = p.squad[i];
    if (o && o.primary_role === "BOWL") issues.push(`${o.name} (a bowler) at #${i + 1}`);
  }
  if (format !== "TEST") {
    const finisher = p.squad.slice(4, 7).some((x) => x && (x.stats.finisher_innings >= 6 || (x.primary_role === "AR" && x.stats.bat_strike_rate >= (format === "T20" ? 135 : 95))));
    if (!finisher && p.all.length >= 7) issues.push("no genuine finisher at #5-#7");
  }
  const hands = p.squad.slice(0, 6).filter((x): x is PlayerWithStats => x !== null);
  if (hands.length >= 4 && !(hands.some((x) => x.batting_hand === "LHB") && hands.some((x) => x.batting_hand === "RHB"))) {
    issues.push("a top six with no left/right mix");
  }
  return issues;
}

interface PlayerImpact {
  player: PlayerWithStats;
  slot: number;
  runs: number;
  balls: number;
  notOut: boolean;
  batted: boolean;
  wickets: number;
  conceded: number;
  overs: number;
  ballsBowled: number;
  catches: number;
  runOuts: number;
  stumpings: number;
  impact: number;
}

/** Per-player rows for one side, taking the shared impact score from computeContributions. */
function impacts(squad: Squad, side: Side, contribs: Contribution[]): PlayerImpact[] {
  const out: PlayerImpact[] = [];
  squad.forEach((p, slot) => {
    if (!p) return;
    const c = contribs.find((x) => x.team === side && x.playerId === p.id);
    out.push({
      player: p,
      slot,
      runs: c?.runs ?? 0,
      notOut: c?.notOut ?? false,
      balls: c?.balls ?? 0,
      batted: c?.batted ?? false,
      wickets: c?.wickets ?? 0,
      conceded: c?.conceded ?? 0,
      overs: (c?.ballsBowled ?? 0) / 6,
      ballsBowled: c?.ballsBowled ?? 0,
      catches: 0,
      runOuts: 0,
      stumpings: 0,
      impact: c?.impact ?? 0,
    });
  });
  return out;
}

function describe(i: PlayerImpact): string {
  const parts: string[] = [];
  if (i.batted) parts.push(`${i.runs}${i.notOut ? "*" : ""} off ${i.balls}`);
  if (i.overs > 0) parts.push(`${i.wickets}/${i.conceded} in ${ballsToOvers(i.ballsBowled)} ov`);
  const field = i.catches + i.runOuts + i.stumpings;
  if (field > 0) parts.push(`${field} dismissal${field === 1 ? "" : "s"} in the field`);
  return parts.join(", ") || "did not get involved";
}

function lowerOrderRuns(innings: InningsScorecard[]): number {
  return innings.reduce((n, inn) => n + inn.batters.slice(6).reduce((m, b) => m + b.runs, 0), 0);
}

export function buildSelectionReport(input: SelectionInput): SelectionReport {
  const { userSquad, aiSquad, challenge, winner, userInnings, aiInnings, performance } = input;
  const format = challenge.format || "T20";
  const pitch = challenge.venue.pitch_type;
  const pitchLabel = PITCH_LABEL[pitch] ?? pitch.toLowerCase().replace(/_/g, " ");

  const scores = {
    USER: calculateDeterministicScore(userSquad, challenge),
    AI: calculateDeterministicScore(aiSquad, challenge),
  };
  const prof = { USER: profile(userSquad, format), AI: profile(aiSquad, format) };
  const contribs = input.contributions ?? computeContributions({ format: format as "T20" | "ODI" | "TEST", userInnings, aiInnings, winner, chase: input.chase });
  const imp = {
    USER: impacts(userSquad, "USER", contribs),
    AI: impacts(aiSquad, "AI", contribs),
  };

  const categories: SelectionCategory[] = [
    { key: "role", label: "Role balance", user: scores.USER.role_balance_score, ai: scores.AI.role_balance_score, max: 25 },
    { key: "pitch", label: "Pitch fit", user: scores.USER.pitch_suitability_score, ai: scores.AI.pitch_suitability_score, max: 25 },
    { key: "quality", label: "Player quality", user: scores.USER.player_quality_score, ai: scores.AI.player_quality_score, max: 35 },
    { key: "depth", label: "Batting depth", user: scores.USER.batting_depth_score, ai: scores.AI.batting_depth_score, max: 15 },
  ];
  const totals = { USER: scores.USER.deterministic_total, AI: scores.AI.deterministic_total };
  const margin = totals.USER - totals.AI;
  const paperEdge: Side | "EVEN" = margin >= 3 ? "USER" : margin <= -3 ? "AI" : "EVEN";

  // ---- Reasons, per side, each with a weight so the strongest few are shown -------------------
  const reasons: Record<Side, (SelectionPoint & { weight: number })[]> = { USER: [], AI: [] };
  const add = (side: Side, tone: "good" | "bad", weight: number, text: string) => reasons[side].push({ tone, weight, text });

  const other = (s: Side): Side => (s === "USER" ? "AI" : "USER");
  const who = (s: Side) => (s === "USER" ? "your" : "the AI's");
  const cat = (key: SelectionCategory["key"]) => categories.find((c) => c.key === key)!;
  const catFor = (c: SelectionCategory, s: Side) => (s === "USER" ? c.user : c.ai);

  for (const side of ["USER", "AI"] as Side[]) {
    const opp = other(side);
    const me = prof[side];
    const them = prof[opp];

    // Pitch fit
    const pitchDiff = catFor(cat("pitch"), side) - catFor(cat("pitch"), opp);
    const mine = pitchTraits(me, pitch);
    if (pitchDiff >= 3) add(side, "good", pitchDiff + 2, `The squad suited the ${pitchLabel}: ${mine}, against ${pitchTraits(them, pitch)}.`);
    else if (pitchDiff <= -3) add(side, "bad", -pitchDiff + 2, `The squad was a poorer fit for the ${pitchLabel}: ${mine} (${PITCH_HINT[pitch] ?? "conditions matter"}).`);

    // Role balance
    const roleDiff = catFor(cat("role"), side) - catFor(cat("role"), opp);
    const issues = roleIssues(me, format);
    if (roleDiff <= -3 && issues.length) add(side, "bad", -roleDiff + 3, `The XI was unbalanced: ${issues.slice(0, 3).join(", ")}.`);
    else if (roleDiff >= 3) add(side, "good", roleDiff + 2, `A well-balanced XI: a keeper, ${me.bowlingOptions} bowling options and proper openers.`);
    else if (issues.length >= 2) add(side, "bad", 3, `Selection gaps: ${issues.slice(0, 2).join(" and ")}.`);

    // Player quality: judged on the same stats-only rating the drafting AI uses, so the numbers
    // always point the same way as the score they explain.
    const qDiff = catFor(cat("quality"), side) - catFor(cat("quality"), opp);
    if (Math.abs(qDiff) >= 3) {
      const rating = `average pick rating ${Math.round(me.avgRating)} against ${Math.round(them.avgRating)}`;
      if (qDiff > 0) add(side, "good", qDiff + 1, `Higher-rated players on career numbers (${rating}), led by ${me.topPicks.slice(0, 2).join(" and ")}.`);
      else add(side, "bad", -qDiff + 1, `Lower-rated picks on career numbers (${rating}). The opposition's top-rated were ${them.topPicks.slice(0, 2).join(" and ")}.`);
    }

    // Batting depth, backed by what the lower order actually scored
    const dDiff = catFor(cat("depth"), side) - catFor(cat("depth"), opp);
    const myBat = side === "USER" ? userInnings : aiInnings;
    const theirBat = side === "USER" ? aiInnings : userInnings;
    const lo = lowerOrderRuns(myBat);
    const loOpp = lowerOrderRuns(theirBat);
    // Only talk about the tail if both tails actually came to the crease
    const tailBatted = (inns: InningsScorecard[]) => inns.some((inn) => inn.batters.slice(6).some((b) => b.balls > 0 || b.isOut));
    const bothTails = tailBatted(myBat) && tailBatted(theirBat);
    if (!bothTails) {
      // no comparison possible
    } else if (dDiff >= 2 || (lo - loOpp >= 25 && dDiff >= 0)) add(side, "good", Math.max(dDiff, 2) + 1, `Batting depth paid off: #7-#11 added ${lo} runs against ${loOpp}.`);
    else if (dDiff <= -2 || (loOpp - lo >= 25 && dDiff <= 0)) add(side, "bad", Math.max(-dDiff, 2) + 1, `The tail was exposed: #7-#11 added only ${lo} runs against ${loOpp}.`);

    // Part-time bowlers (batters and keepers who bowled): judged the same way on both sides, by what they did
    const partTimers = imp[side].filter((i) => (i.player.primary_role === "BAT" || i.player.primary_role === "WK") && i.ballsBowled >= 12);
    for (const pt of partTimers.sort((a, b) => b.ballsBowled - a.ballsBowled).slice(0, 2)) {
      const econ = pt.conceded / pt.overs;
      const par = PAR_RPO[format as "T20" | "ODI" | "TEST"] ?? 6;
      const line = `${pt.wickets}/${pt.conceded} in ${ballsToOvers(pt.ballsBowled)} ov`;
      if (pt.wickets >= 2 || econ <= par * 0.85) {
        add(side, "good", 2 + Math.min(3, pt.wickets), `${pt.player.name} (a part-time bowler) chipped in with ${line}.`);
      } else if (econ > par) {
        add(side, "bad", 3 + Math.min(4, pt.overs / 2), `Only ${me.frontline} frontline bowlers, so ${pt.player.name} (a batter) had to bowl ${ballsToOvers(pt.ballsBowled)} overs: ${line}, going for ${r1(econ)} an over.`);
      }
    }
  }

  // Match-day evidence for the picks that mattered
  for (const side of ["USER", "AI"] as Side[]) {
    const perf = performance[side];
    const oppPerf = performance[other(side)];
    const best = [...imp[side]].sort((a, b) => b.impact - a.impact)[0];
    if (best && best.impact >= 25) add(side, "good", 4 + Math.min(4, best.impact / 30), `${best.player.name} (#${best.slot + 1}) delivered: ${describe(best)}.`);
    const worst = [...imp[side]].filter((i) => i.batted || i.overs > 0).sort((a, b) => a.impact - b.impact)[0];
    if (worst && worst.impact <= -15 && worst !== best) add(side, "bad", 3 + Math.min(4, -worst.impact / 15), `${worst.player.name} (#${worst.slot + 1}) cost the side: ${describe(worst)}.`);
    const bowlGap = perf.bowlingScore - oppPerf.bowlingScore;
    const batGap = perf.battingScore - oppPerf.battingScore;
    if (bowlGap >= 20) add(side, "good", 3 + bowlGap / 10, `The bowling unit rated ${perf.bowlingScore} against ${oppPerf.bowlingScore}.`);
    else if (bowlGap <= -20) add(side, "bad", 3 - bowlGap / 10, `The bowling unit rated only ${perf.bowlingScore} against ${oppPerf.bowlingScore}.`);
    if (batGap >= 20) add(side, "good", 3 + batGap / 10, `The batting unit rated ${perf.battingScore} against ${oppPerf.battingScore}.`);
    else if (batGap <= -20) add(side, "bad", 3 - batGap / 10, `The batting unit rated only ${perf.battingScore} against ${oppPerf.battingScore}.`);
  }

  const pick = (side: Side, limit: number) => {
    const sorted = [...reasons[side]].sort((a, b) => b.weight - a.weight).slice(0, limit);
    return sorted.map(({ tone, text }) => ({ tone, text }));
  };

  // ---- Best and weakest pick for the user ------------------------------------------------------
  const awards = input.facts?.awards ?? computeAwards(contribs, winner);
  const pickOf = (a: { name: string } | null): PickHighlight | null => {
    const i = a ? imp.USER.find((x) => x.player.name === a.name) : undefined;
    return i ? { name: i.player.name, slot: i.slot + 1, detail: describe(i) } : null;
  };
  const bestPick = pickOf(awards.bestPick);
  const weakestPick = pickOf(awards.weakestPick);

  // ---- Headline: tie the result back to the picks ---------------------------------------------
  const paper = `${totals.USER} v ${totals.AI} on selection`;
  const gaps = (["batting", "bowling", "fielding"] as const).map((k) => ({
    k,
    gap: performance.USER[`${k}Score` as const] - performance.AI[`${k}Score` as const],
  }));
  const bigGap = (forSide: Side) =>
    [...gaps].sort((a, b) => (forSide === "USER" ? b.gap - a.gap : a.gap - b.gap))[0];

  // How one-sided the match was on the field, from the same performance scores shown on the results screen
  const dominant = Math.abs(performance.USER.overallScore - performance.AI.overallScore) >= 25 || input.facts?.margin.tier === "dominant";
  const clearWin = dominant || input.facts?.margin.tier === "clear";
  let headline: string;
  let outcome: SelectionReport["outcome"];
  if (winner === "DRAW" || winner === "TIE") {
    outcome = "LEVEL";
    headline = `Honours even. The two XIs were evenly matched on selection (${paper}) and neither could force a result.`;
  } else if (winner === "USER") {
    if (paperEdge === "USER") {
      outcome = "PICKS_DECIDED";
      headline =
        margin >= 8
          ? `Your picks won it. You built the clearly better-balanced XI (${paper}) and it showed on the field.`
          : dominant
            ? `A narrow edge on paper (${paper}) turned into a heavy win: your XI was far better on the day.`
            : clearWin
              ? `A narrow selection edge to you (${paper}), and your XI turned it into a clear win on the day.`
              : `A narrow selection edge to you (${paper}), and it was enough on the day.`;
    } else if (paperEdge === "AI") {
      outcome = "UPSET";
      const g = bigGap("USER");
      headline = `You won despite a weaker selection on paper (${paper}). Your ${g.k} unit outplayed the AI's on the day.`;
    } else {
      outcome = "CLOSE";
      const g = bigGap("USER");
      headline = `A tight contest between two similar XIs (${paper}). Your ${g.k} edged it.`;
    }
  } else {
    if (paperEdge === "AI") {
      outcome = "PICKS_DECIDED";
      headline =
        -margin >= 8
          ? `Your picks cost you the match. The AI built the clearly better-balanced XI (${paper}).`
          : dominant
            ? `A narrow edge to the AI on paper (${paper}) became a heavy defeat: it was far better on the day.`
            : `A narrow selection edge to the AI (${paper}), but the match was settled on the field.`;
    } else if (paperEdge === "USER") {
      outcome = "UPSET";
      const g = bigGap("AI");
      headline = `You lost despite the better XI on paper (${paper}). The AI's ${g.k} unit was stronger on the day.`;
    } else {
      outcome = "CLOSE";
      const g = bigGap("AI");
      headline = `A tight contest between two similar XIs (${paper}). The AI's ${g.k} edged it.`;
    }
  }

  // ---- Advice: rank categories by what you trailed the AI by, then by points left unclaimed ----
  const nextTime: string[] = [];
  const userIssues = roleIssues(prof.USER, format);
  const adviceCandidates: { score: number; text: string }[] = [];
  const consider = (key: SelectionCategory["key"], ratioLimit: number, text: string) => {
    const c = cat(key);
    const deficit = c.ai - c.user;
    // After a win, only point at categories where the AI actually had the edge
    if (winner === "USER" && (deficit <= 0 || (dominant && deficit < 4))) return;
    if (c.user / c.max < ratioLimit || deficit >= 2) adviceCandidates.push({ score: deficit * 2 + (c.max - c.user), text: `${text} (you ${c.user}/${c.max}, AI ${c.ai}/${c.max}).` });
  };
  consider("role", 0.8, userIssues.length ? `Fix the balance: ${userIssues.slice(0, 2).join(" and ")}. Aim for a keeper, openers who open, 5-6 bowling options and a finisher` : "Check the balance: a keeper, true openers, 5-6 bowling options and a finisher");
  consider("pitch", 0.75, `Read the pitch: on a ${pitchLabel}, ${PITCH_HINT[pitch] ?? "match your squad to the conditions"}. You picked ${pitchTraits(prof.USER, pitch)}`);
  consider("quality", 0.7, `Raise the quality: favour players with strong career numbers in this format. Your picks' average rating was ${Math.round(prof.USER.avgRating)} against the AI's ${Math.round(prof.AI.avgRating)}`);
  consider("depth", 0.65, "Add batting depth: pick bowlers and all-rounders who can score down to #8");
  adviceCandidates.sort((a, b) => b.score - a.score).slice(0, 3).forEach((a) => nextTime.push(a.text));
  if (nextTime.length === 0) {
    if (winner === "AI") nextTime.push("Your selection matched the AI's, so the loss came on the field. Look for the best pick at each slot and pace-vs-spin balance for this pitch.");
    else nextTime.push("A strong, balanced selection. Keep the same template and look for a stronger player at your weakest slot.");
  }
  // Never tell the user the selection was fine when the same report says the AI's was clearly better.
  if (outcome === "PICKS_DECIDED" && winner === "AI" && nextTime.length === 0) nextTime.push("Close the gap in the categories above.");

  return {
    headline,
    paperEdge,
    totals,
    outcome,
    categories,
    userPoints: pick("USER", 5),
    aiPoints: pick("AI", 4),
    bestPick,
    weakestPick,
    nextTime,
  };
}
