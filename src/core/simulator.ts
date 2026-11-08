import { computeContributions, topContribution, describeContribution, type Contribution } from "./impact";
import { ballsToOvers } from "./overs";
import { buildMatchFacts, checkTacticClaims, type MatchFacts, type TacticClaim } from "./match-facts";
import { phasesReached, collapsedEarly, comparablePhases, phaseRunRate, PHASE_BOUNDS } from "./phases";
import type { Challenge, MatchFormat, PitchType, PlayerWithStats } from "./types";
import { eraAdjusted } from "./era";
import { computeMatchPerformance, type MatchPerformance } from "./performance";
import { buildSelectionReport, type SelectionReport } from "./selection-report";

export interface BatterScorecard {
  playerId: string;
  name: string;
  country: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  isOut: boolean;
  dismissal?: string;
  /** Bowler who took the wicket; absent for run outs and not-out batters. */
  bowlerId?: string;
  strikeRate: number;
}

export interface BowlerScorecard {
  playerId: string;
  name: string;
  country: string;
  overs: string;
  maidens: number;
  runs: number;
  wickets: number;
  economy: number;
}

export interface FielderScorecard {
  playerId: string;
  name: string;
  catches: number;
  runOuts: number;
  stumpings: number;
}

export interface InningsScorecard {
  teamName: string;
  inningsNumber?: number; // 1 or 2 (for Tests)
  totalRuns: number;
  totalWickets: number;
  totalBalls: number;
  oversString: string;
  oversCompleted: number;
  maxOvers: number;
  batters: BatterScorecard[];
  bowlers: BowlerScorecard[];
  /** Fielders of the side bowling in this innings, from the simulated dismissals. */
  fielders?: FielderScorecard[];
  /** Catches the fielding side put down in this innings (does not change the score). */
  droppedCatches?: number;
  /** Who put down which batter, for the catches counted in droppedCatches. */
  drops?: { fielder: string; fielderId?: string; batter: string; bowler: string; runsAtDrop?: number; reprieveRuns?: number }[];
  /** True when the batting side declared (Tests). */
  declared?: boolean;
  /** Score and ball count as each wicket fell, for collapse detection. */
  fallOfWickets?: { wicket: number; runs: number; balls: number }[];
  phaseRuns: {
    powerplay: number;
    middle: number;
    death: number;
  };
}

export interface KeyMoment {
  over: number | string;
  title: string;
  description: string;
  impactTeam: "USER" | "AI";
}

export interface TossInfo {
  winner: "USER" | "AI";
  decision: "BAT" | "BOWL";
  narrative: string;
}

export interface TestDayChronicle {
  day: number;
  title: string;
  stumpsScore: string;
  highlight: string;
  pitchBehavior: string;
}

export interface SuperOverRound {
  battingFirst: "USER" | "AI";
  firstRuns: number;
  firstWickets: number;
  secondRuns: number;
  secondWickets: number;
}

export interface SuperOverResult {
  rounds: SuperOverRound[];
  decidedBy: "RUNS" | "BOUNDARIES" | "NONE";
  winner: "USER" | "AI" | "TIE";
  summary: string;
}

/** Optional bowling plan for a side. Anything left unset is chosen from the conditions. */
export interface BowlingPlan {
  /** Up to two player ids who take the new ball. */
  newBall?: string[];
  /** Player id who bowls the death overs. */
  death?: string;
}

export interface SimulationOptions {
  userPlan?: BowlingPlan;
}

export interface MatchSimulationResult {
  format: MatchFormat;
  winner: "USER" | "AI" | "TIE" | "DRAW";
  summary: string;
  toss: TossInfo;
  userInnings: InningsScorecard;
  aiInnings: InningsScorecard;
  userSecondInnings?: InningsScorecard;
  aiSecondInnings?: InningsScorecard;
  /** Only present when a tied T20 went to a super over. */
  superOver?: SuperOverResult;
  leadFirstInnings?: {
    team: "USER" | "AI";
    runs: number;
  };
  testTarget?: number;
  dayChronicle?: TestDayChronicle[];
  keyMoments: KeyMoment[];
  /** Batting, bowling and fielding scores plus comparison stats for each side. */
  performance: MatchPerformance;
  /** Why the XI you picked won or lost: selection scores, key picks and advice. */
  selection: SelectionReport;
  /** Notable in-match tactical calls (bowling changes, batting-order promotions) made from conditions. */
  tactics: string[];
  /** The single facts object every narrative section was generated from. */
  matchFacts?: MatchFacts;
  decisiveDifference: string;
  whyWinnerWon: string[];
  whyLoserLost: string[];
  groundConditionsAnalysis: string;
  playerOfTheMatch: {
    name: string;
    team: "USER" | "AI";
    performance: string;
  };
}

// Seeded PRNG for reproducible, realistic cricket simulation
function createRng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Formats balls into standard cricket overs string (e.g. 284 balls -> "47.2")
 */
function formatBallsToOvers(balls: number): string {
  return ballsToOvers(balls);
}

/**
 * Simulates an authentic, data-driven cricket match between USER XI and AI XI.
 */
