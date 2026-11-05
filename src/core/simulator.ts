import type { Challenge, MatchFormat, PitchType, PlayerWithStats } from "./types";

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

export interface InningsScorecard {
  teamName: string;
  inningsNumber?: number; // 1 or 2 (for Tests)
  totalRuns: number;
  totalWickets: number;
  oversCompleted: number;
  maxOvers: number;
  batters: BatterScorecard[];
  bowlers: BowlerScorecard[];
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

export interface MatchSimulationResult {
  format: MatchFormat;
  winner: "USER" | "AI" | "TIE" | "DRAW";
  summary: string;
  toss: TossInfo;
  userInnings: InningsScorecard;
  aiInnings: InningsScorecard;
  userSecondInnings?: InningsScorecard;
  aiSecondInnings?: InningsScorecard;
  leadFirstInnings?: {
    team: "USER" | "AI";
    runs: number;
  };
  keyMoments: KeyMoment[];
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

// Simple seeded PRNG for consistent yet realistic variance
function createRng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Simulates an authentic, data-driven cricket match between USER XI and AI XI.
 * Takes into account:
 * 1. Match Format: Test matches have 2 innings per side, Day 1-5 pitch wear, draw/win scenarios.
 * 2. Limited Overs (T20/ODI): Toss, Powerplay, Middle, Death overs, chasing under pressure.
 * 3. Exact batting slots (1 to 11): Openers, Anchors, Middle, Tail.
 * 4. Bowling attack synergy & allocations (Pace vs Spin, spell rotation).
 * 5. Pitch conditions (Lord's slope swing vs Chepauk dust vs Wankhede bounce).
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

  // 1. Simulate Match Toss
  const tossWinner: "USER" | "AI" = rng() > 0.5 ? "USER" : "AI";
  let tossDecision: "BAT" | "BOWL";
  let tossReason: string;

  if (pitchType === "GREEN_SEAMER") {
    tossDecision = "BOWL";
    tossReason = "unleash the pace attack in overcast morning conditions with abundant grass cover";
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

    // 2nd Innings: Pitch degrades (Day 4-5 spin & reverse swing wear)
    let userInn2: InningsScorecard;
    let aiInn2: InningsScorecard;
    let winner: "USER" | "AI" | "DRAW" = "DRAW";
    let summary = "";

    if (userBatsFirst) {
      // User bats 2nd innings to set target for AI
      const userLead = userInn1.totalRuns - aiInn1.totalRuns;
      userInn2 = simulateInnings(userSquad, aiSquad, challenge, 60, "Your XI", undefined, rng, 2, true);
      const targetForAi = userLead + userInn2.totalRuns + 1;

      if (targetForAi <= 0) {
        // AI won by an innings!
        winner = "AI";
        summary = `AI XI won by an innings and ${Math.abs(targetForAi - 1)} runs!`;
        aiInn2 = {
          teamName: "AI XI",
          inningsNumber: 2,
          totalRuns: 0,
          totalWickets: 0,
          oversCompleted: 0,
          maxOvers: 0,
          batters: [],
          bowlers: [],
          phaseRuns: { powerplay: 0, middle: 0, death: 0 }
        };
      } else {
        // AI chases target on Day 5
        aiInn2 = simulateInnings(aiSquad, userSquad, challenge, 65, "AI XI", targetForAi, rng, 2, true);

        if (aiInn2.totalRuns >= targetForAi) {
          winner = "AI";
          const wktsLeft = 10 - aiInn2.totalWickets;
          summary = `AI XI won by ${wktsLeft} wicket${wktsLeft === 1 ? "" : "s"} on Day 5!`;
        } else if (aiInn2.totalWickets >= 10) {
          winner = "USER";
          const margin = targetForAi - 1 - aiInn2.totalRuns;
          summary = `Your XI won by ${margin} run${margin === 1 ? "" : "s"} in a dramatic Test finish!`;
        } else {
          winner = "DRAW";
          summary = `Match Drawn! AI XI batted out Day 5 (${aiInn2.totalRuns}/${aiInn2.totalWickets} in ${aiInn2.oversCompleted} ov).`;
        }
      }
    } else {
      // AI bats 2nd innings to set target for User
      const aiLead = aiInn1.totalRuns - userInn1.totalRuns;
      aiInn2 = simulateInnings(aiSquad, userSquad, challenge, 60, "AI XI", undefined, rng, 2, true);
      const targetForUser = aiLead + aiInn2.totalRuns + 1;

      if (targetForUser <= 0) {
        winner = "USER";
        summary = `Your XI won by an innings and ${Math.abs(targetForUser - 1)} runs!`;
        userInn2 = {
          teamName: "Your XI",
          inningsNumber: 2,
          totalRuns: 0,
          totalWickets: 0,
          oversCompleted: 0,
          maxOvers: 0,
          batters: [],
          bowlers: [],
          phaseRuns: { powerplay: 0, middle: 0, death: 0 }
        };
      } else {
        userInn2 = simulateInnings(userSquad, aiSquad, challenge, 65, "Your XI", targetForUser, rng, 2, true);

        if (userInn2.totalRuns >= targetForUser) {
          winner = "USER";
          const wktsLeft = 10 - userInn2.totalWickets;
          summary = `Your XI won by ${wktsLeft} wicket${wktsLeft === 1 ? "" : "s"} on Day 5!`;
        } else if (userInn2.totalWickets >= 10) {
          winner = "AI";
          const margin = targetForUser - 1 - userInn2.totalRuns;
          summary = `AI XI won by ${margin} run${margin === 1 ? "" : "s"} in a dramatic Test finish!`;
        } else {
          winner = "DRAW";
          summary = `Match Drawn! Your XI batted out Day 5 (${userInn2.totalRuns}/${userInn2.totalWickets} in ${userInn2.oversCompleted} ov).`;
        }
      }
    }

    // Key Moments
    keyMoments.push({
      over: "Day 1",
      title: "Opening Session Attack",
      description: `${userBatsFirst ? "Your XI" : "AI XI"} took to the crease in challenging new-ball conditions, negotiating early swing and seam.`,
      impactTeam: userBatsFirst ? "USER" : "AI",
    });

    keyMoments.push({
      over: "Day 3",
      title: "First Innings Lead Secured",
      description: `${leadFirstInnings.team === "USER" ? "Your XI" : "AI XI"} gained a vital first-innings advantage of ${leadFirstInnings.runs} runs.`,
      impactTeam: leadFirstInnings.team,
    });

    keyMoments.push({
      over: "Day 5",
      title: "Final Innings Showdown",
      description: summary,
      impactTeam: winner === "DRAW" ? "USER" : winner,
    });

    const potm = determinePlayerOfTheMatch(userInn1, aiInn1, winner === "DRAW" ? "USER" : winner, userInn2, aiInn2);
    const analysis = deriveMatchAnalysis(userInn1, aiInn1, userSquad, aiSquad, challenge, winner);

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
      keyMoments,
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

  // Determine Match Outcome
  let winner: "USER" | "AI" | "TIE" = "TIE";
  let summary = "";

  if (secondInnings.totalRuns >= firstInnings.totalRuns + 1) {
    // Chasing team won
    winner = firstTeam === "USER" ? "AI" : "USER";
    const wktsRemaining = 10 - secondInnings.totalWickets;
    summary = `${winner === "USER" ? "Your XI" : "AI XI"} won by ${wktsRemaining} wicket${wktsRemaining === 1 ? "" : "s"} (${(maxOvers - secondInnings.oversCompleted).toFixed(1)} ov remaining)`;
  } else if (firstInnings.totalRuns > secondInnings.totalRuns) {
    // Defending team won
    winner = firstTeam === "USER" ? "USER" : "AI";
    const runDiff = firstInnings.totalRuns - secondInnings.totalRuns;
    summary = `${winner === "USER" ? "Your XI" : "AI XI"} won by ${runDiff} run${runDiff === 1 ? "" : "s"}`;
  } else {
    winner = "TIE";
    summary = `Match Tied! Both sides finished on ${firstInnings.totalRuns} runs.`;
  }

  // Generate Key Match Moments
  const ppOvers = format === "T20" ? 6 : 10;
  keyMoments.push({
    over: `1 - ${ppOvers}`,
    title: "Powerplay Clashes",
    description: `${firstInnings.teamName} posted ${firstInnings.phaseRuns.powerplay} in their Powerplay, while ${secondInnings.teamName} responded with ${secondInnings.phaseRuns.powerplay}.`,
    impactTeam: firstInnings.phaseRuns.powerplay >= secondInnings.phaseRuns.powerplay ? (firstTeam === "USER" ? "USER" : "AI") : (firstTeam === "USER" ? "AI" : "USER"),
  });

  keyMoments.push({
    over: format === "T20" ? "16 - 20" : "41 - 50",
    title: "Death Overs Climax",
    description: `High-voltage finish in the final phase: ${winner === "USER" ? "Your XI" : "AI XI"} controlled the final deliveries with precision execution.`,
    impactTeam: winner === "TIE" ? "USER" : winner,
  });

  const potm = determinePlayerOfTheMatch(userInnings, aiInnings, winner);
  const analysis = deriveMatchAnalysis(userInnings, aiInnings, userSquad, aiSquad, challenge, winner);

  return {
    format,
    winner,
    summary,
    toss: tossInfo,
    userInnings,
    aiInnings,
    keyMoments,
    decisiveDifference: analysis.decisiveDifference,
    whyWinnerWon: analysis.whyWinnerWon,
    whyLoserLost: analysis.whyLoserLost,
    groundConditionsAnalysis: analysis.groundConditionsAnalysis,
    playerOfTheMatch: potm,
  };
}

/**
 * Simulates a single innings ball-by-ball.
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
  isDeterioratedPitch = false
): InningsScorecard {
  const { pitch_type, country } = challenge.venue;
  const format = challenge.format;
  const isTest = format === "TEST";

  // Valid batters in designated order
  const battersInOrder = battingLineup
    .map((p, idx) => ({ player: p, slotIndex: idx }))
    .filter((item): item is { player: PlayerWithStats; slotIndex: number } => item.player !== null);

  // Valid bowlers
  const bowlers = bowlingLineup
    .filter((p): p is PlayerWithStats => p !== null && (p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0));

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
  let strikerIdx = 0;
  let nonStrikerIdx = 1;
  let nextBatterIdx = 2;

  let powerplayRuns = 0;
  let middleRuns = 0;
  let deathRuns = 0;

  const ppEnd = format === "T20" ? 6 : format === "ODI" ? 10 : 25;
  const deathStart = format === "T20" ? 16 : format === "ODI" ? 41 : 80;

  let currentOver = 0;

  for (let over = 1; over <= maxOvers; over++) {
    currentOver = over;
    if (totalWickets >= 10) break;
    if (target && totalRuns >= target) break;

    const phase: "PP" | "MID" | "DEATH" =
      over <= ppEnd ? "PP" : over >= deathStart ? "DEATH" : "MID";

    // Select Bowler for this Over based on phase and venue
    const bowler = selectBowlerForOver(bowlers, phase, pitch_type, country, over, maxOvers, bowlerStatsMap, rng, format);
    const bStats = bowlerStatsMap.get(bowler.id)!;

    let overRuns = 0;

    for (let ball = 1; ball <= 6; ball++) {
      if (totalWickets >= 10 || (target && totalRuns >= target)) break;

      const striker = batterCards[strikerIdx];
      const strikerData = battersInOrder[strikerIdx]?.player;

      if (!striker || !strikerData) break;

      // Calculate Ball Outcome based on Batter vs Bowler vs Pitch
      const ballOutcome = resolveBall(
        strikerData,
        bowler,
        phase,
        pitch_type,
        country,
        format,
        isDeterioratedPitch,
        rng
      );

      striker.balls++;
      bStats.balls++;

      if (ballOutcome.isOut) {
        striker.isOut = true;
        striker.dismissal = `c & b ${bowler.name}`;
        totalWickets++;
        bStats.wickets++;

        // Next batter in order comes to crease
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

        // Strike rotation on singles and threes
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

    // End of over: switch striker and non-striker
    const temp = strikerIdx;
    strikerIdx = nonStrikerIdx;
    nonStrikerIdx = temp;
  }

  // Finalize strike rates
  for (const b of batterCards) {
    b.strikeRate = b.balls > 0 ? Math.round((b.runs / b.balls) * 1000) / 10 : 0;
  }

  // Finalize bowler scorecards
  const bowlerCards: BowlerScorecard[] = bowlers
    .filter((b) => (bowlerStatsMap.get(b.id)?.balls || 0) > 0)
    .map((b) => {
      const stats = bowlerStatsMap.get(b.id)!;
      const completedOvers = Math.floor(stats.balls / 6);
      const remainingBalls = stats.balls % 6;
      const oversStr = `${completedOvers}.${remainingBalls}`;
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
    oversCompleted: currentOver,
    maxOvers,
    batters: batterCards,
    bowlers: bowlerCards,
    phaseRuns: {
      powerplay: powerplayRuns,
      middle: middleRuns,
      death: deathRuns,
    },
  };
}

/**
 * Intelligent bowler selection for an over based on phase, max quota, and pitch conditions.
 */
function selectBowlerForOver(
  bowlers: PlayerWithStats[],
  phase: "PP" | "MID" | "DEATH",
  pitch: PitchType,
  country: string,
  over: number,
  maxOvers: number,
  statsMap: Map<string, { balls: number }>,
  rng: () => number,
  format: MatchFormat = "T20"
): PlayerWithStats {
  const isTest = format === "TEST";
  const maxQuotaBalls = isTest ? 30 * 6 : Math.floor((maxOvers / 5) * 6); // 4 overs in T20, 10 in ODI, up to 30 in Tests

  // Filter bowlers with overs remaining
  const eligible = bowlers.filter((b) => (statsMap.get(b.id)?.balls || 0) < maxQuotaBalls);
  const candidates = eligible.length > 0 ? eligible : bowlers;

  // Score candidate bowlers for this phase
  const scored = candidates.map((b) => {
    let weight = 10;
    const isPacer = b.bowling_category === "PACE";
    const isSpinner = b.bowling_category === "SPIN";

    // Powerplay / New Ball prefers pacers and swing
    if (phase === "PP") {
      if (isPacer) weight += isTest ? 35 : 25;
      if (pitch === "GREEN_SEAMER") weight += 25;
    }

    // Death (T20/ODI) prefers yorker specialists / sub-7.8 economy
    if (phase === "DEATH") {
      if (!isTest) {
        if (b.stats.bowl_economy > 0 && b.stats.bowl_economy <= 7.8) weight += 30;
        if (isPacer) weight += 15;
      } else {
        // Second new ball in Tests
        if (isPacer) weight += 30;
      }
    }

    // Middle prefers quality spinners and cutters
    if (phase === "MID") {
      if (isSpinner && (pitch === "DUSTBOWL" || pitch === "SLOW_LOW")) weight += 35;
      else if (isSpinner) weight += 20;
    }

    // Country conditions boost
    if (country === "RSA" && isPacer) weight += 15;
    if ((country === "IND" || country === "BAN" || country === "SL") && isSpinner) weight += 15;

    return { bowler: b, weight: weight + rng() * 10 };
  });

  scored.sort((a, b) => b.weight - a.weight);
  return scored[0]?.bowler || bowlers[0];
}

/**
 * Resolves a single delivery based on realistic batter statistics, bowler economy, and pitch conditions.
 */
function resolveBall(
  batter: PlayerWithStats,
  bowler: PlayerWithStats,
  phase: "PP" | "MID" | "DEATH",
  pitch: PitchType,
  country: string,
  format: MatchFormat,
  isDeterioratedPitch: boolean,
  rng: () => number
): { runs: number; isOut: boolean } {
  const isTest = format === "TEST";

  // Base Wicket Probability (~0.038 per ball in T20, ~0.025 in ODI, ~0.016 in Test)
  let wktChance = format === "T20" ? 0.038 : format === "ODI" ? 0.025 : 0.016;

  // Tailender penalty: If batter is a pure bowler batting at top/middle order
  if (batter.primary_role === "BOWL") {
    wktChance *= 2.8;
  }

  // Bowler quality adjustment
  if (isTest) {
    const bowlAvg = bowler.stats.bowl_average || 34.0;
    if (bowlAvg <= 25.0) wktChance *= 1.35; // Elite Test strike bowlers (Bumrah, Cummins, Steyn)
    else if (bowlAvg <= 28.5) wktChance *= 1.18;
  } else {
    const bowlerEcon = bowler.stats.bowl_economy || 8.0;
    if (bowlerEcon <= 7.2) wktChance *= 1.2;
  }

  // Pitch Condition impact on wickets
  if (pitch === "GREEN_SEAMER" && bowler.bowling_category === "PACE") {
    wktChance *= phase === "PP" ? 1.45 : 1.25; // Dukes swing / seam in morning
  } else if (pitch === "DUSTBOWL" && bowler.bowling_category === "SPIN") {
    wktChance *= isDeterioratedPitch ? 1.6 : 1.35; // Turning square on worn pitch
  } else if (country === "RSA" && bowler.bowling_category === "PACE") {
    wktChance *= 1.3; // Steep Highveld bounce
  }

  // Batter quality defense
  const batAvg = Math.max(12, batter.stats.bat_average || 25);
  if (isTest) {
    wktChance *= 38.0 / batAvg; // World class test batsmen (50+ avg) survive much longer
  } else {
    wktChance *= 28.0 / batAvg;
  }

  // Check dismissal
  if (rng() < wktChance) {
    return { runs: 0, isOut: true };
  }

  // Scoring Run Calculation
  const batSr = Math.max(isTest ? 40 : 65, batter.stats.bat_strike_rate || (isTest ? 50 : 110));
  const bowlerEcon = bowler.stats.bowl_economy || (isTest ? 3.0 : 8.0);
  let expectedRunsPerBall = (batSr / 100 + (isTest ? bowlerEcon / 3.0 : bowlerEcon / 6.0)) / 2;

  // Phase tempo
  if (isTest) {
    if (phase === "PP") expectedRunsPerBall *= 0.85; // Respecting the new ball
    else expectedRunsPerBall *= 1.0;
    // NO finisher penalty in Test matches!
  } else {
    // Limited overs phases
    if (phase === "PP") expectedRunsPerBall *= 1.15;
    if (phase === "DEATH") {
      expectedRunsPerBall *= 1.32;
      const isFinisher = batter.stats.finisher_innings >= 6 || batSr >= 135;
      if (isFinisher) expectedRunsPerBall *= 1.22;
      else expectedRunsPerBall *= 0.68; // Stalling in death overs without a finisher
    }
  }

  // Pitch modifier on runs
  if (pitch === "HIGH_SCORING_FLAT") expectedRunsPerBall *= 1.20;
  if (pitch === "SLOW_LOW") expectedRunsPerBall *= 0.85;
  if (isDeterioratedPitch) expectedRunsPerBall *= 0.82;

  const rFactor = Math.max(0.65, Math.min(1.8, expectedRunsPerBall / (isTest ? 0.65 : 1.25)));
  const dotProb = Math.max(0.20, (isTest ? 0.60 : 0.40) / rFactor);
  const singleProb = dotProb + Math.min(0.42, 0.30 * rFactor);
  const doubleProb = singleProb + (isTest ? 0.08 : 0.11);
  const fourProb = doubleProb + Math.min(0.16, (isTest ? 0.06 : 0.09) * rFactor);

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

  const allBowlers = [
    ...userInnings.bowlers.map((b) => ({ ...b, team: "USER" as const })),
    ...aiInnings.bowlers.map((b) => ({ ...b, team: "AI" as const })),
    ...(userInn2 ? userInn2.bowlers.map((b) => ({ ...b, team: "USER" as const })) : []),
    ...(aiInn2 ? aiInn2.bowlers.map((b) => ({ ...b, team: "AI" as const })) : []),
  ];

  // Best batter
  allBatters.sort((a, b) => b.runs - a.runs);
  const bestBat = allBatters[0];

  // Best bowler
  allBowlers.sort((a, b) => b.wickets * 25 - b.runs - (a.wickets * 25 - a.runs));
  const bestBowl = allBowlers[0];

  const batImpact = bestBat ? bestBat.runs : 0;
  const bowlImpact = bestBowl ? bestBowl.wickets * 25 : 0;

  if (bestBowl && bowlImpact >= batImpact) {
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

function deriveMatchAnalysis(
  userInnings: InningsScorecard,
  aiInnings: InningsScorecard,
  userSquad: (PlayerWithStats | null)[],
  aiSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  winner: "USER" | "AI" | "TIE" | "DRAW"
) {
  const pitch = challenge.venue.pitch_type;
  const country = challenge.venue.country;
  const isTest = challenge.format === "TEST";

  let decisiveDifference = "";
  const whyWinnerWon: string[] = [];
  const whyLoserLost: string[] = [];

  const winningInnings = winner === "USER" ? userInnings : aiInnings;
  const losingInnings = winner === "USER" ? aiInnings : userInnings;

  if (isTest) {
    if (winner === "DRAW") {
      decisiveDifference = "Tenacious defensive resistance in the 4th innings: the batting side blunted the bowling attack across 60+ overs on Day 5.";
      whyWinnerWon.push("Superb batting resolve and patience leaving outside off-stump.");
      whyLoserLost.push("Bowlers unable to capture the final remaining wickets on a deteriorating track.");
    } else {
      decisiveDifference = `20-wicket taking bowling penetration on this ${pitch} pitch: ${winner === "USER" ? "Your XI" : "AI XI"}'s attack created sustained pressure.`;
      whyWinnerWon.push("Relentless line and length coupled with bowling depth.");
      whyLoserLost.push("Batting collapses against disciplined swing and spin spells.");
    }
  } else {
    // Limited Overs
    const winDeath = winningInnings.phaseRuns.death;
    const loseDeath = losingInnings.phaseRuns.death;
    const winPP = winningInnings.phaseRuns.powerplay;
    const losePP = losingInnings.phaseRuns.powerplay;

    if (winDeath > loseDeath + 10) {
      decisiveDifference = `Execution at the death proved decisive: ${winner === "USER" ? "Your XI" : "AI XI"} surged with ${winDeath} runs in the final phase while the opposition stalled.`;
      whyWinnerWon.push("Explosive death-overs finishing with sub-7.8 specialist containment.");
      whyLoserLost.push("Inability to stem boundary leaks in the final overs.");
    } else if (winPP > losePP + 10) {
      decisiveDifference = `New-ball dominance: ${winner === "USER" ? "Your XI" : "AI XI"} exploited ${pitch === "GREEN_SEAMER" ? "morning seam movement" : "the Powerplay"} to set an unassailable foundation.`;
      whyWinnerWon.push("Top-order solidity negotiating early lateral movement.");
      whyLoserLost.push("Early wicket haemorrhaging against the new ball attack.");
    } else {
      decisiveDifference = `Middle-overs control on this ${pitch} surface separated the sides: disciplined spin and strike rotation starved the opposition of boundaries.`;
      whyWinnerWon.push("Superior phase strike rotation and pitch adaptability.");
      whyLoserLost.push("High dot-ball percentage through overs 7 to 15.");
    }
  }

  const groundConditionsAnalysis = `Played on a ${pitch} surface at ${challenge.venue.name} (${country}). Pitch telemetry showed ${pitch === "DUSTBOWL" ? "turn and variable grip favoring spin specialists" : pitch === "GREEN_SEAMER" ? "pronounced seam movement punishing loose drives" : "true bounce and rapid outfields rewarding stroke makers"}.`;

  return {
    decisiveDifference,
    whyWinnerWon,
    whyLoserLost,
    groundConditionsAnalysis,
  };
}
