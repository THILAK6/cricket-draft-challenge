import type { Challenge, PlayerWithStats } from "./types";
import type { InningsScorecard } from "./simulator";
import type { MatchPerformance } from "./performance";
import { calculateDeterministicScore } from "./scoring";
import { playerQuality } from "./player-quality";

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
  HIGH_SCORING_FLAT: "it rewards hard hitters and control bowlers",
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
  return {
    squad,
    all,
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
  batted: boolean;
  wickets: number;
  conceded: number;
  overs: number;
  catches: number;
  runOuts: number;
  stumpings: number;
  impact: number;
}

function impacts(squad: Squad, batting: InningsScorecard[], bowling: InningsScorecard[]): PlayerImpact[] {
  const out: PlayerImpact[] = [];
  squad.forEach((p, slot) => {
    if (!p) return;
    const row: PlayerImpact = { player: p, slot, runs: 0, balls: 0, batted: false, wickets: 0, conceded: 0, overs: 0, catches: 0, runOuts: 0, stumpings: 0, impact: 0 };
    for (const inn of batting) {
      const b = inn.batters.find((x) => x.playerId === p.id);
      if (b && (b.balls > 0 || b.isOut)) {
        row.batted = true;
        row.runs += b.runs;
        row.balls += b.balls;
      }
    }
    for (const inn of bowling) {
      const b = inn.bowlers.find((x) => x.playerId === p.id);
      if (b) {
        const [o, balls] = b.overs.split(".").map(Number);
        row.overs += (o || 0) + (balls || 0) / 6;
        row.wickets += b.wickets;
        row.conceded += b.runs;
      }
      const f = (inn.fielders ?? []).find((x) => x.playerId === p.id);
      if (f) {
        row.catches += f.catches;
        row.runOuts += f.runOuts;
        row.stumpings += f.stumpings;
      }
    }
    row.impact = row.runs + row.wickets * 22 + row.catches * 8 + row.runOuts * 12 + row.stumpings * 10;
    out.push(row);
  });
  return out;
}