export function simulateCricketMatch(
  userSquad: (PlayerWithStats | null)[],
  aiSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  seed = Date.now(),
  options: SimulationOptions = {}
): MatchSimulationResult {
  const rng = createRng(seed);
  const format = challenge.format || "T20";
  const pitchType = challenge.venue.pitch_type;

  // 1. Simulate Authentic Match Toss
  const tossWinner: "USER" | "AI" = rng() > 0.5 ? "USER" : "AI";
  let tossDecision: "BAT" | "BOWL";
  let tossReason: string;

  if (pitchType === "GREEN_SEAMER") {
    tossDecision = "BOWL";
    tossReason = "exploit morning moisture, grass covering, and swing under cloud cover";
  } else if (pitchType === "HIGH_SCORING_FLAT") {
    tossDecision = format === "TEST" ? "BAT" : "BOWL";
    tossReason = format === "TEST"
      ? "pile on a colossal 1st innings total on a true wicket before Day 5 cracks appear"
      : "chase with the target in front of them on a true surface";
  } else if (pitchType === "DUSTBOWL") {
    tossDecision = "BAT";
    tossReason = "lock in runs before the dry surface crumbles into a turning square minefield";
  } else {
    // SLOW_LOW
    tossDecision = "BAT";
    tossReason = "dictate the match tempo before the wicket slows down and grips for cutters";
  }

  // Vary the wording by seed (not the rng stream, so match results are unchanged)
  const tossOpeners = [
    (w: string, d: string, r: string) => `${w} won the toss and elected to ${d} first to ${r}.`,
    (w: string, d: string, r: string) => `${w} called correctly and chose to ${d}, looking to ${r}.`,
    (w: string, d: string, r: string) => `Winning the toss, ${w} decided to ${d} first: the plan is to ${r}.`,
  ];
  const tossWho = tossWinner === "USER" ? "Your XI" : "AI XI";
  const tossNarrative = tossOpeners[Math.abs(Math.floor(seed)) % tossOpeners.length](tossWho, tossDecision.toLowerCase(), tossReason);
  const tossInfo: TossInfo = {
    winner: tossWinner,
    decision: tossDecision,
    narrative: tossNarrative,
  };

  const keyMoments: KeyMoment[] = [];
  const tactics: string[] = [];
  const claims: TacticClaim[] = [];
  // Wrapper that hands each innings the bowling side's plan and the shared tactics log.
  const inningsOf = (
    bat: (PlayerWithStats | null)[],
    bowl: (PlayerWithStats | null)[],
    ch: Challenge,
    overs: number,
    name: string,
    tgt: number | undefined,
    r: () => number,
    inn = 1,
    det = false,
    declareAt?: number
  ) =>
    simulateInnings(bat, bowl, ch, overs, name, tgt, r, inn, det, {
      declareAt,
      plan: name === "AI XI" ? options.userPlan : undefined,
      tactics,
      claims,
      bowlingSide: name === "AI XI" ? "Your XI" : "AI XI",
    });

  // Determine which team bats first in Innings 1
  const userBatsFirst =
    (tossWinner === "USER" && tossDecision === "BAT") ||
    (tossWinner === "AI" && tossDecision === "BOWL");

  // =========================================================================
  // TEST MATCH SIMULATION (4 INNINGS CONTEST)
  // =========================================================================
  if (format === "TEST") {
    // Five days of about 90 overs. Innings run until all out or a declaration; a side 200 behind on
    // first innings follows on; the side batting third declares to leave time to win; a draw only
    // when the overs run out. (Fixed innings caps used to leave a third of Tests drawn.)
    // Weather: about a quarter of Tests lose time to rain or bad light (30-150 overs), which is
    // where most real draws come from
    const lost = rng() < 0.25 ? Math.round(30 + rng() * 120) : 0;
    const TOTAL_OVERS = 450 - lost;
    let used = 0;
    const oversOf = (i: InningsScorecard) => i.totalBalls / 6;
    const left = () => Math.max(0, TOTAL_OVERS - used);
    const A = userBatsFirst ? { squad: userSquad, opp: aiSquad, name: "Your XI", side: "USER" as const } : { squad: aiSquad, opp: userSquad, name: "AI XI", side: "AI" as const };
    const B = userBatsFirst ? { squad: aiSquad, opp: userSquad, name: "AI XI", side: "AI" as const } : { squad: userSquad, opp: aiSquad, name: "Your XI", side: "USER" as const };
    const bat = (t: typeof A, overs: number, inn: number, det: boolean, tgt?: number, declareAt?: number) => {
      const cap = Math.max(1, Math.floor(overs));
      const i = inningsOf(t.squad, t.opp, challenge, cap, t.name, tgt, rng, inn, det, declareAt);
      // Batting on until the time set aside runs out (not all out, not chasing) is a declaration:
      // the captain closes the innings to leave time to win
      if (tgt === undefined && i.totalWickets < 10 && i.totalBalls >= cap * 6) i.declared = true;
      used += oversOf(i);
      return i;
    };
    const day = () => Math.min(5, Math.max(1, Math.ceil(used / 90)));

    // First innings: a big total is declared on (with time left to win the match)
    const a1 = bat(A, Math.min(170, left() - 200), 1, false, undefined, 600);
    const b1 = bat(B, Math.min(170, left() - 120), 1, false, undefined, a1.totalRuns + 300);
    const firstLead = a1.totalRuns - b1.totalRuns;
    const followOn = firstLead >= 200 && left() >= 150;

    // Third innings: the follow-on side bats again, or the side batting first sets a target
    let third: InningsScorecard;
    let thirdTeam: typeof A;
    let chaseTeam: typeof A;
    let target: number;
    if (followOn) {
      thirdTeam = B;
      chaseTeam = A;
      third = bat(B, left(), 2, true);
      target = b1.totalRuns + third.totalRuns - a1.totalRuns + 1;
    } else {
      thirdTeam = A;
      chaseTeam = B;
      // Declare once the lead is big enough, leaving about 90 overs to bowl the other side out
      const declLead = firstLead >= 0 ? 380 : 330;
      third = bat(A, Math.max(10, left() - 90), 2, true, undefined, Math.max(1, declLead - firstLead));
      target = a1.totalRuns + third.totalRuns - b1.totalRuns + 1;
    }

    let fourth: InningsScorecard | undefined;
    let winner: "USER" | "AI" | "DRAW" | "TIE" = "DRAW";
    let summary = "";
    const thirdAllOut = third.totalWickets >= 10;
    if (target <= 0 && thirdAllOut) {
      // Bowled out twice and still behind: an innings defeat
      winner = chaseTeam.side;
      summary = `${chaseTeam.name} won by an innings and ${1 - target} runs!`;
    } else if (target <= 0) {
      // Declared behind is never sensible; treat the target as a token one-run chase
      target = 1;
    }
    if (!summary) {
      fourth = bat(chaseTeam, left(), 2, true, target);
      if (fourth.totalRuns >= target) {
        winner = chaseTeam.side;
        const wl = 10 - fourth.totalWickets;
        summary = `${chaseTeam.name} won by ${wl} wicket${wl === 1 ? "" : "s"} on Day ${day()}!`;
      } else if (fourth.totalWickets >= 10) {
        const margin = target - 1 - fourth.totalRuns;
        if (margin === 0) {
          winner = "TIE";
          summary = `Match Tied! ${chaseTeam.name} were all out for exactly the score needed to level the Test (${fourth.totalRuns}).`;
        } else {
          winner = thirdTeam.side;
          summary = `${thirdTeam.name} won by ${margin} run${margin === 1 ? "" : "s"}${followOn ? " after following on" : ""}!`;
        }
      } else {
        winner = "DRAW";
        summary = `Match Drawn! ${chaseTeam.name} batted out Day 5 (${fourth.totalRuns}/${fourth.totalWickets} in ${fourth.oversString} ov)${lost ? `, with ${lost} overs lost to the weather` : ""}.`;
      }
    }

    const empty = (name: string) => createEmptyInnings(name, 2);
    const secondOf = (t: typeof A) => (t === thirdTeam ? third : fourth ?? empty(t.name));
    const userInn1 = A.side === "USER" ? a1 : b1;
    const aiInn1 = A.side === "AI" ? a1 : b1;
    const userInn2 = secondOf(A.side === "USER" ? A : B);
    const aiInn2 = secondOf(A.side === "AI" ? A : B);
    const testTarget = target;
    const leadFirstInnings = {
      team: (userInn1.totalRuns >= aiInn1.totalRuns ? "USER" : "AI") as "USER" | "AI",
      runs: Math.abs(userInn1.totalRuns - aiInn1.totalRuns),
    };
    const firstBatTeam = userBatsFirst ? "Your XI" : "AI XI";
    const secondBatTeam = userBatsFirst ? "AI XI" : "Your XI";
    const firstInn1 = userBatsFirst ? userInn1 : aiInn1;
    const secondInn1 = userBatsFirst ? aiInn1 : userInn1;
    const firstInn2 = userBatsFirst ? userInn2 : aiInn2;
    const secondInn2 = userBatsFirst ? aiInn2 : userInn2;

    const dayChronicle = buildTestDayChronicle(
      firstBatTeam,
      secondBatTeam,
      firstInn1,
      secondInn1,
      firstInn2,
      secondInn2,
      leadFirstInnings,
      testTarget,
      winner,
      summary,
      pitchType
    );

    keyMoments.push({
      over: "Day 1 - 2",
      title: "Opening Exchange",
      description: `${userBatsFirst ? "Your XI" : "AI XI"} set the foundation on a fresh wicket with early lateral movement.`,
      impactTeam: userBatsFirst ? "USER" : "AI",
    });

    keyMoments.push({
      over: "Day 3",
      title: "First Innings Lead",
      description: `${leadFirstInnings.team === "USER" ? "Your XI" : "AI XI"} claimed a crucial first-innings advantage of ${leadFirstInnings.runs} runs.`,
      impactTeam: leadFirstInnings.team,
    });

    keyMoments.push({
      over: "Day 5",
      title: "Final Innings Resolution",
      description: summary,
      impactTeam: winner === "DRAW" || winner === "TIE" ? "USER" : winner,
    });

    const testUserInns = [userInn1, userInn2].filter((i): i is InningsScorecard => !!i);
    const testAiInns = [aiInn1, aiInn2].filter((i): i is InningsScorecard => !!i);
    const testContribs = computeContributions({ format: "TEST", userInnings: testUserInns, aiInnings: testAiInns, winner, pitch: challenge.venue.pitch_type });
    const testFacts = buildMatchFacts({ format: "TEST", winner, userInnings: testUserInns, aiInnings: testAiInns, userSquad, aiSquad, pitch: challenge.venue.pitch_type, contributions: testContribs });
    const potm = determinePlayerOfTheMatch(testFacts);
    const analysis = deriveMatchAnalysis(userInn1, aiInn1, userSquad, aiSquad, challenge, winner, 0, userBatsFirst, userInn2, aiInn2, testContribs);
  for (const d of dropsNarrative([aiInn1, aiInn2].filter((x): x is InningsScorecard => !!x), [userInn1, userInn2].filter((x): x is InningsScorecard => !!x))) {
    if (winner !== d.side) analysis.whyLoserLost.push(d.text);
  }
  addClusterLines(analysis, testFacts, keyMoments);
    const testPerf = computeMatchPerformance("TEST", testUserInns, testAiInns);
    const testSel = buildSelectionReport({ userSquad, aiSquad, challenge, winner, userInnings: testUserInns, aiInnings: testAiInns, performance: testPerf, contributions: testContribs, facts: testFacts });

    return {
      format: "TEST",
      winner,
      summary,
      toss: tossInfo,
      tactics: yourSideFirst(checkTacticClaims(claims, testFacts)).slice(0, 12),
      matchFacts: testFacts,
      userInnings: userInn1,
      aiInnings: aiInn1,
      userSecondInnings: userInn2,
      aiSecondInnings: aiInn2,
      leadFirstInnings,
      testTarget,
      dayChronicle,
      keyMoments,
      performance: testPerf,
      selection: testSel,
      decisiveDifference: analysis.decisiveDifference,
      whyWinnerWon: analysis.whyWinnerWon,
      whyLoserLost: analysis.whyLoserLost,
      groundConditionsAnalysis: analysis.groundConditionsAnalysis,
      playerOfTheMatch: potm,
    };
  }

  // =========================================================================
  // LIMITED OVERS SIMULATION (T20 & ODI)
  // =========================================================================
  const maxOvers = format === "T20" ? 20 : 50;

  let firstInnings: InningsScorecard;
  let secondInnings: InningsScorecard;
  let firstTeam: "USER" | "AI";

  if (userBatsFirst) {
    firstTeam = "USER";
    firstInnings = inningsOf(userSquad, aiSquad, challenge, maxOvers, "Your XI", undefined, rng);
    const target = firstInnings.totalRuns + 1;
    secondInnings = inningsOf(aiSquad, userSquad, challenge, maxOvers, "AI XI", target, rng);
  } else {
    firstTeam = "AI";
    firstInnings = inningsOf(aiSquad, userSquad, challenge, maxOvers, "AI XI", undefined, rng);
    const target = firstInnings.totalRuns + 1;
    secondInnings = inningsOf(userSquad, aiSquad, challenge, maxOvers, "Your XI", target, rng);
  }

  const userInnings = firstTeam === "USER" ? firstInnings : secondInnings;
  const aiInnings = firstTeam === "AI" ? firstInnings : secondInnings;

  // Accurate margin calculation
  let winner: "USER" | "AI" | "TIE" = "TIE";
  let summary = "";
  let ballsRemaining = 0;

  if (secondInnings.totalRuns >= firstInnings.totalRuns + 1) {
    // Chasing team won
    winner = firstTeam === "USER" ? "AI" : "USER";
    const wktsRemaining = 10 - secondInnings.totalWickets;
    const maxBalls = maxOvers * 6;
    ballsRemaining = Math.max(0, maxBalls - secondInnings.totalBalls);

    let ballsText = "";
    if (ballsRemaining >= 12) {
      const remOvers = Math.floor(ballsRemaining / 6);
      const remBalls = ballsRemaining % 6;
      ballsText = remBalls === 0
        ? `with ${remOvers} overs to spare`
        : `with ${remOvers}.${remBalls} overs to spare`;
    } else if (ballsRemaining > 0) {
      ballsText = `with ${ballsRemaining} ball${ballsRemaining === 1 ? "" : "s"} to spare`;
    } else {
      ballsText = `off the final ball of the match`;
    }

    summary = `${winner === "USER" ? "Your XI" : "AI XI"} won by ${wktsRemaining} wicket${wktsRemaining === 1 ? "" : "s"} (${ballsText})`;
  } else if (firstInnings.totalRuns > secondInnings.totalRuns) {
    // Defending team won
    winner = firstTeam === "USER" ? "USER" : "AI";
    const runDiff = firstInnings.totalRuns - secondInnings.totalRuns;
    summary = `${winner === "USER" ? "Your XI" : "AI XI"} won by ${runDiff} run${runDiff === 1 ? "" : "s"}`;
  } else {
    winner = "TIE";
    summary = `Match Tied! Both sides finished level on ${firstInnings.totalRuns} runs.`;
  }

  // T20 ties go to a super over (ODI ties stay ties)
  let superOver: SuperOverResult | undefined;
  if (winner === "TIE" && format === "T20") {
    superOver = simulateSuperOver(userSquad, aiSquad, challenge, firstTeam, [firstInnings, secondInnings], rng);
    keyMoments.push({
      over: "Super Over",
      title: "Super Over Decider",
      description: superOver.summary,
      impactTeam: superOver.winner === "AI" ? "AI" : "USER",
    });
    summary = `Match tied on ${firstInnings.totalRuns}. ${superOver.summary}`;
    winner = superOver.winner;
  }

  // Key Match Moments from real match figures. Phases a side never reached are not compared.
  const ppOvers = format === "T20" ? 6 : 10;
  const reachedFirst = phasesReached(format, [firstInnings]);
  const reachedSecond = phasesReached(format, [secondInnings]);
  const sideOf = (inn: InningsScorecard): "USER" | "AI" => (inn === userInnings ? "USER" : "AI");
  const firstSide = sideOf(firstInnings);
  const secondSide = sideOf(secondInnings);
  const outText = (inn: InningsScorecard) => `${inn.teamName} were bowled out for ${inn.totalRuns} in ${inn.oversString} overs`;
  const comparable = comparablePhases(format, firstInnings, secondInnings);
  const rr = (inn: InningsScorecard, ph: "powerplay" | "middle" | "death") => phaseRunRate(format, inn, ph).toFixed(1);
  if (comparable.powerplay) {
    const f = phaseRunRate(format, firstInnings, "powerplay");
    const sc = phaseRunRate(format, secondInnings, "powerplay");
    keyMoments.push({
      over: `1 - ${ppOvers}`,
      title: "Powerplay Clashes",
      description: `${firstInnings.teamName} scored at ${rr(firstInnings, "powerplay")} an over in the powerplay (${firstInnings.phaseRuns.powerplay}), while ${secondInnings.teamName} managed ${rr(secondInnings, "powerplay")} (${secondInnings.phaseRuns.powerplay}).`,
      impactTeam: f >= sc ? firstSide : secondSide,
    });
  }

  const deathPhaseText = format === "T20" ? "16 - 20" : "41 - 50";
  const bothDeath = comparable.death;
  const earlyOut = [firstInnings, secondInnings].find((i) => collapsedEarly(format, i));
  if (bothDeath) {
    keyMoments.push({
      over: deathPhaseText,
      title: "Closing Phase Duel",
      description: `${firstInnings.teamName} scored ${firstInnings.phaseRuns.death} in the final overs (${rr(firstInnings, "death")} an over), while ${secondInnings.teamName} made ${secondInnings.phaseRuns.death} (${rr(secondInnings, "death")} an over).`,
      impactTeam: winner === "TIE" ? "USER" : winner,
    });
  } else if (earlyOut) {
    const other = earlyOut === firstInnings ? secondInnings : firstInnings;
    const otherDeath = earlyOut === firstInnings ? reachedSecond.death : reachedFirst.death;
    keyMoments.push({
      over: "Collapse",
      title: "Innings Collapse",
      description: `${outText(earlyOut)}, never reaching the closing overs${otherDeath ? `, while ${other.teamName} scored ${other.phaseRuns.death} in theirs` : ""}.`,
      impactTeam: sideOf(other),
    });
  } else {
    // Chase ended before the closing phase (target reached early)
    const chaserEnded = secondInnings.totalRuns > firstInnings.totalRuns && !reachedSecond.death;
    keyMoments.push({
      over: deathPhaseText,
      title: "Closing Phase",
      description: chaserEnded
        ? `${secondInnings.teamName} reached the target in ${secondInnings.oversString} overs, before the closing overs began.`
        : `The closing overs were not reached by both sides.`,
      impactTeam: winner === "TIE" ? "USER" : winner,
    });
  }

  const chase = { team: (firstTeam === "USER" ? "AI" : "USER") as "USER" | "AI", target: firstInnings.totalRuns + 1 };
  const limitedContribs = computeContributions({ format, userInnings: [userInnings], aiInnings: [aiInnings], winner, chase, pitch: challenge.venue.pitch_type });
  const limitedFacts = buildMatchFacts({ format, winner, userInnings: [userInnings], aiInnings: [aiInnings], userSquad, aiSquad, pitch: challenge.venue.pitch_type, chase, contributions: limitedContribs });
  const potm = determinePlayerOfTheMatch(limitedFacts);
  const analysis = deriveMatchAnalysis(userInnings, aiInnings, userSquad, aiSquad, challenge, winner, ballsRemaining, userBatsFirst, undefined, undefined, limitedContribs);
  for (const d of dropsNarrative([aiInnings], [userInnings])) {
    if (winner !== d.side) analysis.whyLoserLost.push(d.text);
  }
  addClusterLines(analysis, limitedFacts, keyMoments);

  const limitedPerf = computeMatchPerformance(format, [userInnings], [aiInnings], chase);
  const limitedSel = buildSelectionReport({ userSquad, aiSquad, challenge, winner, userInnings: [userInnings], aiInnings: [aiInnings], performance: limitedPerf, contributions: limitedContribs, chase, facts: limitedFacts });

  return {
    format,
    winner,
    summary,
    toss: tossInfo,
    userInnings,
    aiInnings,
    keyMoments,
    tactics: yourSideFirst(checkTacticClaims(claims, limitedFacts)).slice(0, 12),
    matchFacts: limitedFacts,
    superOver,
    performance: limitedPerf,
    selection: limitedSel,
    decisiveDifference: analysis.decisiveDifference,
    whyWinnerWon: analysis.whyWinnerWon,
    whyLoserLost: analysis.whyLoserLost,
    groundConditionsAnalysis: analysis.groundConditionsAnalysis,
    playerOfTheMatch: potm,
  };
}

