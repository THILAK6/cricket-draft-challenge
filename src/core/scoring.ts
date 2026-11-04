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
  // 1. Role Balance & Batting Order Fit (0 - 25 points)
  // -------------------------------------------------------------
  let roleScore = 0;

  // Keeper check (4.0 pts)
  const hasKeeper = squad.some((p) => p.primary_role === "WK");
  if (hasKeeper) roleScore += 4.0;

  // 5+ bowling options (4.5 to 5.0 pts)
  const bowlingOptions = squad.filter(
    (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0
  );
  if (bowlingOptions.length >= 6) roleScore += 5.0;
  else if (bowlingOptions.length === 5) roleScore += 4.0;
  else roleScore += Math.max(0, bowlingOptions.length * 0.8);

  // Positional Batting Order Fit:
  // Slots 1 & 2 (indices 0, 1): Expects top order batters
  let openerPoints = 0;
  for (let i = 0; i < Math.min(2, squad.length); i++) {
    const p = squad[i];
    if (p.primary_role === "BOWL") {
      // Severe penalty for opening with a tailender
      roleScore -= 4.0;
    } else if (
      p.stats.top_order_innings >= 6 ||
      (p.primary_role === "BAT" && p.stats.top_order_innings >= p.stats.middle_order_innings)
    ) {
      openerPoints += 1.75;
    } else {
      openerPoints += 0.75;
    }
  }
  roleScore += Math.min(3.5, openerPoints);

  // Middle Order Stability: Slots 3, 4, 5
  let middleOrderCount = 0;
  for (let i = 2; i < Math.min(5, squad.length); i++) {
    const p = squad[i];
    if (p.primary_role === "BOWL") {
      roleScore -= 3.0; // Penalty for pure bowler in middle order
    } else if (p.primary_role === "BAT" || p.primary_role === "WK" || p.primary_role === "AR") {
      middleOrderCount++;
    }
  }
  roleScore += Math.min(3.0, middleOrderCount * 1.0);

  // Finisher in Slots 5, 6, 7 (User requirement: no finishers selected must affect result)
  let hasFinisher = false;
  for (let i = 4; i < Math.min(7, squad.length); i++) {
    const p = squad[i];
    const isFinisher =
      p.stats.finisher_innings >= 6 ||
      (p.primary_role === "AR" && p.stats.bat_strike_rate >= 135) ||
      (p.stats.bat_strike_rate >= 142 && p.stats.bat_runs >= 200);
    if (isFinisher) {
      hasFinisher = true;
      break;
    }
  }

  if (hasFinisher) {
    roleScore += 2.5;
  } else if (squad.length >= 7) {
    // Deficit penalty for missing a finisher in death overs
    roleScore -= 3.5;
  }

  // Attack Diversity (Pace + Spin Synergy):
  // Modern cricket requires both pace and spin unless pitch is a freak surface.
  const pacers = squad.filter((p) => p.bowling_category === "PACE");
  const spinners = squad.filter((p) => p.bowling_category === "SPIN");
  if (pacers.length >= 2 && spinners.length >= 1) {
    roleScore += 2.0; // Multi-dimensional attack synergy
  } else if (squad.length >= 8 && (pacers.length === 0 || spinners.length === 0)) {
    // One-dimensional attack warning
    roleScore -= 2.0;
  }

  // Death Over Bowling Capability (Overs 16-20 specialist):
  const deathCapable = squad.filter(
    (p) =>
      (p.primary_role === "BOWL" || p.primary_role === "AR") &&
      p.stats.bowl_overs >= 10 &&
      p.stats.bowl_economy > 0 &&
      p.stats.bowl_economy <= 7.8
  );
  if (deathCapable.length >= 1) {
    roleScore += 1.5; // Has proven death over bowler
  } else if (squad.length >= 9) {
    // No bowler capable of keeping economy under 8.2 at death
    const anyDecentEconomy = squad.some(
      (p) => (p.primary_role === "BOWL" || p.primary_role === "AR") && p.stats.bowl_economy <= 8.2
    );
    if (!anyDecentEconomy) roleScore -= 2.0;
  }

  // Left-Hand / Right-Hand Batting Variation in Top 6:
  const top6 = squad.slice(0, 6);
  const hasLhbTop6 = top6.some((p) => p.batting_hand === "LHB");
  const hasRhbTop6 = top6.some((p) => p.batting_hand === "RHB");
  if (top6.length >= 4 && hasLhbTop6 && hasRhbTop6) {
    roleScore += 1.0; // Disrupts bowler line and length
  }

  // Anchor vs Aggressor Balance in Top 5:
  const top5 = squad.slice(0, 5);
  const hasAnchor = top5.some(
    (p) => p.stats.bat_average >= 30 && p.stats.bat_innings >= 10 && p.primary_role !== "BOWL"
  );
  const hasAggressor = top5.some(
    (p) => p.stats.bat_strike_rate >= 135 && p.stats.bat_innings >= 10 && p.primary_role !== "BOWL"
  );
  if (top5.length >= 4 && hasAnchor && hasAggressor) {
    roleScore += 1.0; // Ideal top-order construction: anchor anchors while stroke-makers attack
  }

  const role_balance_score = Math.max(0, Math.min(25, Math.round(roleScore * 10) / 10));

  // -------------------------------------------------------------
  // 2. Pitch Suitability & Country Venue Conditions (0 - 25 points)
  // -------------------------------------------------------------
  let pitchScore = 15; // base baseline
  const hostCountry = challenge.venue.country || "";

  switch (pitch_type) {
    case "GREEN_SEAMER": {
      // Rewards 3+ pacers with good economy
      if (pacers.length >= 3) pitchScore += 8;
      else if (pacers.length === 2) pitchScore += 4;
      else pitchScore -= 5;
      // High seamers economy bonus
      const goodSeam = pacers.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= 7.8);
      if (goodSeam.length >= 2) pitchScore += 2;
      // Excessive spin penalty on green seamer
      if (spinners.length >= 3) pitchScore -= 4;
      break;
    }

    case "DUSTBOWL": {
      // Rewards 2-3 quality spinners
      if (spinners.length >= 3) pitchScore += 10;
      else if (spinners.length === 2) pitchScore += 7;
      else if (spinners.length === 1) pitchScore += 2;
      else pitchScore -= 8;
      // Excessive pacers on a crumbling turner leak runs
      if (pacers.length >= 4) pitchScore -= 3;
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

  // Country-Specific Venue Conditions (Host Territory Nuances):
  // South Africa (RSA): Express pace and steep bounce (Wanderers / Centurion)
  if (hostCountry === "RSA") {
    const expressPacers = pacers.filter((p) => p.stats.bowl_wickets >= 30 && p.stats.bowl_economy <= 8.0);
    if (expressPacers.length >= 2) pitchScore += 2.5; // Steyn/Rabada pace domination in highveld
    if (spinners.length >= 3) pitchScore -= 3.0; // Spinners struggle with altitude and lack of grip
  }
  // Subcontinent (IND, BAN, SL): Spin mastery and batting spin technique
  else if (hostCountry === "IND" || hostCountry === "BAN" || hostCountry === "SL") {
    const eliteSpinners = spinners.filter((p) => p.stats.bowl_wickets >= 25 && p.stats.bowl_economy <= 7.5);
    if (eliteSpinners.length >= 2) pitchScore += 2.5; // Ashwin/Jadeja/Narine subcontinental mastery
  }
  // England (ENG): Seam movement & English swinging conditions
  else if (hostCountry === "ENG") {
    const swingBowlers = pacers.filter((p) => p.stats.bowl_economy <= 7.8);
    if (swingBowlers.length >= 2) pitchScore += 2.0; // Anderson/Woakes seam & swing mastery
  }
  // Australia (AUS): True bounce and large square boundaries
  else if (hostCountry === "AUS") {
    const paceBounce = pacers.filter((p) => p.stats.bowl_wickets >= 30);
    if (paceBounce.length >= 2) pitchScore += 2.0; // Starc/Cummins true bounce mastery
  }

  const pitch_suitability_score = Math.max(0, Math.min(25, Math.round(pitchScore * 10) / 10));

  // -------------------------------------------------------------
  // 3. Player Quality Score with Bayesian Experience Weighting (0 - 35 points)
  // -------------------------------------------------------------
  let qualityTotal = 0;

  for (const p of squad) {
    const matches = Math.max(1, p.stats.matches);
    // Bayesian credibility weight: regresses small-sample anomalies toward replacement baseline
    const w = matches / (matches + 22);

    if (p.primary_role === "BAT" || p.primary_role === "WK" || p.primary_role === "AR") {
      // Regressed batting average and strike rate
      const regAvg = w * Math.min(52, p.stats.bat_average) + (1 - w) * 20.0;
      const regSr = w * Math.min(160, p.stats.bat_strike_rate) + (1 - w) * 115.0;

      // Veteran longevity composure bonus
      const expBonus = matches >= 100 ? 0.35 : matches >= 50 ? 0.2 : matches < 12 ? -0.3 : 0;
      const batRating = (regAvg / 35.0) * 0.5 + (regSr / 135.0) * 0.5 + expBonus;
      qualityTotal += batRating * 2.7;
    }

    if (p.primary_role === "BOWL" || p.primary_role === "AR") {
      const econ = p.stats.bowl_economy || 8.5;
      const wpm = p.stats.bowl_wickets / matches;
      const regEcon = w * Math.max(5.5, econ) + (1 - w) * 8.5;
      const regWpm = w * Math.min(1.6, wpm) + (1 - w) * 0.6;

      const expBonus = matches >= 80 ? 0.3 : matches >= 40 ? 0.15 : matches < 12 ? -0.25 : 0;
      const bowlRating = (7.5 / regEcon) * 0.5 + (regWpm / 1.0) * 0.5 + expBonus;
      qualityTotal += bowlRating * 2.8;
    }
  }

  const player_quality_score = Math.max(10, Math.min(35, Math.round(qualityTotal * 0.55)));

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