function describe(i: PlayerImpact): string {
  const parts: string[] = [];
  if (i.batted) parts.push(`${i.runs} off ${i.balls}`);
  if (i.overs > 0) parts.push(`${i.wickets}/${i.conceded} in ${r1(i.overs)} ov`);
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
  const imp = {
    USER: impacts(userSquad, userInnings, aiInnings),
    AI: impacts(aiSquad, aiInnings, userInnings),
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
    const mix = `${me.pacers} seam and ${me.spinners} spin`;
    if (pitchDiff >= 3) add(side, "good", pitchDiff + 2, `The attack suited the ${pitchLabel}: ${mix} options against ${them.pacers} seam and ${them.spinners} spin.`);
    else if (pitchDiff <= -3) add(side, "bad", -pitchDiff + 2, `The ${mix} attack did not suit the ${pitchLabel}, where ${PITCH_HINT[pitch] ?? "conditions matter"}.`);

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
      if (qDiff > 0) add(side, "good", qDiff + 1, `Higher-calibre players (${rating}), led by ${me.topPicks.slice(0, 2).join(" and ")}.`);
      else add(side, "bad", -qDiff + 1, `Lower-calibre picks (${rating}). The opposition's best were ${them.topPicks.slice(0, 2).join(" and ")}.`);
    }

    // Batting depth, backed by what the lower order actually scored
    const dDiff = catFor(cat("depth"), side) - catFor(cat("depth"), opp);
    const myBat = side === "USER" ? userInnings : aiInnings;
    const theirBat = side === "USER" ? aiInnings : userInnings;
    const lo = lowerOrderRuns(myBat);
    const loOpp = lowerOrderRuns(theirBat);
    if (dDiff >= 2 || (lo - loOpp >= 25 && dDiff >= 0)) add(side, "good", Math.max(dDiff, 2) + 1, `Batting depth paid off: #7-#11 added ${lo} runs against ${loOpp}.`);
    else if (dDiff <= -2 || (loOpp - lo >= 25 && dDiff <= 0)) add(side, "bad", Math.max(-dDiff, 2) + 1, `The tail was exposed: #7-#11 added only ${lo} runs against ${loOpp}.`);

    // A batter forced to bowl because the frontline attack was too thin
    const partTimer = imp[side]
      .filter((i) => i.player.primary_role === "BAT" && i.overs >= 2)
      .sort((a, b) => b.overs - a.overs)[0];
    if (partTimer) {
      const econ = partTimer.conceded / partTimer.overs;
      add(side, "bad", 3 + Math.min(4, partTimer.overs / 2), `Only ${me.frontline} frontline bowlers, so ${partTimer.player.name} (a batter) had to bowl ${r1(partTimer.overs)} overs and went for ${r1(econ)} an over.`);
    }
  }

  // Match-day evidence for the picks that mattered
  for (const side of ["USER", "AI"] as Side[]) {
    const perf = performance[side];
    const oppPerf = performance[other(side)];
    const best = [...imp[side]].sort((a, b) => b.impact - a.impact)[0];
    if (best && best.impact >= 40) add(side, "good", 4 + Math.min(4, best.impact / 30), `${best.player.name} (#${best.slot + 1}) delivered: ${describe(best)}.`);
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
  const involved = imp.USER.filter((i) => i.batted || i.overs > 0);
  const bestI = [...involved].sort((a, b) => b.impact - a.impact)[0];
  const weakI = [...involved].sort((a, b) => a.impact - b.impact)[0];
  const bestPick: PickHighlight | null = bestI ? { name: bestI.player.name, slot: bestI.slot + 1, detail: describe(bestI) } : null;
  const weakestPick: PickHighlight | null =
    weakI && weakI !== bestI ? { name: weakI.player.name, slot: weakI.slot + 1, detail: describe(weakI) } : null;

  // ---- Headline: tie the result back to the picks ---------------------------------------------
  const paper = `${totals.USER} v ${totals.AI} on selection`;
  const gaps = (["batting", "bowling", "fielding"] as const).map((k) => ({
    k,
    gap: performance.USER[`${k}Score` as const] - performance.AI[`${k}Score` as const],
  }));
  const bigGap = (forSide: Side) =>
    [...gaps].sort((a, b) => (forSide === "USER" ? b.gap - a.gap : a.gap - b.gap))[0];

  let headline: string;
  let outcome: SelectionReport["outcome"];
  if (winner === "DRAW" || winner === "TIE") {
    outcome = "LEVEL";
    headline = `Honours even. The two XIs were evenly matched on selection (${paper}) and neither could force a result.`;
  } else if (winner === "USER") {
    if (paperEdge === "USER") {
      outcome = "PICKS_DECIDED";
      headline = `Your picks won it. You built the better-balanced XI (${paper}) and it showed on the field.`;
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
      headline = `Your picks cost you the match. The AI built the better-balanced XI (${paper}).`;
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

  // ---- Advice from the categories where the user left the most points on the table ------------
  const nextTime: string[] = [];
  const userIssues = roleIssues(prof.USER, format);
  const gapFor = (key: SelectionCategory["key"]) => {
    const c = cat(key);
    return { c, lost: c.max - c.user, ratio: c.user / c.max };
  };
  const adviceCandidates: { lost: number; text: string }[] = [];
  const role = gapFor("role");
  if (role.ratio < 0.8) adviceCandidates.push({ lost: role.lost, text: userIssues.length ? `Fix the balance: ${userIssues.slice(0, 2).join(" and ")}. Aim for a keeper, openers who open, 5-6 bowling options and a finisher.` : "Check the balance: a keeper, true openers, 5-6 bowling options and a finisher." });
  const pitchGap = gapFor("pitch");
  if (pitchGap.ratio < 0.75) adviceCandidates.push({ lost: pitchGap.lost, text: `Read the pitch: on a ${pitchLabel}, ${PITCH_HINT[pitch] ?? "match your attack to the conditions"}. You picked ${prof.USER.pacers} seam and ${prof.USER.spinners} spin.` });
  const qual = gapFor("quality");
  if (qual.ratio < 0.7) adviceCandidates.push({ lost: qual.lost, text: `Raise the quality: favour players with strong career numbers in this format. Your top seven averaged ${r1(prof.USER.topSevenAvg)}.` });
  const depth = gapFor("depth");
  if (depth.ratio < 0.65) adviceCandidates.push({ lost: depth.lost, text: "Add batting depth: pick bowlers and all-rounders who can score down to #8." });
  adviceCandidates.sort((a, b) => b.lost - a.lost).slice(0, 3).forEach((a) => nextTime.push(a.text));
  if (nextTime.length === 0) nextTime.push("A strong, balanced selection. Keep the same template and look for a stronger player at your weakest slot.");

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