/** Lists the user's own side first so their plan calls are never cut off. */
function yourSideFirst(xs: string[]): string[] {
  return [...xs.filter((t) => t.startsWith("Your XI")), ...xs.filter((t) => !t.startsWith("Your XI"))];
}

function createEmptyInnings(teamName: string, innNum: number): InningsScorecard {
  return {
    teamName,
    inningsNumber: innNum,
    totalRuns: 0,
    totalWickets: 0,
    totalBalls: 0,
    oversString: "0.0",
    oversCompleted: 0,
    maxOvers: 0,
    batters: [],
    bowlers: [],
    phaseRuns: { powerplay: 0, middle: 0, death: 0 },
  };
}

/**
 * Simulates a single innings with exact ball-by-ball physics.
 */
function simulateInnings(
  battingLineup: (PlayerWithStats | null)[],
  bowlingLineup: (PlayerWithStats | null)[],
  challenge: Challenge,
  maxOvers: number,
  teamName: string,
  target: number | undefined,
  rng: () => number,
  inningsNumber = 1,
  isDeterioratedPitch = false,
  opts: { wicketLimit?: number; phase?: "PP" | "MID" | "DEATH"; plan?: BowlingPlan; tactics?: string[]; claims?: TacticClaim[]; bowlingSide?: string; declareAt?: number } = {}
): InningsScorecard {
  const wicketLimit = opts.wicketLimit ?? 10;
  const { pitch_type, country } = challenge.venue;
  const format = challenge.format;
  const isTest = format === "TEST";

  // Valid batters in designated order
  const battersInOrder = battingLineup
    .map((p, idx) => ({ player: p, slotIndex: idx }))
    .filter((item): item is { player: PlayerWithStats; slotIndex: number } => item.player !== null);

  // Valid bowlers selection:
  // 1. Frontline bowlers & All-Rounders
  const specialistBowlers = bowlingLineup.filter(
    (p): p is PlayerWithStats => p !== null && p.primary_role === "BOWL"
  );
  const allRounders = bowlingLineup.filter(
    (p): p is PlayerWithStats => p !== null && p.primary_role === "AR"
  );

  // 2. Part-timers (pure batters who bowl occasionally; WKs NEVER bowl)
  const partTimers = bowlingLineup.filter(
    (p): p is PlayerWithStats =>
      p !== null &&
      p.primary_role === "BAT" &&
      p.bowling_category !== "NONE" &&
      p.stats.bowl_innings > 0 &&
      p.stats.bowl_innings / Math.max(1, p.stats.matches) >= 0.25 &&
      p.stats.bowl_overs / Math.max(1, p.stats.matches) >= 2.0
  );

  // Limited-overs rules cap each bowler at maxOvers/5, so an innings needs at least 5 bowlers, plus
  // one spare so nobody has to bowl consecutive overs at the end. Part-timers (then any other
  // non-keeper) fill the gap. They carry heavy selection penalties, so they only bowl when the
  // frontline bowlers have used their quota.
  const frontlineUnits = [...specialistBowlers, ...allRounders];
  const minBowlers = isTest ? 5 : 6;
  const bowlers: PlayerWithStats[] = [...frontlineUnits];
  const addExtras = (candidates: PlayerWithStats[]) => {
    for (const c of candidates) {
      if (bowlers.length >= minBowlers) break;
      if (!bowlers.includes(c)) bowlers.push(c);
    }
  };
  if (bowlers.length < minBowlers) addExtras(partTimers);
  if (bowlers.length < minBowlers) {
    const others = bowlingLineup
      .filter((p): p is PlayerWithStats => p !== null && p.primary_role !== "WK" && !bowlers.includes(p))
      .sort((a, b) => b.stats.bowl_overs - a.stats.bowl_overs);
    addExtras(others);
  }
  if (bowlers.length === 0) {
    bowlers.push(...bowlingLineup.filter((p): p is PlayerWithStats => p !== null));
  }

  // Initialize Scorecards
  const batterCards: BatterScorecard[] = battersInOrder.map(({ player }) => ({
    playerId: player.id,
    name: player.name,
    country: player.country,
    runs: 0,
    balls: 0,
    fours: 0,
    sixes: 0,
    isOut: false,
    strikeRate: 0,
  }));

  // Log notable calls, at most two per kind per side, so the list stays readable
  const noteCounts = new Map<string, number>();
  const notedPlayers = new Set<string>();
  const note = (text: string, kind = "other", playerId?: string, side: "Your XI" | "AI XI" = "AI XI") => {
    if (!opts.tactics || opts.tactics.includes(text)) return;
    // One call per player per innings: the same bowler is not "brought on" and "given the ball" twice
    if (playerId && kind !== "promo") {
      if (notedPlayers.has(playerId)) return;
    }
    // The same call with only the numbers changed (e.g. a repeated hold-back) is one tactic, not two
    const shape = text.replace(/\d+(\.\d+)?/g, "#");
    if (opts.tactics.some((t) => t.replace(/\d+(\.\d+)?/g, "#") === shape)) return;
    const key = `${teamName}|${kind}`;
    const n = noteCounts.get(key) ?? 0;
    if (n >= 2) return;
    noteCounts.set(key, n + 1);
    if (playerId && kind !== "promo") notedPlayers.add(playerId);
    opts.tactics.push(text);
    opts.claims?.push({ text, side, kind, playerId });
  };
  const bowlSide = opts.bowlingSide ?? "Fielding side";
  let ballsSinceWicket = 99;
  const parRpo = PAR_RPO_BY_FORMAT[format];
  const bowlerStatsMap = new Map<string, { runs: number; balls: number; maidens: number; wickets: number }>();
  for (const b of bowlers) {
    bowlerStatsMap.set(b.id, { runs: 0, balls: 0, maidens: 0, wickets: 0 });
  }

  let totalRuns = 0;
  let totalWickets = 0;
  let totalBallsBowled = 0;
  let strikerIdx = 0;
  let nonStrikerIdx = 1;
  let nextBatterIdx = 2;

  let powerplayRuns = 0;
  let middleRuns = 0;
  let deathRuns = 0;

  const ppEnd = format === "T20" ? 6 : format === "ODI" ? 10 : 25;
  const deathStart = format === "T20" ? 16 : format === "ODI" ? 41 : 80;

  let lastBowlerId: string | null = null;
  let matchEnded = false;

  const fieldingSide = bowlingLineup.filter((p): p is PlayerWithStats => p !== null);
  const keeper = fieldingSide.find((p) => p.primary_role === "WK");
  const fielderMap = new Map<string, FielderScorecard>();
  for (const f of fieldingSide) fielderMap.set(f.id, { playerId: f.id, name: f.name, catches: 0, runOuts: 0, stumpings: 0 });
  let droppedCatches = 0;
  const drops: NonNullable<InningsScorecard["drops"]> = [];
  const dropCards: BatterScorecard[] = [];
  const fallOfWickets: { wicket: number; runs: number; balls: number }[] = [];

  let declared = false;
  for (let over = 1; over <= maxOvers; over++) {
    if (totalWickets >= wicketLimit) break;
    if (target && totalRuns >= target) break;
    // Tests: the captain declares at the end of the over in which the side reaches its declaration total
    if (opts.declareAt !== undefined && totalRuns >= opts.declareAt) {
      declared = true;
      break;
    }

    const phase: "PP" | "MID" | "DEATH" =
      opts.phase ?? (over <= ppEnd ? "PP" : over >= deathStart ? "DEATH" : "MID");

    // Select Bowler for this Over (cannot be same bowler as immediate previous over)
    // How the batting side is going relative to what it needs (chase) or to a par score
    const oversDone = totalBallsBowled / 6;
    const refRpo = target ? target / maxOvers : parRpo;
    const ahead = oversDone >= 3 ? totalRuns / oversDone / refRpo : 1;
    const picked = selectBowlerForOver(
      bowlers, phase, pitch_type, country, over, maxOvers, bowlerStatsMap, lastBowlerId, rng, format,
      {
        striker: battersInOrder[strikerIdx]?.player,
        newBatter: ballsSinceWicket < 12,
        ahead,
        parRpo,
        deteriorated: isDeterioratedPitch,
        plan: opts.plan,
      }
    );
    const bowler = picked.bowler;
    if (picked.reason) note(`${bowlSide}: ${picked.reason.text}`, picked.reason.kind, bowler.id, bowlSide === "Your XI" ? "Your XI" : "AI XI");
    lastBowlerId = bowler.id;
    const bStats = bowlerStatsMap.get(bowler.id)!;

    let overRuns = 0;

    for (let ball = 1; ball <= 6; ball++) {
      if (totalWickets >= wicketLimit || (target && totalRuns >= target)) {
        matchEnded = true;
        break;
      }

      totalBallsBowled++;

      const striker = batterCards[strikerIdx];
      const strikerData = battersInOrder[strikerIdx]?.player;

      if (!striker || !strikerData) break;

      // Ball outcome based on real statistics and match situation
      const ballOutcome = resolveBall(
        strikerData,
        bowler,
        phase,
        pitch_type,
        country,
        format,
        totalWickets,
        striker.runs,
        striker.balls,
        isDeterioratedPitch,
        rng
      );

      striker.balls++;
      bStats.balls++;
      ballsSinceWicket++;

      if (ballOutcome.isOut) {
        striker.isOut = true;
        const how = rollDismissal(totalBallsBowled * 7919 + totalRuns * 104729 + totalWickets * 1299709 + strikerIdx, bowler, fieldingSide, keeper, isTest);
        striker.dismissal = dismissalText(how.kind, bowler, how.fielder);
        if (how.kind !== "RUN_OUT") striker.bowlerId = bowler.id;
        totalWickets++;
        if (how.kind !== "RUN_OUT") bStats.wickets++; // a run out is not the bowler's wicket
        const card = how.fielder ? fielderMap.get(how.fielder.id) : undefined;
        if (card) {
          if (how.kind === "RUN_OUT") card.runOuts++;
          else if (how.kind === "STUMPED") card.stumpings++;
          else card.catches++;
        }
        fallOfWickets.push({ wicket: totalWickets, runs: totalRuns, balls: totalBallsBowled });

        ballsSinceWicket = 0;
        if (nextBatterIdx < batterCards.length) {
          // The batting side reads the situation and may send in a different batter than the order says
          const promoted = chooseNextBatter(battersInOrder, nextBatterIdx, {
            format, over, maxOvers, wickets: totalWickets, runs: totalRuns, target, phase, pitch: pitch_type, parRpo,
          });
          if (promoted > nextBatterIdx) {
            const [a, b] = [battersInOrder[nextBatterIdx], battersInOrder[promoted]];
            battersInOrder[nextBatterIdx] = b;
            battersInOrder[promoted] = a;
            const [ca, cb] = [batterCards[nextBatterIdx], batterCards[promoted]];
            batterCards[nextBatterIdx] = cb;
            batterCards[promoted] = ca;
            note(`${teamName}: ${b.player.name} promoted up the order ${promotionWhy(format, phase, totalWickets, target)}`, "promo", b.player.id, teamName === "Your XI" ? "Your XI" : "AI XI");
          }
          strikerIdx = nextBatterIdx;
          nextBatterIdx++;
        }
      } else {
        const runs = ballOutcome.runs;
        // A catch put down off this ball (about one in 250 deliveries); what the batter makes from here is the cost
        if (striker.balls > 1 && (totalBallsBowled * 31 + totalRuns * 7) % 250 === 0) {
          const others = fieldingSide.filter((f) => f.id !== bowler.id);
          const dropper = others[(totalBallsBowled * 17 + totalRuns) % Math.max(1, others.length)];
          if (dropper) {
            droppedCatches++;
            drops.push({ fielder: dropper.name, fielderId: dropper.id, batter: striker.name, bowler: bowler.name, runsAtDrop: striker.runs });
            dropCards.push(striker);
          }
        }
        striker.runs += runs;
        overRuns += runs;
        bStats.runs += runs;
        totalRuns += runs;

        if (runs === 4) striker.fours++;
        if (runs === 6) striker.sixes++;

        // Strike rotation on odd runs
        if (runs % 2 === 1) {
          const temp = strikerIdx;
          strikerIdx = nonStrikerIdx;
          nonStrikerIdx = temp;
        }
      }
    }

    if (phase === "PP") powerplayRuns += overRuns;
    else if (phase === "DEATH") deathRuns += overRuns;
    else middleRuns += overRuns;

    if (matchEnded) break;

    // End of over: switch strike
    const temp = strikerIdx;
    strikerIdx = nonStrikerIdx;
    nonStrikerIdx = temp;
  }

  // Finalize strike rates
  for (const b of batterCards) {
    b.strikeRate = b.balls > 0 ? Math.round((b.runs / b.balls) * 1000) / 10 : 0;
  }

  // Exact cricket notation
  const completedOvers = Math.floor(totalBallsBowled / 6);
  const remainderBalls = totalBallsBowled % 6;
  const oversString = `${completedOvers}.${remainderBalls}`;
  const oversCompleted = completedOvers + (remainderBalls / 6);

  // Finalize bowler scorecards
  const bowlerCards: BowlerScorecard[] = bowlers
    .filter((b) => (bowlerStatsMap.get(b.id)?.balls || 0) > 0)
    .map((b) => {
      const stats = bowlerStatsMap.get(b.id)!;
      const cOvers = Math.floor(stats.balls / 6);
      const rBalls = stats.balls % 6;
      const oversStr = `${cOvers}.${rBalls}`;
      const econ = stats.balls > 0 ? Math.round((stats.runs / (stats.balls / 6)) * 10) / 10 : 0;
      return {
        playerId: b.id,
        name: b.name,
        country: b.country,
        overs: oversStr,
        maidens: stats.maidens,
        runs: stats.runs,
        wickets: stats.wickets,
        economy: econ,
      };
    });

  return {
    teamName,
    inningsNumber,
    totalRuns,
    totalWickets,
    totalBalls: totalBallsBowled,
    oversString,
    oversCompleted,
    maxOvers,
    batters: batterCards,
    bowlers: bowlerCards,
    fielders: [...fielderMap.values()].filter((f) => f.catches + f.runOuts + f.stumpings > 0),
    droppedCatches,
    drops: drops.map((d, i) => ({ ...d, reprieveRuns: Math.max(0, dropCards[i].runs - (d.runsAtDrop ?? 0)) })),
    ...(declared ? { declared: true } : {}),
    fallOfWickets,
    phaseRuns: {
      powerplay: powerplayRuns,
      middle: middleRuns,
      death: deathRuns,
    },
  };
}

