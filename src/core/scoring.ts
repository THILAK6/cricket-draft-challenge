import type { Challenge, MatchFormat, PitchType, PlayerWithStats, ScoringBreakdown } from "./types";

/**
 * Deterministic cricket scoring engine (0 - 100 points).
 * Evaluates:
 * 1. Role balance (25 pts): Wicketkeeper, 2 openers, middle order, finisher, 5+ bowlers
 * 2. Pitch fit (25 pts): Pace/Spin attack ratio matched to venue pitch type
 * 3. Statistical player quality (35 pts): Format batting average, strike rate, bowling economy/wickets
 * 4. Batting depth (15 pts): Capability to score runs down to positions 7-9
 */
export function calculateDeterministicScore(
  squad: PlayerWithStats[],
  challenge: Challenge
): Omit<ScoringBreakdown, "llm_adjustment" | "final_score" | "verdict_summary"> {
  const { pitch_type } = challenge.venue;

  // -------------------------------------------------------------
  // 1. Role Balance Score (0 - 25 points)
  // -------------------------------------------------------------
  let roleScore = 0;

  // Keeper check (5 pts)
  const hasKeeper = squad.some((p) => p.primary_role === "WK");
  if (hasKeeper) roleScore += 5;

  // 5+ bowling options (8 pts)
  const bowlingOptions = squad.filter(
    (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0
  );
  if (bowlingOptions.length >= 6) roleScore += 8;
  else if (bowlingOptions.length === 5) roleScore += 6;
  else roleScore += Math.max(0, bowlingOptions.length * 1.2);

  // Top order openers (5 pts): at least 2 players who frequently open
  const openers = squad.filter((p) => p.stats.top_order_innings >= 3 || p.primary_role === "BAT");
  if (openers.length >= 2) roleScore += 5;
  else if (openers.length === 1) roleScore += 2.5;

  // Middle-order stability (4 pts)
  const middleOrder = squad.filter((p) => p.stats.middle_order_innings >= 3 || p.primary_role === "BAT" || p.primary_role === "AR");
  if (middleOrder.length >= 3) roleScore += 4;
  else roleScore += 2;

  // All-rounder presence / balance (3 pts)
  const allrounders = squad.filter((p) => p.primary_role === "AR");
  if (allrounders.length >= 1) roleScore += 3;

  const role_balance_score = Math.min(25, roleScore);

  // -------------------------------------------------------------
  // 2. Pitch Suitability Score (0 - 25 points)
  // -------------------------------------------------------------
  let pitchScore = 15; // base baseline

  const pacers = squad.filter((p) => p.bowling_category === "PACE");
  const spinners = squad.filter((p) => p.bowling_category === "SPIN");

  switch (pitch_type) {
    case "GREEN_SEAMER": {
      // Rewards 3+ pacers with good economy
      if (pacers.length >= 3) pitchScore += 8;
      else if (pacers.length === 2) pitchScore += 4;
      else pitchScore -= 5;
      // High seamers economy bonus
      const goodSeam = pacers.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= 7.8);
      if (goodSeam.length >= 2) pitchScore += 2;
      break;
    }

    case "DUSTBOWL": {
      // Rewards 2-3 quality spinners
      if (spinners.length >= 3) pitchScore += 10;
      else if (spinners.length === 2) pitchScore += 7;
      else if (spinners.length === 1) pitchScore += 2;
      else pitchScore -= 8;
      break;
    }

    case "HIGH_SCORING_FLAT": {
      // Rewards aggressive strike rates and death bowlers
      const highSrBatters = squad.filter((p) => p.stats.bat_strike_rate >= 135.0);
      if (highSrBatters.length >= 4) pitchScore += 7;
      else if (highSrBatters.length >= 2) pitchScore += 4;

      const deathBowlers = squad.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= 7.5);
      if (deathBowlers.length >= 2) pitchScore += 3;
      break;
    }

    case "SLOW_LOW": {
      // Rewards accumulators and wicket-to-wicket bowlers
      if (spinners.length >= 2) pitchScore += 5;
      const accurateBowlers = squad.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= 7.2);
      if (accurateBowlers.length >= 3) pitchScore += 5;
      break;
    }
  }

  const pitch_suitability_score = Math.max(0, Math.min(25, pitchScore));

  // -------------------------------------------------------------
  // 3. Player Quality Score (0 - 35 points)
  // -------------------------------------------------------------
  let qualityTotal = 0;
  let qualifiedBatters = 0;
  let qualifiedBowlers = 0;

  for (const p of squad) {
    if (p.primary_role === "BAT" || p.primary_role === "WK" || p.primary_role === "AR") {
      // Batting quality: average + strike rate component
      const avg = Math.min(50, p.stats.bat_average);
      const sr = Math.min(160, p.stats.bat_strike_rate);
      // Normalized: Avg of 35 and SR of 135 gives ~1.0
      const batRating = (avg / 35.0) * 0.5 + (sr / 135.0) * 0.5;
      qualityTotal += batRating * 2.8;
      qualifiedBatters++;
    }

    if (p.primary_role === "BOWL" || p.primary_role === "AR") {
      // Bowling quality: lower economy and more wickets
      const econ = p.stats.bowl_economy || 8.5;
      const wpm = p.stats.matches > 0 ? p.stats.bowl_wickets / p.stats.matches : 0.8;
      // Normalized: Econ of 7.5 and 1.2 wkts/match gives ~1.0
      const bowlRating = (7.5 / Math.max(5.5, econ)) * 0.5 + Math.min(1.5, wpm / 1.0) * 0.5;
      qualityTotal += bowlRating * 3.0;
      qualifiedBowlers++;
    }
  }

  const player_quality_score = Math.max(10, Math.min(35, Math.round(qualityTotal * 0.6)));

  // -------------------------------------------------------------
  // 4. Batting Depth Score (0 - 15 points)
  // -------------------------------------------------------------
  // Sort players from highest batting capacity to lowest
  const sortedBatters = [...squad].sort(
    (a, b) => b.stats.bat_average * b.stats.bat_strike_rate - a.stats.bat_average * a.stats.bat_strike_rate
  );

  // Examine lower order (positions 7, 8, 9)
  const lowerOrder = sortedBatters.slice(6, 9);
  let depthPoints = 0;
  for (const p of lowerOrder) {
    if (p.stats.bat_runs >= 200 || p.stats.bat_average >= 18 || p.primary_role === "AR") {
      depthPoints += 5;
    } else if (p.stats.bat_runs >= 100 || p.stats.bat_average >= 12) {
      depthPoints += 3;
    } else {
      depthPoints += 1;
    }
  }

  const batting_depth_score = Math.min(15, depthPoints);

  const deterministic_total = Math.round(
    role_balance_score + pitch_suitability_score + player_quality_score + batting_depth_score
  );

  return {
    role_balance_score,
    pitch_suitability_score,
    player_quality_score,
    batting_depth_score,
    deterministic_total: Math.min(100, Math.max(0, deterministic_total)),
  };
}

