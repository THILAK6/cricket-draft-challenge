import type { Challenge, MatchFormat, PitchType, PlayerWithStats } from "./types";
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
  const completed = Math.floor(balls / 6);
  const remainder = balls % 6;
  return `${completed}.${remainder}`;
}

/**
 * Simulates an authentic, data-driven cricket match between USER XI and AI XI.
 */
export function simulateCricketMatch(
  userSquad: (PlayerWithStats | null)[],
  aiSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  seed = Date.now()
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
      : "chase comfortably under lights with expected evening dew";
  } else if (pitchType === "DUSTBOWL") {
    tossDecision = "BAT";
    tossReason = "lock in runs before the dry surface crumbles into a turning square minefield";
  } else {
    // SLOW_LOW
    tossDecision = "BAT";
    tossReason = "dictate the match tempo before the wicket slows down and grips for cutters";
  }

  const tossNarrative = `${tossWinner === "USER" ? "Your XI" : "AI XI"} won the toss and elected to ${tossDecision.toLowerCase()} first to ${tossReason}.`;
  const tossInfo: TossInfo = {
    winner: tossWinner,
    decision: tossDecision,
    narrative: tossNarrative,
  };

  const keyMoments: KeyMoment[] = [];

  // Determine which team bats first in Innings 1
  const userBatsFirst =
    (tossWinner === "USER" && tossDecision === "BAT") ||
    (tossWinner === "AI" && tossDecision === "BOWL");

  // =========================================================================
  // TEST MATCH SIMULATION (4 INNINGS CONTEST)
  // =========================================================================
  if (format === "TEST") {
    const maxOversPerInn = 85;

    let userInn1: InningsScorecard;
    let aiInn1: InningsScorecard;

    if (userBatsFirst) {
      userInn1 = simulateInnings(userSquad, aiSquad, challenge, maxOversPerInn, "Your XI", undefined, rng, 1, false);
      aiInn1 = simulateInnings(aiSquad, userSquad, challenge, maxOversPerInn, "AI XI", undefined, rng, 1, false);
    } else {
      aiInn1 = simulateInnings(aiSquad, userSquad, challenge, maxOversPerInn, "AI XI", undefined, rng, 1, false);
      userInn1 = simulateInnings(userSquad, aiSquad, challenge, maxOversPerInn, "Your XI", undefined, rng, 1, false);
    }

    const leadFirstInnings = {
      team: (userInn1.totalRuns >= aiInn1.totalRuns ? "USER" : "AI") as "USER" | "AI",
      runs: Math.abs(userInn1.totalRuns - aiInn1.totalRuns),
    };

    let userInn2: InningsScorecard;
    let aiInn2: InningsScorecard;
    let winner: "USER" | "AI" | "DRAW" | "TIE" = "DRAW";
    let summary = "";
    let testTarget = 0;

    if (userBatsFirst) {
      const userLead = userInn1.totalRuns - aiInn1.totalRuns;
      userInn2 = simulateInnings(userSquad, aiSquad, challenge, 60, "Your XI", undefined, rng, 2, true);
      const targetForAi = userLead + userInn2.totalRuns + 1;
      testTarget = targetForAi;

      if (targetForAi <= 0) {
        winner = "AI";
        summary = `AI XI won by an innings and ${Math.abs(targetForAi - 1)} runs!`;
        aiInn2 = createEmptyInnings("AI XI", 2);
      } else {
        aiInn2 = simulateInnings(aiSquad, userSquad, challenge, 65, "AI XI", targetForAi, rng, 2, true);

        if (aiInn2.totalRuns >= targetForAi) {
          winner = "AI";
          const wktsLeft = 10 - aiInn2.totalWickets;
          summary = `AI XI won by ${wktsLeft} wicket${wktsLeft === 1 ? "" : "s"} on Day 5!`;
        } else if (aiInn2.totalWickets >= 10) {
          const margin = targetForAi - 1 - aiInn2.totalRuns;
          if (margin === 0) {
            winner = "TIE";
            summary = `Match Tied! AI XI were all out for exactly the score needed to level the Test (${aiInn2.totalRuns}).`;
          } else {
            winner = "USER";
            summary = `Your XI won by ${margin} run${margin === 1 ? "" : "s"} in a dramatic Test finish!`;
          }
        } else {
          winner = "DRAW";
          summary = `Match Drawn! AI XI batted out Day 5 (${aiInn2.totalRuns}/${aiInn2.totalWickets} in ${aiInn2.oversString} ov).`;
        }
      }
    } else {
      const aiLead = aiInn1.totalRuns - userInn1.totalRuns;
      aiInn2 = simulateInnings(aiSquad, userSquad, challenge, 60, "AI XI", undefined, rng, 2, true);
      const targetForUser = aiLead + aiInn2.totalRuns + 1;
      testTarget = targetForUser;

      if (targetForUser <= 0) {
        winner = "USER";
        summary = `Your XI won by an innings and ${Math.abs(targetForUser - 1)} runs!`;
        userInn2 = createEmptyInnings("Your XI", 2);
      } else {
        userInn2 = simulateInnings(userSquad, aiSquad, challenge, 65, "Your XI", targetForUser, rng, 2, true);

        if (userInn2.totalRuns >= targetForUser) {
          winner = "USER";
          const wktsLeft = 10 - userInn2.totalWickets;
          summary = `Your XI won by ${wktsLeft} wicket${wktsLeft === 1 ? "" : "s"} on Day 5!`;
        } else if (userInn2.totalWickets >= 10) {
          const margin = targetForUser - 1 - userInn2.totalRuns;
          if (margin === 0) {
            winner = "TIE";
            summary = `Match Tied! Your XI were all out for exactly the score needed to level the Test (${userInn2.totalRuns}).`;
          } else {
            winner = "AI";
            summary = `AI XI won by ${margin} run${margin === 1 ? "" : "s"} in a dramatic Test finish!`;
          }
        } else {
          winner = "DRAW";
          summary = `Match Drawn! Your XI batted out Day 5 (${userInn2.totalRuns}/${userInn2.totalWickets} in ${userInn2.oversString} ov).`;
        }
      }
    }

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

    const potm = determinePlayerOfTheMatch(userInn1, aiInn1, winner === "DRAW" || winner === "TIE" ? "USER" : winner, userInn2, aiInn2);
    const analysis = deriveMatchAnalysis(userInn1, aiInn1, userSquad, aiSquad, challenge, winner, 0, userBatsFirst, userInn2, aiInn2);

    const testUserInns = [userInn1, userInn2].filter((i): i is InningsScorecard => !!i);
    const testAiInns = [aiInn1, aiInn2].filter((i): i is InningsScorecard => !!i);
    const testPerf = computeMatchPerformance("TEST", testUserInns, testAiInns);
    const testSel = buildSelectionReport({ userSquad, aiSquad, challenge, winner, userInnings: testUserInns, aiInnings: testAiInns, performance: testPerf });

    return {
      format: "TEST",
      winner,
      summary,
      toss: tossInfo,
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
    firstInnings = simulateInnings(userSquad, aiSquad, challenge, maxOvers, "Your XI", undefined, rng);
    const target = firstInnings.totalRuns + 1;
    secondInnings = simulateInnings(aiSquad, userSquad, challenge, maxOvers, "AI XI", target, rng);
  } else {
    firstTeam = "AI";
    firstInnings = simulateInnings(aiSquad, userSquad, challenge, maxOvers, "AI XI", undefined, rng);
    const target = firstInnings.totalRuns + 1;
    secondInnings = simulateInnings(userSquad, aiSquad, challenge, maxOvers, "Your XI", target, rng);
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

  // Key Match Moments from real match figures
  const ppOvers = format === "T20" ? 6 : 10;
  keyMoments.push({
    over: `1 - ${ppOvers}`,
    title: "Powerplay Clashes",
    description: `${firstInnings.teamName} posted ${firstInnings.phaseRuns.powerplay} in their Powerplay, while ${secondInnings.teamName} answered with ${secondInnings.phaseRuns.powerplay}.`,
    impactTeam: firstInnings.phaseRuns.powerplay >= secondInnings.phaseRuns.powerplay ? (firstTeam === "USER" ? "USER" : "AI") : (firstTeam === "USER" ? "AI" : "USER"),
  });

  const deathPhaseText = format === "T20" ? "16 - 20" : "41 - 50";
  keyMoments.push({
    over: deathPhaseText,
    title: "Closing Phase Duel",
    description: `${firstInnings.teamName} scored ${firstInnings.phaseRuns.death} in the final overs, while ${secondInnings.teamName} produced ${secondInnings.phaseRuns.death}.`,
    impactTeam: winner === "TIE" ? "USER" : winner,
  });

  const potm = determinePlayerOfTheMatch(userInnings, aiInnings, winner);
  const analysis = deriveMatchAnalysis(userInnings, aiInnings, userSquad, aiSquad, challenge, winner, ballsRemaining, userBatsFirst);

  const limitedPerf = computeMatchPerformance(format, [userInnings], [aiInnings]);
  const limitedSel = buildSelectionReport({ userSquad, aiSquad, challenge, winner, userInnings: [userInnings], aiInnings: [aiInnings], performance: limitedPerf });

  return {
    format,
    winner,
    summary,
    toss: tossInfo,
    userInnings,
    aiInnings,
    keyMoments,
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
  opts: { wicketLimit?: number; phase?: "PP" | "MID" | "DEATH" } = {}
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

  for (let over = 1; over <= maxOvers; over++) {
    if (totalWickets >= wicketLimit) break;
    if (target && totalRuns >= target) break;

    const phase: "PP" | "MID" | "DEATH" =
      opts.phase ?? (over <= ppEnd ? "PP" : over >= deathStart ? "DEATH" : "MID");

    // Select Bowler for this Over (cannot be same bowler as immediate previous over)
    const bowler = selectBowlerForOver(bowlers, phase, pitch_type, country, over, maxOvers, bowlerStatsMap, lastBowlerId, rng, format);
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

      if (ballOutcome.isOut) {
        striker.isOut = true;
        const how = rollDismissal(totalBallsBowled * 7919 + totalRuns * 104729 + totalWickets * 1299709 + strikerIdx, bowler, fieldingSide, keeper, isTest);
        striker.dismissal = dismissalText(how.kind, bowler, how.fielder);
        totalWickets++;
        if (how.kind !== "RUN_OUT") bStats.wickets++; // a run out is not the bowler's wicket
        const card = how.fielder ? fielderMap.get(how.fielder.id) : undefined;
        if (card) {
          if (how.kind === "RUN_OUT") card.runOuts++;
          else if (how.kind === "STUMPED") card.stumpings++;
          else card.catches++;
        }
        // A catch put down before this wicket: roughly one in six caught dismissals has a miss too
        if ((how.kind === "CAUGHT" || how.kind === "CAUGHT_BEHIND") && (totalBallsBowled * 31 + totalRuns) % 6 === 0) droppedCatches++;

        if (nextBatterIdx < batterCards.length) {
          strikerIdx = nextBatterIdx;
          nextBatterIdx++;
        }
      } else {
        const runs = ballOutcome.runs;
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
function selectBowlerForOver(
  bowlers: PlayerWithStats[],
  phase: "PP" | "MID" | "DEATH",
  pitch: PitchType,
  country: string,
  over: number,
  maxOvers: number,
  statsMap: Map<string, { balls: number }>,
  lastBowlerId: string | null,
  rng: () => number,
  format: MatchFormat = "T20"
): PlayerWithStats {
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

  // Score candidate bowlers for this phase
  const scored = eligible.map((b) => {
    let weight = 10;
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
    }

    if (phase === "MID") {
      if (isSpinner && (pitch === "DUSTBOWL" || pitch === "SLOW_LOW")) weight += 45;
      else if (isSpinner) weight += 25;
    }

    if (country === "RSA" && isPacer) weight += 20;
    if ((country === "IND" || country === "BAN" || country === "SL") && isSpinner) weight += 20;

    return { bowler: b, weight: weight + rng() * 10 };
  });

  scored.sort((a, b) => b.weight - a.weight);
  return scored[0]?.bowler || eligible[0];
}

/**
 * Ball resolution accounting for match situation (wickets in hand & batter eye).
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
  const isT20 = format === "T20";

  // Base Wicket Probability
  let wktChance = isT20 ? 0.038 : isOdi ? 0.024 : 0.016;

  // Tailender penalty
  if (batter.primary_role === "BOWL") {
    wktChance *= 2.8;
  }

  // Bowler quality adjustment
  if (isTest) {
    const bowlAvg = bowler.stats.bowl_average || 34.0;
    if (bowlAvg <= 25.0) wktChance *= 1.35;
    else if (bowlAvg <= 28.5) wktChance *= 1.18;
  } else if (isOdi) {
    const bowlEcon = bowler.stats.bowl_economy || 5.5;
    if (bowlEcon <= 4.8) wktChance *= 1.25;
    else if (bowlEcon <= 5.4) wktChance *= 1.12;
  } else {
    const bowlerEcon = bowler.stats.bowl_economy || 8.0;
    if (bowlerEcon <= 7.2) wktChance *= 1.2;
  }

  // Pitch Condition impact
  if (pitch === "GREEN_SEAMER" && bowler.bowling_category === "PACE") {
    wktChance *= phase === "PP" ? 1.45 : 1.25;
  } else if (pitch === "DUSTBOWL" && bowler.bowling_category === "SPIN") {
    wktChance *= isDeterioratedPitch ? 1.6 : 1.35;
  } else if (country === "RSA" && bowler.bowling_category === "PACE") {
    wktChance *= 1.3;
  }

  // Batter quality defense
  const batAvg = Math.max(12, batter.stats.bat_average || 25);
  if (isTest) {
    wktChance *= 38.0 / batAvg;
  } else {
    wktChance *= 28.0 / batAvg;
  }

  // Well-set batter eye (fewer wickets once settled on 30+ runs)
  if (batterBallsSoFar >= 25 && batterRunsSoFar >= 25) {
    wktChance *= 0.72; // Settled batter is tough to dislodge
  }

  // Check dismissal
  if (rng() < wktChance) {
    return { runs: 0, isOut: true };
  }

  // Scoring Run Calculation
  const batSr = Math.max(isTest ? 40 : 65, batter.stats.bat_strike_rate || (isTest ? 50 : 110));
  const bowlerEcon = bowler.stats.bowl_economy || (isTest ? 3.0 : isOdi ? 5.2 : 8.0);
  let expectedRunsPerBall = (batSr / 100 + (isTest ? bowlerEcon / 3.0 : bowlerEcon / 6.0)) / 2;

  const wicketsInHand = 10 - totalWicketsDown;

  // Realistic Phase Tempo based on Wickets in Hand and Batter Calibre
  if (isTest) {
    if (phase === "PP") expectedRunsPerBall *= 0.82; // Leaving the swinging ball
    else expectedRunsPerBall *= 0.98;
  } else if (isOdi) {
    if (phase === "PP") {
      expectedRunsPerBall *= 1.05; // 10 overs field restrictions
    } else if (phase === "MID") {
      if (wicketsInHand >= 7) expectedRunsPerBall *= 1.08;
      else expectedRunsPerBall *= 0.96;
    } else if (phase === "DEATH") {
      // Overs 41-50 in ODI: 8.5-10.5 RPO authentic death tempo
      if (wicketsInHand >= 6) {
        expectedRunsPerBall *= 1.34;
      } else if (wicketsInHand >= 4) {
        expectedRunsPerBall *= 1.18;
      } else {
        expectedRunsPerBall *= 0.92;
      }

      const isAggressive = batSr >= 95 || batter.stats.finisher_innings >= 4;
      if (isAggressive) {
        expectedRunsPerBall *= 1.15;
      }

      if (batterRunsSoFar >= 25) expectedRunsPerBall *= 1.10;
    }
  } else {
    // T20: Realistic authentic scoring rate (par 165-185, flat track 195-215, low/slow 135-155)
    if (phase === "PP") {
      expectedRunsPerBall *= 1.08;
    } else if (phase === "MID") {
      expectedRunsPerBall *= wicketsInHand >= 7 ? 1.04 : 0.96;
    } else if (phase === "DEATH") {
      if (wicketsInHand >= 6) {
        expectedRunsPerBall *= 1.28;
      } else if (wicketsInHand >= 4) {
        expectedRunsPerBall *= 1.14;
      } else {
        expectedRunsPerBall *= 0.95;
      }
      const isFinisher = batter.stats.finisher_innings >= 5 || batSr >= 140;
      if (isFinisher) expectedRunsPerBall *= 1.12;
      if (batterRunsSoFar >= 20) expectedRunsPerBall *= 1.08;
    }
  }

  // Pitch modifier on runs
  if (pitch === "HIGH_SCORING_FLAT") expectedRunsPerBall *= 1.08;
  if (pitch === "SLOW_LOW") expectedRunsPerBall *= 0.90;
  if (isDeterioratedPitch) expectedRunsPerBall *= 0.82;

  const benchmark = isTest ? 0.65 : isOdi ? 1.05 : 1.35;
  // Strictly clamp rFactor so total match boundary percentage matches genuine ICC T20 stats
  const rFactor = Math.max(0.65, Math.min(1.35, expectedRunsPerBall / benchmark));

  // Authentic dot ball floor: minimum 32% dots in T20, 36% in ODI, 44% in Tests
  const dotProb = Math.max(isTest ? 0.44 : isOdi ? 0.36 : 0.32, (isTest ? 0.60 : isOdi ? 0.48 : 0.42) / rFactor);
  const singleProb = dotProb + Math.min(0.40, (isTest ? 0.30 : isOdi ? 0.35 : 0.38) * (rFactor >= 1.15 ? 0.92 : 1.0));
  const doubleProb = singleProb + (isTest ? 0.06 : isOdi ? 0.07 : 0.08);
  const fourProb = doubleProb + Math.min(0.15, (isTest ? 0.06 : isOdi ? 0.09 : 0.13) * (rFactor >= 1.0 ? 1.0 : 0.85));

  const roll = rng();

  if (roll < dotProb) return { runs: 0, isOut: false };
  if (roll < singleProb) return { runs: 1, isOut: false };
  if (roll < doubleProb) return { runs: 2, isOut: false };
  if (roll < fourProb) return { runs: 4, isOut: false };
  return { runs: isTest ? 4 : 6, isOut: false };
}

function determinePlayerOfTheMatch(
  userInnings: InningsScorecard,
  aiInnings: InningsScorecard,
  winner: "USER" | "AI" | "TIE" | "DRAW",
  userInn2?: InningsScorecard,
  aiInn2?: InningsScorecard
): { name: string; team: "USER" | "AI"; performance: string } {
  const allBatters = [
    ...userInnings.batters.map((b) => ({ ...b, team: "USER" as const })),
    ...aiInnings.batters.map((b) => ({ ...b, team: "AI" as const })),
    ...(userInn2 ? userInn2.batters.map((b) => ({ ...b, team: "USER" as const })) : []),
    ...(aiInn2 ? aiInn2.batters.map((b) => ({ ...b, team: "AI" as const })) : []),
  ];

  // Bowlers in userInnings bowled against User XI (i.e. AI bowlers)
  // Bowlers in aiInnings bowled against AI XI (i.e. User XI bowlers)
  const allBowlers = [
    ...userInnings.bowlers.map((b) => ({ ...b, team: "AI" as const })),
    ...aiInnings.bowlers.map((b) => ({ ...b, team: "USER" as const })),
    ...(userInn2 ? userInn2.bowlers.map((b) => ({ ...b, team: "AI" as const })) : []),
    ...(aiInn2 ? aiInn2.bowlers.map((b) => ({ ...b, team: "USER" as const })) : []),
  ];

  // Weight winning performances higher
  const scoredBatters = allBatters.map((b) => {
    let score = b.runs * 1.0;
    if (b.runs >= 100) score += 40;
    else if (b.runs >= 50) score += 20;
    if (b.team === winner) score *= 1.25;
    return { ...b, matchScore: score };
  });

  const scoredBowlers = allBowlers.map((b) => {
    let score = b.wickets * 28 - b.runs * 0.4;
    if (b.wickets >= 5) score += 50;
    else if (b.wickets >= 3) score += 25;
    if (b.team === winner) score *= 1.25;
    return { ...b, matchScore: score };
  });

  scoredBatters.sort((a, b) => b.matchScore - a.matchScore);
  scoredBowlers.sort((a, b) => b.matchScore - a.matchScore);

  const bestBat = scoredBatters[0];
  const bestBowl = scoredBowlers[0];

  if (bestBowl && (!bestBat || bestBowl.matchScore >= bestBat.matchScore)) {
    return {
      name: bestBowl.name,
      team: bestBowl.team,
      performance: `${bestBowl.wickets} for ${bestBowl.runs} (${bestBowl.overs} ov, Econ ${bestBowl.economy})`,
    };
  } else if (bestBat) {
    return {
      name: bestBat.name,
      team: bestBat.team,
      performance: `${bestBat.runs} runs off ${bestBat.balls} balls (${bestBat.fours}x4, ${bestBat.sixes}x6)`,
    };
  }

  return { name: "Match Aggregate", team: "USER", performance: "All-round team display" };
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
  aiInn2?: InningsScorecard
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
    // Limited Overs (T20 & ODI): Authentically determine whether winner batted 2nd (chasing) or 1st (defending)
    const isChaseWin = (winner === "USER" && !userBatsFirst) || (winner === "AI" && userBatsFirst);

    if (isChaseWin && topBatWin && topBatWin.runs >= 45) {
      // Anchoring run chase
      const ballsInfo = ballsRemaining >= 12
        ? `with ${formatBallsToOvers(ballsRemaining)} overs to spare`
        : ballsRemaining > 0
        ? `with ${ballsRemaining} balls to spare`
        : `off the final ball`;

      decisiveDifference = `${topBatWin.name}'s match-winning knock of ${topBatWin.runs} off ${topBatWin.balls} balls (${topBatWin.fours}x4, ${topBatWin.sixes}x6) expertly paced ${winnerName}'s chase, crossing the line ${ballsInfo}.`;

      whyWinnerWon.push(`${topBatWin.name} anchored the innings with ${topBatWin.runs} runs, removing all scoreboard pressure.`);
      if (tightWinBowler) {
        whyWinnerWon.push(`Containment bowling: ${tightWinBowler.name} yielded only ${tightWinBowler.runs} runs in ${tightWinBowler.overs} ov (Econ ${tightWinBowler.economy}).`);
      }
      whyWinnerWon.push(`Clinical chase pacing, reaching the target ${ballsInfo}.`);

      if (losingWktsInHand >= 5 && losingRPO < (isOdi ? 5.3 : 8.2)) {
        whyLoserLost.push(`Under-utilized batting depth: Ended on ${losingInnings.totalRuns}/${losingInnings.totalWickets} with ${losingWktsInHand} wickets in hand (scoring at only ${losingRPO.toFixed(2)} RPO).`);
      } else {
        whyLoserLost.push(`Inability to dislodge ${topBatWin.name}, who controlled the innings tempo.`);
      }
      if (expLoseBowler) {
        whyLoserLost.push(`Boundary release: ${expLoseBowler.name} conceded ${expLoseBowler.runs} runs in ${expLoseBowler.overs} ov (Econ ${expLoseBowler.economy}).`);
      }
    } else if (!isChaseWin) {
      // Defending a total!
      const runMargin = winningInnings.totalRuns - losingInnings.totalRuns;

      if (topBowlWin && topBowlWin.wickets >= 2) {
        decisiveDifference = `Disciplined bowling defense: ${winnerName} defended ${winningInnings.totalRuns} by restricting ${loserName} to ${losingInnings.totalRuns}/${losingInnings.totalWickets}, spearheaded by ${topBowlWin.name}'s ${topBowlWin.wickets}/${topBowlWin.runs} in ${topBowlWin.overs} ov.`;
        whyWinnerWon.push(`${topBowlWin.name}'s strike spell of ${topBowlWin.wickets}/${topBowlWin.runs} dismantled key partnerships.`);
      } else {
        decisiveDifference = `Scoreboard pressure proved decisive: ${winnerName}'s 1st innings total of ${winningInnings.totalRuns}/${winningInnings.totalWickets} was defended with precision, closing out a ${runMargin}-run victory.`;
        whyWinnerWon.push(`Imposing 1st innings total exerted constant required rate pressure on the chase.`);
      }

      if (tightWinBowler) {
        whyWinnerWon.push(`Squeeze bowling: ${tightWinBowler.name} conceded only ${tightWinBowler.runs} runs in ${tightWinBowler.overs} ov (Econ ${tightWinBowler.economy}).`);
      }
      if (topBatWin && topBatWin.runs >= 40) {
        whyWinnerWon.push(`${topBatWin.name}'s foundational ${topBatWin.runs} (${topBatWin.balls}b) set the winning benchmark.`);
      }

      whyLoserLost.push(`Stumbled under scoreboard pressure, falling behind the required rate.`);
      if (expLoseBowler) {
        whyLoserLost.push(`Leaked early boundaries: ${expLoseBowler.name} conceded ${expLoseBowler.runs} runs in ${expLoseBowler.overs} ov (Econ ${expLoseBowler.economy}).`);
      }
    } else {
      // Phase differential fallback
      const winDeath = winningInnings.phaseRuns.death;
      const loseDeath = losingInnings.phaseRuns.death;

      if (winDeath > loseDeath + 8) {
        decisiveDifference = `Late-overs surge: ${winnerName} outscored ${loserName} in the final overs (${winDeath} runs to ${loseDeath}), proving the decisive margin.`;
        whyWinnerWon.push(`Aggressive late-innings acceleration (${winDeath} runs in the closing overs).`);
        whyLoserLost.push(`Stalled momentum in the final phase, falling behind the required rate.`);
      } else {
        const spanLabel = isOdi ? "50 overs" : isTest ? "the 5 days of play" : "20 overs";
        decisiveDifference = `Superior all-round execution across ${spanLabel} on this ${pitch.replace(/_/g, " ")} surface separated the sides.`;
        whyWinnerWon.push(`Consistent strike rotation and boundary finding throughout the innings.`);
        whyLoserLost.push(`High dot-ball tally during the middle overs.`);
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