type DismissalKind = "BOWLED" | "LBW" | "CAUGHT" | "CAUGHT_BEHIND" | "CAUGHT_AND_BOWLED" | "RUN_OUT" | "STUMPED";

/**
 * Decides how a wicket fell. Uses its own hash-based roll so the main simulation's random stream
 * (and therefore every score and result) is untouched.
 */
/** A wicket cluster (5 wickets for next to nothing) is reported for either side, bowled out or not. */
function addClusterLines(analysis: { whyLoserLost: string[]; whyWinnerWon: string[] }, facts: MatchFacts, keyMoments: KeyMoment[]): void {
  for (const side of ["USER", "AI"] as const) {
    const c = facts.sides[side].cluster;
    if (!c) continue;
    const label = side === "USER" ? "Your XI" : "AI XI";
    const text = `${label} lost wickets ${c.fromWicket}-${c.toWicket} for ${c.runs} runs (from ${c.startScore} to ${c.endScore}).`;
    (facts.winner === side ? analysis.whyWinnerWon : analysis.whyLoserLost).push(text);
    keyMoments.push({ over: "Collapse", title: "Wicket Cluster", description: text, impactTeam: side === "USER" ? "AI" : "USER" });
  }
}

/** One line naming who put down whom, for the side that fielded worse; appended to the match story. */
function dropsNarrative(userBowlInnings: InningsScorecard[], aiBowlInnings: InningsScorecard[]): { side: "USER" | "AI"; text: string }[] {
  const out: { side: "USER" | "AI"; text: string }[] = [];
  // userBowlInnings = innings in which the user's side fielded (the AI batted)
  for (const [side, list] of [["USER", userBowlInnings], ["AI", aiBowlInnings]] as const) {
    const drops = list.flatMap((i) => i.drops ?? []);
    if (drops.length === 0) continue;
    const first = drops[0];
    const label = side === "USER" ? "Your XI" : "AI XI";
    out.push({
      side,
      text: `${label} put down ${drops.length === 1 ? "a catch" : `${drops.length} catches`}: ${first.fielder} dropped ${first.batter} off ${first.bowler}${first.reprieveRuns ? `, who went on to add ${first.reprieveRuns}` : ""}${drops.length > 1 ? ` (and ${drops.length - 1} more)` : ""}.`,
    });
  }
  return out;
}