/**
 * Builds the strict LLM referee payload.
 * Provides ONLY calculated factual features to prevent hallucinated career statistics.
 */
export function buildRefereePromptPayload(
  squad: PlayerWithStats[],
  challenge: Challenge,
  deterministicBreakdown: ReturnType<typeof calculateDeterministicScore>
) {
  const pacers = squad.filter((p) => p.bowling_category === "PACE").map((p) => `${p.name} (${p.country})`);
  const spinners = squad.filter((p) => p.bowling_category === "SPIN").map((p) => `${p.name} (${p.country})`);
  const keepers = squad.filter((p) => p.primary_role === "WK").map((p) => p.name);
  const leftHanders = squad.filter((p) => p.batting_hand === "LHB").map((p) => p.name);

  return {
    venue: challenge.venue.name,
    pitch_type: challenge.venue.pitch_type,
    format: challenge.format,
    calculated_stats: {
      role_balance_score: deterministicBreakdown.role_balance_score,
      pitch_suitability_score: deterministicBreakdown.pitch_suitability_score,
      player_quality_score: deterministicBreakdown.player_quality_score,
      batting_depth_score: deterministicBreakdown.batting_depth_score,
      base_total: deterministicBreakdown.deterministic_total,
    },
    team_composition: {
      total_pacers: pacers.length,
      pacer_names: pacers,
      total_spinners: spinners.length,
      spinner_names: spinners,
      wicketkeepers: keepers,
      lhb_batters: leftHanders,
    },
    referee_instructions: `Evaluate the tactical balance and pitch chemistry. You may adjust the score by an integer delta strictly between -10 and +10. You must not invent or cite unprovided statistics. Return JSON: { "adjustment": number (-10 to 10), "verdict": string }`,
  };
}

/**
 * Applies the bounded LLM adjustment (-10 to +10) and clamps final score (0 - 100).
 */
export function applyBoundedAdjustment(
  deterministicScore: number,
  llmDelta: number,
  verdictSummary: string
): { final_score: number; bounded_delta: number; verdict_summary: string } {
  const bounded_delta = Math.max(-10, Math.min(10, Math.round(llmDelta)));
  const final_score = Math.max(0, Math.min(100, deterministicScore + bounded_delta));

  return {
    final_score,
    bounded_delta,
    verdict_summary: verdictSummary,
  };
}
