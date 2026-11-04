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

export interface MatchSimulationResult {
  format: MatchFormat;
  winner: "USER" | "AI" | "TIE" | "DRAW";
  summary: string;
  userInnings: InningsScorecard;
  aiInnings: InningsScorecard;
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
 * 1. Exact batting slots (1 to 11) - openers, middle order, death finishers.
 * 2. Bowling attack synergy & allocations (paces vs spinners, death bowling).
 * 3. Venue pitch conditions (Wankhede flat vs Chepauk spin vs Lord's Dukes swing).
 * 4. Actual career averages, strike rates, economies, and experience.
 */
export function simulateCricketMatch(
  userSquad: (PlayerWithStats | null)[],
  aiSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  seed = Date.now()
): MatchSimulationResult {
  const rng = createRng(seed);
  const format = challenge.format || "T20";

  // Filter non-null players
  const userPlayers = userSquad.filter((p): p is PlayerWithStats => p !== null);
  const aiPlayers = aiSquad.filter((p): p is PlayerWithStats => p !== null);

  const maxOvers = format === "T20" ? 20 : format === "ODI" ? 50 : 90;

  // Innings 1: User XI bats, AI XI bowls
  const userInnings = simulateInnings(
    userSquad,
    aiSquad,
    challenge,
    maxOvers,
    "Your XI",
    undefined,
    rng
  );

  // Innings 2: AI XI chases User XI's target
  const target = userInnings.totalRuns + 1;
  const aiInnings = simulateInnings(
    aiSquad,
    userSquad,
    challenge,
    maxOvers,
    "AI XI",
    target,
    rng
  );

  // Determine Match Outcome
  let winner: "USER" | "AI" | "TIE" = "TIE";
  let summary = "";

  if (aiInnings.totalRuns >= target) {
    winner = "AI";
    const wktsRemaining = 10 - aiInnings.totalWickets;
    summary = `AI XI won by ${wktsRemaining} wicket${wktsRemaining === 1 ? "" : "s"} (${(maxOvers - aiInnings.oversCompleted).toFixed(1)} ov remaining)`;
  } else if (userInnings.totalRuns > aiInnings.totalRuns) {
    winner = "USER";
    const runDiff = userInnings.totalRuns - aiInnings.totalRuns;
    summary = `Your XI won by ${runDiff} run${runDiff === 1 ? "" : "s"}`;
  } else {
    winner = "TIE";
    summary = `Match Tied! Both teams scored ${userInnings.totalRuns} runs.`;
  }

  // Determine Player of the Match
  const potm = determinePlayerOfTheMatch(userInnings, aiInnings, winner);

  // Tactical Analysis Breakdown
  const analysis = deriveMatchAnalysis(userInnings, aiInnings, userSquad, aiSquad, challenge, winner);

  return {
    format,
    winner,
    summary,
    userInnings,
    aiInnings,
    decisiveDifference: analysis.decisiveDifference,
    whyWinnerWon: analysis.whyWinnerWon,
    whyLoserLost: analysis.whyLoserLost,
    groundConditionsAnalysis: analysis.groundConditionsAnalysis,
    playerOfTheMatch: potm,
  };
}

/**
 * Simulates a single innings ball-by-ball / over-by-over.
 */
function simulateInnings(
  battingLineup: (PlayerWithStats | null)[],
  bowlingLineup: (PlayerWithStats | null)[],
  challenge: Challenge,
  maxOvers: number,
  teamName: string,
  target: number | undefined,
  rng: () => number
): InningsScorecard {
  const { pitch_type, country } = challenge.venue;
  const format = challenge.format;

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

  const ppEnd = format === "T20" ? 6 : format === "ODI" ? 10 : 15;
  const deathStart = format === "T20" ? 16 : format === "ODI" ? 41 : 75;

  let currentOver = 0;

  for (let over = 1; over <= maxOvers; over++) {
    currentOver = over;
    if (totalWickets >= 10) break;
    if (target && totalRuns >= target) break;

    const phase = over <= ppEnd ? "PP" : over >= deathStart ? "DEATH" : "MID";

    // Select Bowler for this Over based on phase and venue
    const bowler = selectBowlerForOver(bowlers, phase, pitch_type, country, over, maxOvers, bowlerStatsMap, rng);
    const bStats = bowlerStatsMap.get(bowler.id)!;

    let overRuns = 0;

    for (let ball = 1; ball <= 6; ball++) {
      if (totalWickets >= 10 || (target && totalRuns >= target)) break;

      const striker = batterCards[strikerIdx];
      const strikerData = battersInOrder[strikerIdx]?.player;

      if (!striker || !strikerData) break;

      // Calculate Ball Outcome based on Batter vs Bowler vs Pitch
      const ballOutcome = resolveBall(strikerData, bowler, phase, pitch_type, country, format, rng);

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
  rng: () => number
): PlayerWithStats {
  const maxQuotaBalls = Math.floor((maxOvers / 5) * 6); // 4 overs in T20 (24 balls), 10 in ODI (60 balls)

  // Filter bowlers with overs remaining
  const eligible = bowlers.filter((b) => (statsMap.get(b.id)?.balls || 0) < maxQuotaBalls);
  const candidates = eligible.length > 0 ? eligible : bowlers;

  // Score candidate bowlers for this phase
  const scored = candidates.map((b) => {
    let weight = 10;
    const isPacer = b.bowling_category === "PACE";
    const isSpinner = b.bowling_category === "SPIN";

    // Powerplay prefers pacers and swing
    if (phase === "PP") {
      if (isPacer) weight += 25;
      if (pitch === "GREEN_SEAMER") weight += 20;
    }

    // Death prefers yorker specialists / sub-7.8 economy
    if (phase === "DEATH") {
      if (b.stats.bowl_economy > 0 && b.stats.bowl_economy <= 7.8) weight += 30;
      if (isPacer) weight += 15;
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
  rng: () => number
): { runs: number; isOut: boolean } {
  // Base Wicket Probability (~0.038 per ball in T20, ~0.025 in ODI, ~0.018 in Test)
  let wktChance = format === "T20" ? 0.038 : format === "ODI" ? 0.025 : 0.018;

  // Tailender penalty: If batter is a pure bowler batting at top/middle order
  if (batter.primary_role === "BOWL") {
    wktChance *= 2.8;
  }

  // Bowler quality adjustment
  const bowlerEcon = bowler.stats.bowl_economy || 8.0;
  if (bowlerEcon <= 7.2) wktChance *= 1.2;

  // Pitch Condition impact on wickets
  if (pitch === "GREEN_SEAMER" && bowler.bowling_category === "PACE") {
    wktChance *= phase === "PP" ? 1.4 : 1.2; // Dukes swing / seam in morning
  } else if (pitch === "DUSTBOWL" && bowler.bowling_category === "SPIN") {
    wktChance *= 1.4; // Turning square
  } else if (country === "RSA" && bowler.bowling_category === "PACE") {
    wktChance *= 1.3; // Steep Highveld bounce
  }

  // Batter quality defense
  const batAvg = Math.max(10, batter.stats.bat_average || 24);
  wktChance *= 28.0 / batAvg;

  // Check dismissal
  if (rng() < wktChance) {
    return { runs: 0, isOut: true };
  }

  // Scoring Run Calculation
  const batSr = Math.max(65, batter.stats.bat_strike_rate || 110);
  let expectedRunsPerBall = (batSr / 100 + bowlerEcon / 6) / 2;

  // Phase tempo
  if (phase === "PP") expectedRunsPerBall *= 1.15;
  if (phase === "DEATH") expectedRunsPerBall *= 1.32;

  // Finisher boost / deficit in death overs
  if (phase === "DEATH") {
    const isFinisher = batter.stats.finisher_innings >= 6 || batSr >= 135;
    if (isFinisher) expectedRunsPerBall *= 1.2;
    else expectedRunsPerBall *= 0.65; // Stalling in death overs without a finisher
  }

  // Pitch modifier on runs
  if (pitch === "HIGH_SCORING_FLAT") expectedRunsPerBall *= 1.20;
  if (pitch === "SLOW_LOW") expectedRunsPerBall *= 0.85;

  const rFactor = Math.max(0.65, Math.min(1.8, expectedRunsPerBall / 1.25));
  const dotProb = Math.max(0.22, 0.40 / rFactor);
  const singleProb = dotProb + Math.min(0.42, 0.32 * rFactor);
  const doubleProb = singleProb + 0.11;
  const fourProb = doubleProb + Math.min(0.16, 0.09 * rFactor);

  const roll = rng();

  if (roll < dotProb) return { runs: 0, isOut: false };
  if (roll < singleProb) return { runs: 1, isOut: false };
  if (roll < doubleProb) return { runs: 2, isOut: false };
  if (roll < fourProb) return { runs: 4, isOut: false };
  return { runs: 6, isOut: false };
}

function determinePlayerOfTheMatch(
  userInnings: InningsScorecard,
  aiInnings: InningsScorecard,
  winner: "USER" | "AI" | "TIE"
): { name: string; team: "USER" | "AI"; performance: string } {
  const allBatters = [
    ...userInnings.batters.map((b) => ({ ...b, team: "USER" as const })),
    ...aiInnings.batters.map((b) => ({ ...b, team: "AI" as const })),
  ];
  const allBowlers = [
    ...userInnings.bowlers.map((b) => ({ ...b, team: "USER" as const })),
    ...aiInnings.bowlers.map((b) => ({ ...b, team: "AI" as const })),
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
  winner: "USER" | "AI" | "TIE"
) {
  const pitch = challenge.venue.pitch_type;
  const country = challenge.venue.country;

  let decisiveDifference = "";
  const whyWinnerWon: string[] = [];
  const whyLoserLost: string[] = [];

  const winningInnings = winner === "USER" ? userInnings : aiInnings;
  const losingInnings = winner === "USER" ? aiInnings : userInnings;

  // Phase Run Rate Comparison
  const winDeath = winningInnings.phaseRuns.death;
  const loseDeath = losingInnings.phaseRuns.death;
  const winPP = winningInnings.phaseRuns.powerplay;
  const losePP = losingInnings.phaseRuns.powerplay;

  if (winDeath > loseDeath + 10) {
    decisiveDifference = `Execution at the death proved the difference: ${winner === "USER" ? "Your XI" : "AI XI"} surged with ${winDeath} runs in overs 16-20 while the opposition stalled.`;
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

  const groundConditionsAnalysis = `Played on a ${pitch} surface at ${challenge.venue.name} (${country}). Pitch telemetry showed ${pitch === "DUSTBOWL" ? "turn and variable grip favoring spin specialists" : pitch === "GREEN_SEAMER" ? "pronounced seam movement punishing loose drives" : "true bounce and rapid outfields rewarding stroke makers"}.`;

  return {
    decisiveDifference,
    whyWinnerWon,
    whyLoserLost,
    groundConditionsAnalysis,
  };
}