function rollDismissal(
  salt: number,
  bowler: PlayerWithStats,
  fielders: PlayerWithStats[],
  keeper: PlayerWithStats | undefined,
  isTest: boolean
): { kind: DismissalKind; fielder?: PlayerWithStats } {
  const roll = (n: number) => {
    let h = Math.imul(salt + n * 374761393, 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 3266489917) >>> 0;
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  const r = roll(1);
  const spin = bowler.bowling_category === "SPIN";
  const others = fielders.filter((f) => f.id !== bowler.id && f.id !== keeper?.id);
  const pickOther = () => (others.length ? others[Math.floor(roll(2) * others.length)] : keeper);

  const bowled = isTest ? 0.2 : 0.18;
  const lbw = isTest ? 0.18 : 0.12;
  const cb = 0.05;
  const runOut = isTest ? 0.03 : 0.07;
  const stumped = spin && keeper ? (isTest ? 0.06 : 0.1) : 0;

  let acc = bowled;
  if (r < acc) return { kind: "BOWLED" };
  if (r < (acc += lbw)) return { kind: "LBW" };
  if (r < (acc += cb)) return { kind: "CAUGHT_AND_BOWLED", fielder: bowler };
  if (r < (acc += runOut)) return { kind: "RUN_OUT", fielder: pickOther() };
  if (r < (acc += stumped) && keeper) return { kind: "STUMPED", fielder: keeper };
  if (keeper && roll(3) < 0.2) return { kind: "CAUGHT_BEHIND", fielder: keeper };
  return { kind: "CAUGHT", fielder: pickOther() };
}

function dismissalText(kind: DismissalKind, bowler: PlayerWithStats, fielder?: PlayerWithStats): string {
  switch (kind) {
    case "BOWLED": return `b ${bowler.name}`;
    case "LBW": return `lbw b ${bowler.name}`;
    case "CAUGHT_AND_BOWLED": return `c & b ${bowler.name}`;
    case "CAUGHT_BEHIND": return `c †${fielder?.name ?? "keeper"} b ${bowler.name}`;
    case "STUMPED": return `st †${fielder?.name ?? "keeper"} b ${bowler.name}`;
    case "RUN_OUT": return `run out (${fielder?.name ?? "direct hit"})`;
    default: return `c ${fielder?.name ?? "fielder"} b ${bowler.name}`;
  }
}

/** Three best hitters among non-bowlers, by strike rate weighted with batting average. */
function pickSuperOverBatters(squad: (PlayerWithStats | null)[]): PlayerWithStats[] {
  const all = squad.filter((p): p is PlayerWithStats => p !== null);
  const rating = (p: PlayerWithStats) => p.stats.bat_strike_rate * Math.min(45, Math.max(10, p.stats.bat_average));
  const pool = all.filter((p) => p.primary_role !== "BOWL");
  return (pool.length >= 3 ? pool : all).sort((a, b) => rating(b) - rating(a)).slice(0, 3);
}

/** Best economy among frontline bowlers who actually bowl. */
function pickSuperOverBowler(squad: (PlayerWithStats | null)[]): PlayerWithStats {
  const all = squad.filter((p): p is PlayerWithStats => p !== null);
  const bowlers = all.filter((p) => (p.primary_role === "BOWL" || p.primary_role === "AR") && p.stats.bowl_overs > 0);
  const econ = (p: PlayerWithStats) => (p.stats.bowl_economy > 0 ? p.stats.bowl_economy : 99);
  return (bowlers.length ? bowlers : all).sort((a, b) => econ(a) - econ(b))[0];
}

function boundariesOf(inn: InningsScorecard): number {
  return inn.batters.reduce((n, b) => n + b.fours + b.sixes, 0);
}

/**
 * T20 super over: each side bats one over (best three hitters, 2 wickets ends it) against the
 * opposition's best bowler. The side that batted second in the match bats first. A tied super over
 * is repeated (up to 3 times), then the side with more boundaries in the match and super overs wins.
 */
function simulateSuperOver(
  userSquad: (PlayerWithStats | null)[],
  aiSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  firstTeamInMatch: "USER" | "AI",
  matchInnings: [InningsScorecard, InningsScorecard],
  rng: () => number
): SuperOverResult {
  const squads = { USER: userSquad, AI: aiSquad };
  const names = { USER: "Your XI", AI: "AI XI" };
  const rounds: SuperOverRound[] = [];
  const boundaries = { USER: 0, AI: 0 };
  const [inn1, inn2] = matchInnings;
  boundaries[firstTeamInMatch] += boundariesOf(inn1);
  boundaries[firstTeamInMatch === "USER" ? "AI" : "USER"] += boundariesOf(inn2);

  let battingFirst: "USER" | "AI" = firstTeamInMatch === "USER" ? "AI" : "USER";
  for (let round = 0; round < 3; round++) {
    const second: "USER" | "AI" = battingFirst === "USER" ? "AI" : "USER";
    const opts = { wicketLimit: 2, phase: "DEATH" as const };
    const a = simulateInnings(pickSuperOverBatters(squads[battingFirst]), [pickSuperOverBowler(squads[second])], challenge, 1, names[battingFirst], undefined, rng, 1, false, opts);
    const b = simulateInnings(pickSuperOverBatters(squads[second]), [pickSuperOverBowler(squads[battingFirst])], challenge, 1, names[second], a.totalRuns + 1, rng, 1, false, opts);
    boundaries[battingFirst] += boundariesOf(a);
    boundaries[second] += boundariesOf(b);
    rounds.push({
      battingFirst,
      firstRuns: a.totalRuns,
      firstWickets: a.totalWickets,
      secondRuns: b.totalRuns,
      secondWickets: b.totalWickets,
    });

    const line = `${names[battingFirst]} ${a.totalRuns}/${a.totalWickets}, ${names[second]} ${b.totalRuns}/${b.totalWickets}`;
    if (a.totalRuns !== b.totalRuns) {
      const winner = b.totalRuns > a.totalRuns ? second : battingFirst;
      return {
        rounds,
        decidedBy: "RUNS",
        winner,
        summary: `${names[winner]} won the Super Over (${line}).`,
      };
    }
    battingFirst = second; // another super over: the side that batted second now bats first
  }

  if (boundaries.USER !== boundaries.AI) {
    const winner = boundaries.USER > boundaries.AI ? "USER" : "AI";
    return {
      rounds,
      decidedBy: "BOUNDARIES",
      winner,
      summary: `${names[winner]} won on boundary count (${boundaries.USER} v ${boundaries.AI}) after ${rounds.length} tied Super Overs.`,
    };
  }
  return {
    rounds,
    decidedBy: "NONE",
    winner: "TIE",
    summary: `The match stayed tied after ${rounds.length} Super Overs and level boundary counts.`,
  };
}

/**
 * Intelligent bowler selection taking into account quotas and consecutive over restrictions.
 */
const PAR_RPO_BY_FORMAT: Record<MatchFormat, number> = { T20: 9.0, ODI: 5.6, TEST: 3.7 };

interface BowlCtx {
  striker?: PlayerWithStats;
  /** A wicket fell in the last couple of overs, so a new batter is at the crease. */
  newBatter: boolean;
  /** Batting side's run rate over what it needs (1 = on course). */
  ahead: number;
  parRpo: number;
  deteriorated: boolean;
  plan?: BowlingPlan;
}

/**
 * How a batter's hand and a bowler's style interact. Small, symmetric edges: they decide close
 * calls and reward choosing bowlers for the batter at the crease, without swamping career quality.
 */
function matchup(batter: PlayerWithStats, bowler: PlayerWithStats, phase: "PP" | "MID" | "DEATH", format: MatchFormat): { wkt: number; runs: number } {
  const style = (bowler.bowling_style || "").toLowerCase();
  const left = batter.batting_hand === "LHB";
  let wkt = 1;
  if (bowler.bowling_category === "SPIN") {
    if (style.includes("slow left")) wkt = left ? 0.94 : 1.07; // orthodox turns away from the right-hander
    else if (style.includes("offbreak") || style.includes("off break")) wkt = left ? 0.93 : 1.05; // off-spin turns away from the left-hander
    else if (style.includes("leg") || style.includes("googly")) wkt = left ? 1.07 : 0.99;
    // Big hitters take on spin in the middle overs: more runs, more risk
    const hitter = (batter.stats.bat_strike_rate || 0) >= (format === "T20" ? 135 : format === "ODI" ? 95 : 60);
    if (hitter && phase === "MID") {
      return { wkt: wkt * 1.06, runs: 1.04 };
    }
  } else if (bowler.bowling_category === "PACE") {
    const leftArm = style.includes("left-arm");
    wkt = leftArm ? (left ? 0.97 : 1.05) : left ? 1.04 : 1;
    // Settled anchors handle the new ball better than hitters
    const anchor = (batter.stats.bat_average || 0) >= 38 && (batter.stats.bat_strike_rate || 0) < (format === "T20" ? 125 : 85);
    if (anchor && phase === "PP") wkt *= 0.95;
  }
  return { wkt, runs: 1 - (wkt - 1) * 0.6 };
}

/** Which batter the batting side sends in next: sticks to the order unless the situation calls for a change. */
function chooseNextBatter(
  batters: { player: PlayerWithStats; slotIndex: number }[],
  next: number,
  c: { format: MatchFormat; over: number; maxOvers: number; wickets: number; runs: number; target?: number; phase: "PP" | "MID" | "DEATH"; pitch: PitchType; parRpo: number }
): number {
  if (c.format === "TEST") return next; // Tests keep the order; nightwatchmen are not modelled
  const window = batters.slice(next, next + 3).map((b, i) => ({ b, idx: next + i }));
  if (window.length < 2) return next;
  const sr = (p: PlayerWithStats) => p.stats.bat_strike_rate || 0;
  const avg = (p: PlayerWithStats) => p.stats.bat_average || 0;
  const ballsLeft = (c.maxOvers - c.over + 1) * 6;
  const hitterSr = c.format === "T20" ? 130 : 90;
  const isLowerOrder = (p: PlayerWithStats) => p.primary_role === "BOWL";
  // Never promote a tail-ender
  const pool = window.filter((w) => !isLowerOrder(w.b.player) || w.idx === next);

  // 1. Death overs or a steep chase: send in the biggest hitter available
  const steepChase = c.target ? (c.target - c.runs) / Math.max(1, ballsLeft / 6) > c.parRpo * 1.25 : false;
  if ((c.phase === "DEATH" || steepChase) && c.wickets <= 7) {
    const best = pool.reduce((m, w) => (sr(w.b.player) > sr(m.b.player) ? w : m), pool[0]);
    if (best.idx !== next && sr(best.b.player) >= hitterSr && sr(best.b.player) > sr(pool[0].b.player) + 8) return best.idx;
  }
  // 2. Early collapse: send in the sturdiest batter to rebuild
  const earlyCollapse = c.wickets >= 3 && c.over <= (c.format === "T20" ? 8 : 20);
  if (earlyCollapse) {
    const best = pool.reduce((m, w) => (avg(w.b.player) > avg(m.b.player) ? w : m), pool[0]);
    if (best.idx !== next && avg(best.b.player) > avg(pool[0].b.player) + 8) return best.idx;
  }
  return next;
}

function promotionWhy(format: MatchFormat, phase: "PP" | "MID" | "DEATH", wickets: number, target?: number): string {
  if (phase === "DEATH") return "to finish the innings";
  if (target && wickets < 4) return "to keep up the chase";
  if (wickets >= 3) return "to rebuild after the early wickets";
  return "to suit the situation";
}

function selectBowlerForOver(
  bowlers: PlayerWithStats[],
  phase: "PP" | "MID" | "DEATH",
  pitch: PitchType,
  country: string,
  over: number,
  maxOvers: number,
  statsMap: Map<string, { balls: number; runs: number }>,
  lastBowlerId: string | null,
  rng: () => number,
  format: MatchFormat = "T20",
  ctx: BowlCtx = { newBatter: false, ahead: 1, parRpo: 8, deteriorated: false }
): { bowler: PlayerWithStats; reason?: { text: string; kind: string } } {
  const isTest = format === "TEST";
  const maxQuotaBalls = isTest ? 30 * 6 : Math.floor((maxOvers / 5) * 6);

  // Eligible bowlers with quota remaining
  let eligible = bowlers.filter((b) => (statsMap.get(b.id)?.balls || 0) < maxQuotaBalls);
  if (eligible.length === 0) eligible = bowlers;

  // Rule of Cricket: A bowler cannot bowl consecutive overs if another bowler is available
  if (lastBowlerId && eligible.length > 1) {
    const withoutLast = eligible.filter((b) => b.id !== lastBowlerId);
    if (withoutLast.length > 0) eligible = withoutLast;
  }

  const newBallIds = ctx.plan?.newBall ?? [];
  const wicketRate = (b: PlayerWithStats) => (b.stats.bowl_overs > 0 ? b.stats.bowl_wickets / b.stats.bowl_overs : 0.12);

  // Score candidate bowlers for this phase
  const scored = eligible.map((b) => {
    let weight = 10;
    const why: { w: number; text: string; kind: string }[] = [];
    const add = (w: number, text?: string, kind = "other") => {
      weight += w;
      if (text && Math.abs(w) >= 30) why.push({ w, text, kind });
    };
    const isPacer = b.bowling_category === "PACE";
    const isSpinner = b.bowling_category === "SPIN";
    const isSpecialist = b.primary_role === "BOWL";
    const isAR = b.primary_role === "AR";
    const isPartTimer = b.primary_role === "BAT";

    // Role Hierarchy: Specialists & All-Rounders heavily favored
    if (isSpecialist) weight += 140;
    else if (isAR) weight += 80;
    else if (isPartTimer) weight -= 150;

    // Opening Spell (Overs 1 & 2): Must be spearhead opening pacers
    if (over <= 2) {
      if (isSpecialist && isPacer) weight += 300;
      else if (isSpecialist) weight += 150;
      else if (isAR && isPacer) weight += 100;
      else weight -= 1000; // Never open with part-timers
      // The captain's plan, or a turning pitch, can change who takes the new ball
      if (newBallIds.includes(b.id)) add(400, `${b.name} takes the new ball as planned`, "plan");
      else if (!isTest && pitch === "DUSTBOWL" && isSpinner && isSpecialist) add(170, `${b.name} (spin) opens the bowling on a turning pitch`, "open");
      else if (!isTest && pitch === "SLOW_LOW" && format === "T20" && isSpinner && isSpecialist) add(95, `${b.name} (spin) opens on a slow surface`, "open");
    } else if (phase === "PP") {
      if (isSpecialist && isPacer) weight += isTest ? 60 : 45;
      else if (isSpecialist) weight += 30;
      if (pitch === "GREEN_SEAMER" && isPacer) weight += 35;
      if (isPartTimer) weight -= 500;
    }

    if (phase === "DEATH") {
      if (format === "T20") {
        if (b.stats.bowl_economy > 0 && b.stats.bowl_economy <= 7.8) weight += 50;
        if (isPacer) weight += 25;
      } else if (format === "ODI") {
        if (b.stats.bowl_economy > 0 && b.stats.bowl_economy <= 5.5) weight += 45;
        if (isPacer) weight += 25;
      } else {
        if (isPacer) weight += 40;
      }
      if (isPartTimer) weight -= 800; // Never bowl part-timer in death overs
      if (ctx.plan?.death === b.id) add(170, `${b.name} is held back for the death overs`, "death");
    }

    // The death specialist keeps his last two overs back for the end of the innings
    if (!isTest && phase !== "DEATH" && ctx.plan?.death === b.id && (statsMap.get(b.id)?.balls || 0) >= maxQuotaBalls - 12) weight -= 500;

    if (phase === "MID") {
      if (isSpinner && (pitch === "DUSTBOWL" || pitch === "SLOW_LOW")) weight += 45;
      else if (isSpinner && pitch !== "GREEN_SEAMER") weight += 25;
      // On a green seamer the seamers keep the ball through the middle overs too
      if (pitch === "GREEN_SEAMER" && isPacer) weight += 40;
    }

    if (country === "RSA" && isPacer) weight += 20;
    if ((country === "IND" || country === "BAN" || country === "SL") && isSpinner) weight += 20;

    // Right bowler for the batter at the crease
    if (ctx.striker && (isPacer || isSpinner)) {
      const mu = matchup(ctx.striker, b, phase, format);
      add((mu.wkt - 1) * 450, `${b.name} brought on against ${ctx.striker.name}`, "matchup");
    }

    // A new batter has just come in: go to the strike bowler
    if (ctx.newBatter && over > 2) add((wicketRate(b) - 0.12) * 500, `${b.name} is given the ball to attack the new batter`, "strike");

    // Reading the game: attack when the batters are cruising, squeeze when they are behind the rate
    if (b.stats.bowl_economy > 0) {
      if (ctx.ahead >= 1.15) add((wicketRate(b) - 0.12) * 250);
      else if (ctx.ahead <= 0.85) add(Math.max(-40, Math.min(40, (ctx.parRpo - b.stats.bowl_economy) * 12)), `${b.name} is used to keep the run rate down`, "squeeze");
    }

    // Pitch wearing: spin as the surface breaks up, pace with the second new ball
    if (isTest) {
      if (ctx.deteriorated && isSpinner) add(45, `${b.name} (spin) gets the ball as the pitch wears`, "wear");
      if (over >= 80 && isPacer) add(40);
    }

    // A bowler being hit around is taken off
    const st = statsMap.get(b.id);
    if (st && st.balls >= 12) {
      const econ = st.runs / (st.balls / 6);
      if (econ > ctx.parRpo * 1.45) add(-70, `${b.name} is taken off after an expensive spell`, "off");
    }

    return { bowler: b, weight: weight + rng() * 10, why };
  });

  scored.sort((a, b) => b.weight - a.weight);
  const top = scored[0];
  if (!top) return { bowler: eligible[0] };
  // Only report the most decisive reason, and only when it truly tipped the choice
  const reason = top.why.filter((x) => x.w > 0).sort((a, b) => b.w - a.w)[0];
  return { bowler: top.bowler, reason };
}

/**
 * Ball model tuning. Each ball pits one batter against one bowler:
 * - wicket chance = format base x (typical balls-per-dismissal / batter's) ^ BAT_WKT
 *                                 x (typical bowling strike rate / bowler's) ^ BOWL_WKT
 * - runs per scoring chance = format base x (batter SR / typical) ^ BAT_RUNS x (bowler economy / typical) ^ BOWL_RUNS
 * The exponents set how much skill decides a match; the bases set how many runs and wickets a
 * typical international side gets. Both are calibrated with tests/skill-signal.test.ts and
 * tests/calibration.test.ts.
 */
export const BALL_MODEL: Record<MatchFormat, { BAT_WKT: number; BOWL_WKT: number; BAT_RUNS: number; BOWL_RUNS: number }> = {
  // T20: scoring rate and economy decide matches; ODI in between; Tests: survival and wicket-taking
  T20: { BAT_WKT: 0.9, BOWL_WKT: 0.8, BAT_RUNS: 1.4, BOWL_RUNS: 1.4 },
  ODI: { BAT_WKT: 1.2, BOWL_WKT: 1.1, BAT_RUNS: 1.2, BOWL_RUNS: 1.1 },
  TEST: { BAT_WKT: 1.4, BOWL_WKT: 1.4, BAT_RUNS: 0.8, BOWL_RUNS: 0.7 },
};

interface FormatBase {
  /** Wicket chance per ball for a typical batter against a typical bowler. */
  wkt: number;
  /** Expected runs per non-dismissal ball, typical batter v typical bowler. */
  rpb: number;
  /** Share of balls that are dots at the base scoring rate. */
  dot: number;
  /** Typical top-seven batter: balls per dismissal and strike rate. */
  bpd: number;
  sr: number;
  /** Typical frontline bowler: balls per wicket and economy. */
  bowlSr: number;
  econ: number;
  /** Share of boundaries that are sixes for a typical batter. */
  six: number;
}

export const FORMAT_BASE: Record<MatchFormat, FormatBase> = {
  // wkt is a typical batter's own dismissal rate (1 / balls per dismissal), trimmed so the pitch and
  // matchup boosts on top don't push batters far below their career averages
  T20: { wkt: 0.85 / 21, rpb: 1.3, dot: 0.36, bpd: 21, sr: 125, bowlSr: 20, econ: 7.6, six: 0.38 },
  ODI: { wkt: 0.8 / 40, rpb: 0.92, dot: 0.48, bpd: 40, sr: 82, bowlSr: 38, econ: 5.1, six: 0.22 },
  TEST: { wkt: 0.74 / 75, rpb: 0.56, dot: 0.72, bpd: 75, sr: 52, bowlSr: 62, econ: 3.1, six: 0.08 },
};

interface BallProfile {
  /** Balls faced per dismissal, shrunk towards a lower-order batter for small samples. */
  bpd: number;
  sr: number;
  /** Balls bowled per wicket and economy, shrunk towards a part-timer. */
  bowlSr: number;
  econ: number;
}

const profileCache = new WeakMap<PlayerWithStats["stats"], Map<MatchFormat, BallProfile>>();

/** A player's per-ball numbers in a format: era-adjusted career stats, with small samples shrunk. */
function ballProfile(raw: PlayerWithStats, format: MatchFormat): BallProfile {
  let byFormat = profileCache.get(raw.stats);
  const hit = byFormat?.get(format);
  if (hit) return hit;
  const s = eraAdjusted(raw, format).stats;
  const base = FORMAT_BASE[format];
  const inn = Math.max(0, s.bat_innings || 0);
  const sr = Math.max(25, s.bat_strike_rate || base.sr * 0.8);
  const avg = Math.max(2, s.bat_average || 8);
  // Prior: a lower-order batter (60% of a typical batter's survival, 85% of his scoring rate)
  const k = 15;
  const bpdRaw = Math.min(avg / (sr / 100), base.bpd * 3);
  const bpd = (bpdRaw * inn + base.bpd * 0.6 * k) / (inn + k);
  const srShrunk = (sr * inn + base.sr * 0.85 * k) / (inn + k);
  // Bowling: balls per wicket and economy, with a part-timer prior worth 10 wickets
  const balls = Math.max(0, (s.bowl_overs || 0) * 6);
  const wkts = Math.max(0, s.bowl_wickets || 0);
  const priorW = 10;
  const bowlSr = (balls + base.bowlSr * 1.35 * priorW) / (wkts + priorW);
  const econRaw = s.bowl_economy > 0 ? s.bowl_economy : base.econ * 1.15;
  const overs = balls / 6;
  const econ = (econRaw * overs + base.econ * 1.15 * 40) / (overs + 40);
  const prof = { bpd, sr: srShrunk, bowlSr, econ };
  if (!byFormat) profileCache.set(raw.stats, (byFormat = new Map()));
  byFormat.set(format, prof);
  return prof;
}

/**
 * Ball resolution: batter skill against bowler skill, then conditions and match situation
 * (phase, wickets in hand, a set batter, the pitch, hand-v-style matchups).
 */
function resolveBall(
  batter: PlayerWithStats,
  bowler: PlayerWithStats,
  phase: "PP" | "MID" | "DEATH",
  pitch: PitchType,
  country: string,
  format: MatchFormat,
  totalWicketsDown: number,
  batterRunsSoFar: number,
  batterBallsSoFar: number,
  isDeterioratedPitch: boolean,
  rng: () => number
): { runs: number; isOut: boolean } {
  const isTest = format === "TEST";
  const isOdi = format === "ODI";
  const base = FORMAT_BASE[format];
  const bat = ballProfile(batter, format);
  const bowl = ballProfile(bowler, format);
  const M = BALL_MODEL[format];

  // --- Wicket -----------------------------------------------------------------------------
  let wktChance = base.wkt * Math.pow(base.bpd / bat.bpd, M.BAT_WKT) * Math.pow(base.bowlSr / bowl.bowlSr, M.BOWL_WKT);

  // Pitch condition impact. In Tests the effect is softer per ball: it compounds over 90 overs a day
  // (full-size boosts made green-seamer Tests finish in two days)
  const pitchEffect = (m: number) => (isTest ? 1 + (m - 1) * 0.6 : m);
  if (pitch === "GREEN_SEAMER" && bowler.bowling_category === "PACE") {
    wktChance *= pitchEffect(phase === "PP" ? 1.45 : 1.25);
  } else if (pitch === "GREEN_SEAMER" && bowler.bowling_category === "SPIN") {
    wktChance *= pitchEffect(0.8); // spin gets no help from a seaming surface
  } else if (pitch === "DUSTBOWL" && bowler.bowling_category === "PACE") {
    wktChance *= pitchEffect(0.88);
  } else if (pitch === "DUSTBOWL" && bowler.bowling_category === "SPIN") {
    wktChance *= pitchEffect(isDeterioratedPitch ? 1.6 : 1.35);
  } else if (country === "RSA" && bowler.bowling_category === "PACE") {
    wktChance *= pitchEffect(1.3);
  }

  // Batter v bowler matchup (hand v style), applied identically to both sides
  const mu = matchup(batter, bowler, phase, format);
  wktChance *= mu.wkt;

  // A set batter is harder to dislodge
  if (batterBallsSoFar >= 25 && batterRunsSoFar >= 25) wktChance *= 0.72;

  if (rng() < Math.min(0.5, wktChance)) return { runs: 0, isOut: true };

  // --- Runs -------------------------------------------------------------------------------
  let rpb = base.rpb * Math.pow(bat.sr / base.sr, M.BAT_RUNS) * Math.pow(bowl.econ / base.econ, M.BOWL_RUNS);
  rpb *= mu.runs;
  const wicketsInHand = 10 - totalWicketsDown;

  // Phase tempo, by wickets in hand and the batter's type
  if (isTest) {
    rpb *= phase === "PP" ? 0.85 : 1.0; // leaving the new ball
  } else if (isOdi) {
    if (phase === "PP") rpb *= 1.05;
    else if (phase === "MID") rpb *= wicketsInHand >= 7 ? 1.05 : 0.95;
    else {
      rpb *= wicketsInHand >= 6 ? 1.32 : wicketsInHand >= 4 ? 1.16 : 0.92;
      if (bat.sr >= 95 || batter.stats.finisher_innings >= 4) rpb *= 1.1;
      if (batterRunsSoFar >= 25) rpb *= 1.08;
    }
  } else {
    if (phase === "PP") rpb *= 1.06;
    else if (phase === "MID") rpb *= wicketsInHand >= 7 ? 1.02 : 0.95;
    else {
      rpb *= wicketsInHand >= 6 ? 1.25 : wicketsInHand >= 4 ? 1.12 : 0.95;
      if (batter.stats.finisher_innings >= 5 || bat.sr >= 140) rpb *= 1.08;
      if (batterRunsSoFar >= 20) rpb *= 1.06;
    }
  }

  // Pitch modifier on runs
  if (pitch === "HIGH_SCORING_FLAT") rpb *= 1.1;
  if (pitch === "SLOW_LOW") rpb *= 0.9;
  if (pitch === "GREEN_SEAMER") rpb *= 0.96;
  if (pitch === "DUSTBOWL") rpb *= 0.97;
  if (isDeterioratedPitch) rpb *= 0.85;

  rpb = Math.max(0.15, Math.min(isTest ? 1.6 : 2.6, rpb));
  return { runs: rollRuns(rpb, base, bat.sr / base.sr, rng), isOut: false };
}

/**
 * Splits an expected runs-per-ball into dots, ones, twos, threes, fours and sixes. Faster scoring
 * means fewer dots and more boundaries; hitters (high strike rate) clear the rope more often.
 * The expected value of the split equals `rpb` unless it hits a hard limit.
 */
function rollRuns(rpb: number, base: FormatBase, srRatio: number, rng: () => number): number {
  const dot = Math.max(0.12, Math.min(0.88, base.dot * Math.pow(base.rpb / rpb, 0.85)));
  const scoring = 1 - dot;
  const meanScoring = rpb / scoring;
  // Ones, twos and threes average about 1.2; a boundary averages 4 + 2 x the six share
  const six = Math.max(0.02, Math.min(0.7, base.six * Math.pow(srRatio, 1.5)));
  const boundaryMean = 4 + 2 * six;
  const running = 1.2;
  const boundary = Math.max(0, Math.min(0.75, (meanScoring - running) / (boundaryMean - running)));
  const r = rng();
  if (r < dot) return 0;
  const u = (r - dot) / scoring;
  if (u < boundary) return u < boundary * six ? 6 : 4;
  const v = (u - boundary) / Math.max(1e-9, 1 - boundary);
  return v < 0.84 ? 1 : v < 0.98 ? 2 : 3;
}

function determinePlayerOfTheMatch(facts: MatchFacts): { name: string; team: "USER" | "AI"; performance: string } {
  // Same awards object as Best Pick and the decisive-difference text.
  const a = facts.awards.playerOfMatch;
  if (!a) return { name: "Match Aggregate", team: "USER", performance: "All-round team display" };
  return { name: a.name, team: a.team, performance: a.line };
}

/**
 * Builds an authentic, data-driven 5-day chronicle of a Test Match.
 */
function buildTestDayChronicle(
  firstBatTeam: "Your XI" | "AI XI",
  secondBatTeam: "Your XI" | "AI XI",
  firstInn1: InningsScorecard,
  secondInn1: InningsScorecard,
  firstInn2: InningsScorecard,
  secondInn2: InningsScorecard,
  lead: { team: "USER" | "AI"; runs: number },
  target: number,
  winner: "USER" | "AI" | "DRAW" | "TIE",
  summary: string,
  pitchType: PitchType
): TestDayChronicle[] {
  const chronicle: TestDayChronicle[] = [];

  const topBat1 = [...firstInn1.batters].sort((a, b) => b.runs - a.runs)[0];
  const topBowl1 = [...firstInn1.bowlers].sort((a, b) => b.wickets * 25 - b.runs - (a.wickets * 25 - a.runs))[0];

  const topBat2 = [...secondInn1.batters].sort((a, b) => b.runs - a.runs)[0];
  const topBowl2 = [...secondInn1.bowlers].sort((a, b) => b.wickets * 25 - b.runs - (a.wickets * 25 - a.runs))[0];

  const topBat3 = [...firstInn2.batters].sort((a, b) => b.runs - a.runs)[0];
  const topBat4 = [...secondInn2.batters].sort((a, b) => b.runs - a.runs)[0];
  const topBowl4 = [...secondInn2.bowlers].sort((a, b) => b.wickets * 25 - b.runs - (a.wickets * 25 - a.runs))[0];

  const day1Pitch = pitchType === "GREEN_SEAMER"
    ? "Generous morning grass and overcast moisture: seamers extracted steep bounce and sharp deviation off the seam."
    : pitchType === "DUSTBOWL"
    ? "Dry surface with hints of variable grip for finger spinners from Session 2 onwards."
    : pitchType === "SLOW_LOW"
    ? "Sluggish paced wicket with low bounce testing front-foot defense against skiddy deliveries."
    : "Hard, true surface rewarding confident stroke makers through the line.";

  const day3Pitch = pitchType === "DUSTBOWL"
    ? "Footmarks outside off-stump widening noticeably; sharp turn and variable bounce."
    : "Track drying out with reverse swing appearing for the pacers and natural surface wear.";

  const day5Pitch = pitchType === "DUSTBOWL"
    ? "A minefield on Day 5! Dust puffing off length deliveries, extreme spin, and crumbling craters."
    : pitchType === "GREEN_SEAMER"
    ? "Cracks widened on Day 5: variable up-and-down bounce keeping bat and pad under constant danger."
    : "Day 5 attrition: natural pitch deterioration, reverse swing, and low bounce testing the chasers.";

  // DAY 1
  const d1Runs = Math.min(firstInn1.totalRuns, Math.round(firstInn1.totalRuns * 0.92));
  const d1Wkts = Math.min(firstInn1.totalWickets, 4);
  chronicle.push({
    day: 1,
    title: "Day 1: The Opening Standoff",
    stumpsScore: `${firstBatTeam} ${d1Runs}/${d1Wkts} (Stumps, Day 1)`,
    highlight: `${firstBatTeam} weathered testing opening sessions on a fresh wicket. ${topBat1 ? `${topBat1.name} led the resistance with a gritty ${topBat1.runs} runs (${topBat1.balls}b, ${topBat1.fours}x4).` : "The top order dug in resolutely."} ${topBowl1 && topBowl1.wickets > 0 ? `${topBowl1.name} struck for ${secondBatTeam} taking ${topBowl1.wickets} wickets.` : "Bowlers probed disciplined corridors outside off-stump."}`,
    pitchBehavior: day1Pitch,
  });

  // DAY 2
  chronicle.push({
    day: 2,
    title: "Day 2: 1st Innings War of Attrition",
    stumpsScore: `${secondBatTeam} ${Math.round(secondInn1.totalRuns * 0.72)}/${Math.min(secondInn1.totalWickets, 4)} (Stumps, Day 2)`,
    highlight: `${firstBatTeam} concluded their 1st innings on ${firstInn1.totalRuns} (${firstInn1.oversString} ov), with ${topBowl1 ? `${topBowl1.name} returning ${topBowl1.wickets}/${topBowl1.runs}` : "disciplined bowling"}. In reply, ${secondBatTeam} counter-punched behind ${topBat2 ? `${topBat2.name}'s ${topBat2.runs} runs` : "solid batting"}.`,
    pitchBehavior: "Sun baked the surface through afternoon sessions; lateral movement eased as the pitch settled into its truest phase.",
  });

  // DAY 3
  const leadTeamName = lead.team === "USER" ? "Your XI" : "AI XI";
  chronicle.push({
    day: 3,
    title: "Day 3: The First Innings Lead & Turning Point",
    stumpsScore: `${firstBatTeam} (2nd Inn) ${firstInn2.totalRuns > 0 ? `${Math.round(firstInn2.totalRuns * 0.52)}/${Math.min(firstInn2.totalWickets, 3)}` : "Innings completed"} (Stumps, Day 3)`,
    highlight: `${secondBatTeam} finished their 1st innings on ${secondInn1.totalRuns}/${secondInn1.totalWickets}. ${leadTeamName} established a pivotal ${lead.runs}-run 1st innings lead. The match shifted into its second chapter as 2nd innings batting began under changing conditions.`,
    pitchBehavior: day3Pitch,
  });

  // DAY 4
  if (target <= 0) {
    chronicle.push({
      day: 4,
      title: "Day 4: Innings Victory Resolution",
      stumpsScore: "Match Finished (Innings Defeat)",
      highlight: summary,
      pitchBehavior: "Surface broke up completely under unrelenting bowling pressure.",
    });
  } else {
    chronicle.push({
      day: 4,
      title: "Day 4: Setting the Target & Pitch Cracks",
      stumpsScore: `${secondBatTeam} (Target: ${target}) ${Math.round(secondInn2.totalRuns * 0.32)}/${Math.min(secondInn2.totalWickets, 2)} (Stumps, Day 4)`,
      highlight: `${firstBatTeam} completed their 2nd innings on ${firstInn2.totalRuns}/${firstInn2.totalWickets}${topBat3 ? ` (${topBat3.name} ${topBat3.runs}r)` : ""}, setting ${secondBatTeam} a 4th-innings target of ${target} runs to win. ${secondBatTeam} negotiated late evening overs under immense scoreboard pressure.`,
      pitchBehavior: "Pronounced cracks opened up across length. Spinners found puffing dust and reverse swing troubled the top order.",
    });

    // DAY 5
    chronicle.push({
      day: 5,
      title: "Day 5: The Final Day Climax",
      stumpsScore: `${secondBatTeam} 2nd Inn: ${secondInn2.totalRuns}/${secondInn2.totalWickets} (${secondInn2.oversString} ov)`,
      highlight: `${summary} ${topBat4 && topBat4.runs >= 40 ? `${topBat4.name} fought bravely with ${topBat4.runs} (${topBat4.balls}b).` : ""} ${topBowl4 && topBowl4.wickets >= 3 ? `${topBowl4.name}'s spell of ${topBowl4.wickets}/${topBowl4.runs} proved decisive on Day 5.` : ""}`,
      pitchBehavior: day5Pitch,
    });
  }

  return chronicle;
}

/**
 * Derives deeply authentic, data-driven match analysis without generic canned phrases.
 */
function deriveMatchAnalysis(
  userInnings: InningsScorecard,
  aiInnings: InningsScorecard,
  userSquad: (PlayerWithStats | null)[],
  aiSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  winner: "USER" | "AI" | "TIE" | "DRAW",
  ballsRemaining = 0,
  userBatsFirst = true,
  userInn2?: InningsScorecard,
  aiInn2?: InningsScorecard,
  contribs: Contribution[] = []
) {
  const pitch = challenge.venue.pitch_type;
  const format = challenge.format || "T20";
  const isTest = format === "TEST";
  const isOdi = format === "ODI";

  const whyWinnerWon: string[] = [];
  const whyLoserLost: string[] = [];
  let decisiveDifference = "";

  const winningInnings = winner === "USER" ? userInnings : aiInnings;
  const losingInnings = winner === "USER" ? aiInnings : userInnings;
  const winnerName = winner === "USER" ? "Your XI" : "AI XI";
  const loserName = winner === "USER" ? "AI XI" : "Your XI";

  // 1. Identify Top Match Performers
  const allBatters = [
    ...winningInnings.batters.map((b) => ({ ...b, team: winnerName })),
    ...losingInnings.batters.map((b) => ({ ...b, team: loserName })),
  ];
  allBatters.sort((a, b) => b.runs - a.runs);
  const matchTopBat = allBatters[0];

  const winBatters = [...winningInnings.batters].sort((a, b) => b.runs - a.runs);
  const topBatWin = winBatters[0];

  const loseBatters = [...losingInnings.batters].sort((a, b) => b.runs - a.runs);
  const topBatLose = loseBatters[0];

  // In cricket scorecards:
  // - losingInnings.bowlers are the bowlers for the WINNING team who bowled to the losing team!
  // - winningInnings.bowlers are the bowlers for the LOSING team who bowled to the winning team!
  const winBowlers = [...losingInnings.bowlers].sort((a, b) => b.wickets * 25 - b.runs - (a.wickets * 25 - a.runs));
  const topBowlWin = winBowlers[0];

  const loseBowlers = [...winningInnings.bowlers].sort((a, b) => b.wickets * 25 - b.runs - (a.wickets * 25 - a.runs));
  const topBowlLose = loseBowlers[0];

  // Most expensive bowler on losing side (from winningInnings.bowlers)
  const expLoseBowler = [...winningInnings.bowlers]
    .filter((b) => parseFloat(b.overs) >= (isTest ? 10 : isOdi ? 4 : 2))
    .sort((a, b) => b.economy - a.economy)[0] || winningInnings.bowlers[0];

  // Best economy bowler on winning side (from losingInnings.bowlers) - must be genuinely tight!
  const maxEconomyThreshold = isTest ? 2.8 : isOdi ? 5.2 : 7.2;
  const tightWinBowler = [...losingInnings.bowlers]
    .filter((b) => parseFloat(b.overs) >= (isTest ? 10 : isOdi ? 4 : 2) && b.economy <= maxEconomyThreshold)
    .sort((a, b) => a.economy - b.economy)[0];

  const losingWktsInHand = 10 - losingInnings.totalWickets;
  const losingRPO = losingInnings.totalBalls > 0 ? (losingInnings.totalRuns / (losingInnings.totalBalls / 6)) : 0;

  if (isTest) {
    if (winner === "DRAW") {
      decisiveDifference = `Resolute Day 5 defense: ${losingInnings.teamName} batted out ${losingInnings.oversString} overs, surviving with ${losingWktsInHand} wickets in hand against a deteriorating ${pitch.replace(/_/g, " ")} pitch.`;
      whyWinnerWon.push(`Defensive discipline: Blocked out 60+ overs on Day 5 to avert defeat.`);
      whyLoserLost.push(`Bowlers could not break through the tail on a crumbling surface.`);
    } else {
      decisiveDifference = `20-wicket bowling penetration on this ${pitch.replace(/_/g, " ")} wicket: ${winnerName}'s bowling attack claimed all 10 wickets in the decisive innings, led by ${topBowlWin ? `${topBowlWin.name} (${topBowlWin.wickets}/${topBowlWin.runs})` : "a relentless pace and spin unit"}.`;
      if (topBatWin && topBatWin.runs >= 50) {
        whyWinnerWon.push(`${topBatWin.name}'s century/half-century of ${topBatWin.runs} (${topBatWin.balls}b) laid the winning platform.`);
      }
      if (topBowlWin) {
        whyWinnerWon.push(`${topBowlWin.name}'s bowling spell of ${topBowlWin.wickets}/${topBowlWin.runs} broke the opposition spine.`);
      }
      whyLoserLost.push(`Batting collapses against disciplined line and length on this ${pitch.replace(/_/g, " ")} pitch.`);
    }
  } else {
    // Limited Overs (T20 & ODI). Every claim below comes from the same impact score as Player of
    // the Match, and anything about "not out" or "finishing" is checked against the scorecard.
    const isChaseWin = (winner === "USER" && !userBatsFirst) || (winner === "AI" && userBatsFirst);
    const winTeam: "USER" | "AI" = winner === "AI" ? "AI" : "USER";
    const loseTeam: "USER" | "AI" = winTeam === "USER" ? "AI" : "USER";
    const best = topContribution(contribs, winTeam);
    const bestBat = topContribution(contribs, winTeam, "bat");
    const bestBowl = topContribution(contribs, winTeam, "bowl");
    const batLed = !!best && best.batImpact >= best.bowlImpact;

    if (isChaseWin) {
      const ballsInfo = ballsRemaining >= 12
        ? `with ${formatBallsToOvers(ballsRemaining)} overs to spare`
        : ballsRemaining > 0
        ? `with ${ballsRemaining} ball${ballsRemaining === 1 ? "" : "s"} to spare`
        : `off the final ball`;

      if (best && batLed && best.runs >= 30) {
        const line = `${best.runs}${best.notOut ? "*" : ""} off ${best.balls} (${best.fours}x4, ${best.sixes}x6)`;
        decisiveDifference = best.notOut
          ? `${best.name} carried ${winnerName} home with ${line}, finishing the chase ${ballsInfo}.`
          : `${best.name}'s ${line} gave ${winnerName} the platform to chase ${winningInnings.totalRuns} down ${ballsInfo}.`;
        whyWinnerWon.push(best.notOut
          ? `${best.name} stayed in to the end with ${line}, so the required rate never got away.`
          : `${best.name} set the chase up with ${line} before falling.`);
      } else if (bestBowl && bestBowl.wickets >= 2) {
        decisiveDifference = `${bestBowl.name}'s ${bestBowl.wickets}/${bestBowl.conceded} in ${ballsToOvers(bestBowl.ballsBowled)} ov kept the target within reach, and ${winnerName} reached it ${ballsInfo}.`;
        whyWinnerWon.push(`${bestBowl.name} took ${bestBowl.wickets}/${bestBowl.conceded}, holding ${loserName} to a chaseable total.`);
      } else {
        decisiveDifference = `${winnerName} chased the target down ${ballsInfo} through contributions across the order.`;
      }
      if (tightWinBowler && bestBowl?.name !== tightWinBowler.name) {
        whyWinnerWon.push(`Containment bowling: ${tightWinBowler.name} yielded only ${tightWinBowler.runs} runs in ${tightWinBowler.overs} ov (Econ ${tightWinBowler.economy}).`);
      }
      whyWinnerWon.push(`Reached the target ${ballsInfo}.`);

      if (losingWktsInHand >= 5 && losingRPO < (isOdi ? 5.3 : 8.2)) {
        whyLoserLost.push(`Under-utilized batting depth: ended on ${losingInnings.totalRuns}/${losingInnings.totalWickets} with ${losingWktsInHand} wickets in hand (scoring at only ${losingRPO.toFixed(2)} RPO).`);
      } else if (best && best.notOut && batLed) {
        whyLoserLost.push(`Could not dislodge ${best.name}, who was not out on ${best.runs}.`);
      } else {
        whyLoserLost.push(`${loserName} did not take wickets at the right moments, and ${winnerName} always had the chase under control.`);
      }
      if (expLoseBowler) {
        whyLoserLost.push(`Boundary release: ${expLoseBowler.name} conceded ${expLoseBowler.runs} runs in ${expLoseBowler.overs} ov (Econ ${expLoseBowler.economy}).`);
      }
    } else {
      // Defending a total
      const runMargin = winningInnings.totalRuns - losingInnings.totalRuns;
      const bowlLed = !!bestBowl && (!bestBat || bestBowl.bowlImpact >= bestBat.batImpact);

      if (collapsedEarly(format, losingInnings)) {
        const collapseBowler = bestBowl && bestBowl.wickets >= 2 ? ` ${bestBowl.name} took ${bestBowl.wickets}/${bestBowl.conceded} in ${ballsToOvers(bestBowl.ballsBowled)} ov.` : "";
        decisiveDifference = `${loserName} collapsed: bowled out for ${losingInnings.totalRuns} in ${losingInnings.oversString} overs chasing ${winningInnings.totalRuns + 1}, never getting near the target.${collapseBowler}`;
        if (bestBowl && bestBowl.wickets >= 2) whyWinnerWon.push(`${bestBowl.name} took ${bestBowl.wickets}/${bestBowl.conceded}, and the chase fell apart.`);
      } else if (bestBowl && bestBowl.wickets >= 2 && bowlLed) {
        decisiveDifference = `${winnerName} defended ${winningInnings.totalRuns}, holding ${loserName} to ${losingInnings.totalRuns}/${losingInnings.totalWickets}, with ${bestBowl.name}'s ${bestBowl.wickets}/${bestBowl.conceded} in ${ballsToOvers(bestBowl.ballsBowled)} ov the biggest contribution.`;
        whyWinnerWon.push(`${bestBowl.name} took ${bestBowl.wickets}/${bestBowl.conceded}, breaking key partnerships.`);
      } else if (bestBat && bestBat.runs >= 40) {
        decisiveDifference = `${bestBat.name}'s ${bestBat.runs}${bestBat.notOut ? "*" : ""} off ${bestBat.balls} built the ${winningInnings.totalRuns} that ${loserName} could not reach, and ${winnerName} closed out a ${runMargin}-run win.`;
      } else {
        decisiveDifference = `${winnerName} defended ${winningInnings.totalRuns}/${winningInnings.totalWickets} and closed out a ${runMargin}-run victory.`;
      }
      if (bestBat && bestBat.runs >= 40) {
        whyWinnerWon.push(`${bestBat.name}'s ${bestBat.runs}${bestBat.notOut ? "*" : ""} (${bestBat.balls}b) set the benchmark.`);
      }
      if (tightWinBowler && bestBowl?.name !== tightWinBowler.name) {
        whyWinnerWon.push(`Squeeze bowling: ${tightWinBowler.name} conceded only ${tightWinBowler.runs} runs in ${tightWinBowler.overs} ov (Econ ${tightWinBowler.economy}).`);
      }

      const allOut = losingInnings.totalWickets >= 10;
      whyLoserLost.push(allOut
        ? `Bowled out for ${losingInnings.totalRuns} in ${losingInnings.oversString} overs, short of ${winningInnings.totalRuns + 1}.`
        : `Finished on ${losingInnings.totalRuns}/${losingInnings.totalWickets}, ${runMargin} short of ${winningInnings.totalRuns}.`);
      if (expLoseBowler) {
        whyLoserLost.push(`Boundary release: ${expLoseBowler.name} conceded ${expLoseBowler.runs} runs in ${expLoseBowler.overs} ov (Econ ${expLoseBowler.economy}).`);
      }

      // Name the phase that produced the margin, but only phases BOTH sides batted through in full.
      // When a side was bowled out early the story is the collapse, not a phase-by-phase comparison.
      const completed = comparablePhases(format, winningInnings, losingInnings);
      if (collapsedEarly(format, losingInnings) || collapsedEarly(format, winningInnings)) completed.death = false;
      const t20 = format === "T20";
      const phases = [
        { key: "powerplay" as const, label: t20 ? "powerplay (overs 1-6)" : "powerplay (overs 1-10)" },
        { key: "middle" as const, label: t20 ? "middle overs (7-15)" : "middle overs (11-40)" },
        { key: "death" as const, label: t20 ? "death overs (16-20)" : "death overs (41-50)" },
      ]
        .filter((ph) => completed[ph.key])
        .map((ph) => ({ ...ph, win: winningInnings.phaseRuns[ph.key], lose: losingInnings.phaseRuns[ph.key], winRr: phaseRunRate(format, winningInnings, ph.key), loseRr: phaseRunRate(format, losingInnings, ph.key) }));
      const top = [...phases].sort((x, y) => (y.winRr - y.loseRr) - (x.winRr - x.loseRr))[0];
      if (top && runMargin > 0 && !collapsedEarly(format, losingInnings)) {
        const gain = top.win - top.lose;
        if (gain >= 10 && gain >= runMargin * 0.5) {
          const share = Math.min(100, Math.round((gain / runMargin) * 100));
          decisiveDifference = `The match turned in the ${top.label}: ${winnerName} scored ${top.win} at ${top.winRr.toFixed(1)} an over to ${top.lose} at ${top.loseRr.toFixed(1)}, ${gain >= runMargin ? "more than the whole" : `${share}% of the`} ${runMargin}-run margin.`;
          whyWinnerWon.unshift(`Won the ${top.label} ${top.win} to ${top.lose}.`);
          whyLoserLost.unshift(`Lost the ${top.label}, scoring ${top.lose} to ${top.win}.`);
        }
      }
    }
  }

  const groundConditionsAnalysis = `Contested on a ${pitch.replace(/_/g, " ")} pitch at ${challenge.venue.name} (${challenge.venue.country}). The surface ${pitch === "DUSTBOWL" ? "gripped sharply for spinners with variable turn" : pitch === "GREEN_SEAMER" ? "offered lateral seam movement with the new ball" : pitch === "SLOW_LOW" ? "was sluggish with cutters holding up into the pitch" : "offered true bounce and swift outfields favoring stroke play"}.`;

  return {
    decisiveDifference,
    whyWinnerWon,
    whyLoserLost,
    groundConditionsAnalysis,
  };
}
