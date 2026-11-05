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
  squad: (PlayerWithStats | null)[],
  challenge: Challenge
): Omit<ScoringBreakdown, "llm_adjustment" | "final_score" | "verdict_summary"> {
  const nonNullSquad = squad.filter((p): p is PlayerWithStats => p !== null);
  const { pitch_type } = challenge.venue;
  const format = challenge.format || "T20";
  const isTest = format === "TEST";
  const isOdi = format === "ODI";
  const isT20 = format === "T20" || (!isTest && !isOdi);

  // -------------------------------------------------------------
  // 1. Role Balance & Batting Order Fit (0 - 25 points)
  // -------------------------------------------------------------
  let roleScore = 0;

  // Keeper check (4.0 pts)
  const hasKeeper = nonNullSquad.some((p) => p.primary_role === "WK");
  if (hasKeeper) roleScore += 4.0;

  // Bowling options (4.5 to 5.0 pts)
  const bowlingOptions = nonNullSquad.filter(
    (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0
  );
  if (isTest) {
    // Tests: 4 frontline bowlers + 1 backup option is standard international construction
    const frontlineBowlers = nonNullSquad.filter((p) => p.primary_role === "BOWL" || p.primary_role === "AR");
    if (frontlineBowlers.length >= 5) roleScore += 5.0;
    else if (frontlineBowlers.length === 4 && bowlingOptions.length >= 5) roleScore += 4.5;
    else if (bowlingOptions.length >= 4) roleScore += 3.5;
    else roleScore += Math.max(0, bowlingOptions.length * 0.8);
  } else {
    // T20 & ODI: Need 5-6 distinct bowling options to prevent over-exposure
    if (bowlingOptions.length >= 6) roleScore += 5.0;
    else if (bowlingOptions.length === 5) roleScore += 4.0;
    else roleScore += Math.max(0, bowlingOptions.length * 0.8);
  }

  // Positional Batting Order Fit:
  // Slots 1 & 2 (indices 0, 1): Expects top order specialist batters
  let openerPoints = 0;
  for (let i = 0; i < Math.min(2, squad.length); i++) {
    const p = squad[i];
    if (!p) continue;
    if (p.primary_role === "BOWL") {
      // Severe tactical penalty for opening with a tailender
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
    if (!p) continue;
    if (p.primary_role === "BOWL") {
      roleScore -= 3.0; // Penalty for pure bowler in middle order
    } else if (p.primary_role === "BAT" || p.primary_role === "WK" || p.primary_role === "AR") {
      middleOrderCount++;
    }
  }
  roleScore += Math.min(3.0, middleOrderCount * 1.0);

  // Lower-Middle Order Construction (Slots 5, 6, 7):
  // Format-specific: T20/ODI requires explosive death finishers; Tests require all-round resilience & batting depth
  if (isTest) {
    // Tests: Check for Lower-Middle Order Spine (Slots 5, 6, 7)
    // Needs all-round batting depth or genuine Test keeper with batting pedigree (Gilchrist, Pant, Stokes, Boucher)
    let hasLowerMiddleSpine = false;
    for (let i = 4; i < Math.min(7, squad.length); i++) {
      const p = squad[i];
      if (!p) continue;
      if (
        p.primary_role === "AR" ||
        p.primary_role === "WK" ||
        (p.primary_role === "BAT" && (p.stats.bat_average >= 32.0 || p.stats.matches >= 25))
      ) {
        hasLowerMiddleSpine = true;
        break;
      }
    }
    if (hasLowerMiddleSpine) {
      roleScore += 2.5; // Solid Test lower-middle order
    }
    // No finisher penalty in Test matches!
  } else {
    // Limited Overs (T20 & ODI): Requires authentic Death Finisher
    let hasFinisher = false;
    for (let i = 4; i < Math.min(7, squad.length); i++) {
      const p = squad[i];
      if (!p) continue;
      let isFinisher = false;
      if (isT20) {
        isFinisher =
          p.stats.finisher_innings >= 6 ||
          (p.primary_role === "AR" && p.stats.bat_strike_rate >= 135) ||
          (p.stats.bat_strike_rate >= 142 && p.stats.bat_runs >= 200);
      } else {
        isFinisher =
          p.stats.finisher_innings >= 6 ||
          (p.primary_role === "AR" && p.stats.bat_strike_rate >= 95) ||
          (p.stats.bat_strike_rate >= 105 && p.stats.bat_runs >= 300);
      }
      if (isFinisher) {
        hasFinisher = true;
        break;
      }
    }

    if (hasFinisher) {
      roleScore += 2.5;
    } else if (nonNullSquad.length >= 7) {
      roleScore -= 3.5; // Penalty for missing finisher in T20/ODI
    }
  }

  // Attack Diversity (Pace + Spin Synergy):
  const pacers = nonNullSquad.filter((p) => p.bowling_category === "PACE");
  const spinners = nonNullSquad.filter((p) => p.bowling_category === "SPIN");
  if (pacers.length >= 2 && spinners.length >= 1) {
    roleScore += 2.0; // Multi-dimensional attack synergy
  } else if (nonNullSquad.length >= 8 && (pacers.length === 0 || spinners.length === 0)) {
    // One-dimensional attack warning
    roleScore -= 2.0;
  }

  // Death / Control Bowling Capability:
  if (isT20) {
    const deathCapable = nonNullSquad.filter(
      (p) =>
        (p.primary_role === "BOWL" || p.primary_role === "AR") &&
        p.stats.bowl_overs >= 10 &&
        p.stats.bowl_economy > 0 &&
        p.stats.bowl_economy <= 7.8
    );
    if (deathCapable.length >= 1) {
      roleScore += 1.5;
    } else if (nonNullSquad.length >= 9) {
      const anyDecentEconomy = nonNullSquad.some(
        (p) => (p.primary_role === "BOWL" || p.primary_role === "AR") && p.stats.bowl_economy <= 8.2
      );
      if (!anyDecentEconomy) roleScore -= 2.0;
    }
  } else if (isOdi) {
    // ODI: Needs bowlers capable of restricting middle/death overs (econ <= 5.4)
    const odiControlBowlers = nonNullSquad.filter(
      (p) =>
        (p.primary_role === "BOWL" || p.primary_role === "AR") &&
        p.stats.bowl_overs >= 20 &&
        p.stats.bowl_economy > 0 &&
        p.stats.bowl_economy <= 5.4
    );
    if (odiControlBowlers.length >= 1) {
      roleScore += 1.5;
    } else if (nonNullSquad.length >= 9) {
      const anyDecentEconomy = nonNullSquad.some(
        (p) => (p.primary_role === "BOWL" || p.primary_role === "AR") && p.stats.bowl_economy <= 5.9
      );
      if (!anyDecentEconomy) roleScore -= 2.0;
    }
  } else {
    // TEST: Strike bowler with penetration (average <= 28.0 and strike rate <= 55)
    const testStrikeBowlers = nonNullSquad.filter(
      (p) =>
        (p.primary_role === "BOWL" || p.primary_role === "AR") &&
        p.stats.bowl_overs >= 30 &&
        p.stats.bowl_wickets >= 15 &&
        p.stats.bowl_average > 0 &&
        p.stats.bowl_average <= 28.5
    );
    if (testStrikeBowlers.length >= 1) {
      roleScore += 1.5;
    } else if (nonNullSquad.length >= 9) {
      const anyDecentAverage = nonNullSquad.some(
        (p) => (p.primary_role === "BOWL" || p.primary_role === "AR") && p.stats.bowl_average <= 34.0
      );
      if (!anyDecentAverage) roleScore -= 2.0;
    }
  }

  // Left-Hand / Right-Hand Batting Variation in Top 6:
  const top6 = squad.slice(0, 6).filter((p): p is PlayerWithStats => p !== null);
  const hasLhbTop6 = top6.some((p) => p.batting_hand === "LHB");
  const hasRhbTop6 = top6.some((p) => p.batting_hand === "RHB");
  if (top6.length >= 4 && hasLhbTop6 && hasRhbTop6) {
    roleScore += 1.0; // Disrupts bowler line and length
  }

  // Anchor vs Aggressor Balance in Top 5:
  const top5 = squad.slice(0, 5).filter((p): p is PlayerWithStats => p !== null);
  let hasAnchor = false;
  let hasAggressor = false;

  if (isT20) {
    hasAnchor = top5.some(
      (p) => p.stats.bat_average >= 30 && p.stats.bat_innings >= 10 && p.primary_role !== "BOWL"
    );
    hasAggressor = top5.some(
      (p) => p.stats.bat_strike_rate >= 135 && p.stats.bat_innings >= 10 && p.primary_role !== "BOWL"
    );
  } else if (isOdi) {
    hasAnchor = top5.some(
      (p) => p.stats.bat_average >= 38 && p.stats.bat_innings >= 12 && p.primary_role !== "BOWL"
    );
    hasAggressor = top5.some(
      (p) => p.stats.bat_strike_rate >= 92 && p.stats.bat_innings >= 12 && p.primary_role !== "BOWL"
    );
  } else {
    // TEST
    hasAnchor = top5.some(
      (p) => p.stats.bat_average >= 42 && p.stats.bat_innings >= 10 && p.primary_role !== "BOWL"
    );
    hasAggressor = top5.some(
      (p) => p.stats.bat_average >= 38 && p.stats.bat_strike_rate >= 52 && p.stats.bat_innings >= 10 && p.primary_role !== "BOWL"
    );
  }

  if (top5.length >= 4 && hasAnchor && hasAggressor) {
    roleScore += 1.0;
  }

  const role_balance_score = Math.max(0, Math.min(25, Math.round(roleScore * 10) / 10));

  // -------------------------------------------------------------
  // 2. Pitch Suitability & Country Venue Conditions (0 - 25 points)
  // -------------------------------------------------------------
  // Only real bowlers count towards pitch fit: a batter who bowls a few overs of seam is not a
  // seam attack. Frontline = a specialist bowler, or an all-rounder with a real wicket record.
  const wktsNeeded = isTest ? 40 : 25;
  const frontline = (p: PlayerWithStats) => p.primary_role === "BOWL" || (p.primary_role === "AR" && p.stats.bowl_wickets >= wktsNeeded);
  const fPacers = pacers.filter(frontline);
  const fSpinners = spinners.filter(frontline);
  let pitchScore = 15; // base baseline
  const hostCountry = challenge.venue.country || "";

  switch (pitch_type) {
    case "GREEN_SEAMER": {
      // Rewards 3+ fPacers
      if (fPacers.length >= 3) pitchScore += 8;
      else if (fPacers.length === 2) pitchScore += 4;
      else pitchScore -= 5;

      const seamBenchmarkEcon = isT20 ? 7.8 : isOdi ? 5.2 : 3.2;
      const goodSeam = fPacers.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= seamBenchmarkEcon);
      if (goodSeam.length >= 2) pitchScore += 2;
      if (fSpinners.length >= 3) pitchScore -= 4;
      // An attack that leans on spin on a seaming pitch wastes the conditions
      if (fSpinners.length > fPacers.length) pitchScore -= 3;
      break;
    }

    case "DUSTBOWL": {
      if (fSpinners.length >= 3) pitchScore += 10;
      else if (fSpinners.length === 2) pitchScore += 7;
      else if (fSpinners.length === 1) pitchScore += 2;
      else pitchScore -= 8;
      if (fPacers.length >= 4) pitchScore -= 3;
      break;
    }

    case "HIGH_SCORING_FLAT": {
      const srThreshold = isT20 ? 135.0 : isOdi ? 92.0 : 55.0;
      const highSrBatters = nonNullSquad.filter((p) => p.stats.bat_strike_rate >= srThreshold);
      if (highSrBatters.length >= 4) pitchScore += 7;
      else if (highSrBatters.length >= 2) pitchScore += 4;

      const deathEconThreshold = isT20 ? 7.5 : isOdi ? 5.0 : 3.0;
      const controlBowlers = nonNullSquad.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= deathEconThreshold);
      if (controlBowlers.length >= 2) pitchScore += 3;
      break;
    }

    case "SLOW_LOW": {
      if (fSpinners.length >= 2) pitchScore += 5;
      const slowLowEcon = isT20 ? 7.2 : isOdi ? 4.9 : 2.8;
      const accurateBowlers = nonNullSquad.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= slowLowEcon);
      if (accurateBowlers.length >= 3) pitchScore += 5;
      break;
    }
  }

  // Country-Specific Venue Conditions (Host Territory Nuances):
  if (hostCountry === "RSA") {
    const pacerWktsThreshold = isTest ? 40 : 25;
    const expressPacers = fPacers.filter((p) => p.stats.bowl_wickets >= pacerWktsThreshold);
    if (expressPacers.length >= 2) pitchScore += 2.5; // Steyn/Rabada pace domination in highveld
    if (fSpinners.length >= 3) pitchScore -= 3.0; // Spinners struggle with altitude and lack of grip
  } else if (hostCountry === "IND" || hostCountry === "BAN" || hostCountry === "SL") {
    const spinWktsThreshold = isTest ? 40 : 25;
    const eliteSpinners = fSpinners.filter((p) => p.stats.bowl_wickets >= spinWktsThreshold);
    if (eliteSpinners.length >= 2) pitchScore += 2.5; // Ashwin/Jadeja/Narine subcontinental mastery
  } else if (hostCountry === "ENG") {
    const swingEconThreshold = isT20 ? 7.8 : isOdi ? 5.2 : 3.2;
    const swingBowlers = fPacers.filter((p) => p.stats.bowl_economy <= swingEconThreshold);
    if (swingBowlers.length >= 2) pitchScore += 2.0; // Anderson/Woakes seam & swing mastery
  } else if (hostCountry === "AUS") {
    const pacerWktsThreshold = isTest ? 40 : 25;
    const paceBounce = fPacers.filter((p) => p.stats.bowl_wickets >= pacerWktsThreshold);
    if (paceBounce.length >= 2) pitchScore += 2.0; // Starc/Cummins true bounce mastery
  }

  const pitch_suitability_score = Math.max(0, Math.min(25, Math.round(pitchScore * 10) / 10));

  // -------------------------------------------------------------
  // 3. Player Quality Score with Bayesian Experience Weighting (0 - 35 points)
  // -------------------------------------------------------------
  let qualityTotal = 0;

  for (const p of nonNullSquad) {
    const matches = Math.max(1, p.stats.matches);

    if (isTest) {
      // Test Match Quality Calibration:
      const w = matches / (matches + 12);
      const expBonus = matches >= 60 ? 0.35 : matches >= 30 ? 0.2 : matches < 8 ? -0.3 : 0;

      if (p.primary_role === "BAT" || p.primary_role === "WK" || p.primary_role === "AR") {
        const regAvg = w * Math.min(60, p.stats.bat_average) + (1 - w) * 22.0;
        const regSr = w * Math.min(75, p.stats.bat_strike_rate) + (1 - w) * 45.0;
        const batRating = (regAvg / 45.0) * 0.82 + (regSr / 55.0) * 0.18 + expBonus;
        qualityTotal += batRating * 2.7;
      }

      if (p.primary_role === "BOWL" || p.primary_role === "AR") {
        const bowlAvg = p.stats.bowl_average || 38.0;
        const wpm = p.stats.bowl_wickets / matches;
        const regBowlAvg = w * Math.max(18, bowlAvg) + (1 - w) * 36.0;
        const regWpm = w * Math.min(5.0, wpm) + (1 - w) * 1.5;
        const bowlRating = (28.0 / regBowlAvg) * 0.6 + (regWpm / 3.0) * 0.4 + expBonus;
        qualityTotal += bowlRating * 2.8;
      }
    } else if (isOdi) {
      // ODI Quality Calibration:
      const w = matches / (matches + 25);
      const expBonus = matches >= 100 ? 0.35 : matches >= 50 ? 0.2 : matches < 15 ? -0.25 : 0;

      if (p.primary_role === "BAT" || p.primary_role === "WK" || p.primary_role === "AR") {
        const regAvg = w * Math.min(55, p.stats.bat_average) + (1 - w) * 22.0;
        const regSr = w * Math.min(115, p.stats.bat_strike_rate) + (1 - w) * 78.0;
        const batRating = (regAvg / 40.0) * 0.6 + (regSr / 90.0) * 0.4 + expBonus;
        qualityTotal += batRating * 2.7;
      }

      if (p.primary_role === "BOWL" || p.primary_role === "AR") {
        const econ = p.stats.bowl_economy || 6.2;
        const wpm = p.stats.bowl_wickets / matches;
        const regEcon = w * Math.max(4.0, econ) + (1 - w) * 6.2;
        const regWpm = w * Math.min(2.5, wpm) + (1 - w) * 0.8;
        const bowlRating = (5.2 / regEcon) * 0.5 + (regWpm / 1.3) * 0.5 + expBonus;
        qualityTotal += bowlRating * 2.8;
      }
    } else {
      // T20 Quality Calibration:
      const w = matches / (matches + 22);
      const expBonus = matches >= 100 ? 0.35 : matches >= 50 ? 0.2 : matches < 12 ? -0.3 : 0;

      if (p.primary_role === "BAT" || p.primary_role === "WK" || p.primary_role === "AR") {
        const regAvg = w * Math.min(52, p.stats.bat_average) + (1 - w) * 20.0;
        const regSr = w * Math.min(160, p.stats.bat_strike_rate) + (1 - w) * 115.0;
        const batRating = (regAvg / 35.0) * 0.5 + (regSr / 135.0) * 0.5 + expBonus;
        qualityTotal += batRating * 2.7;
      }

      if (p.primary_role === "BOWL" || p.primary_role === "AR") {
        const econ = p.stats.bowl_economy || 8.5;
        const wpm = p.stats.bowl_wickets / matches;
        const regEcon = w * Math.max(5.5, econ) + (1 - w) * 8.5;
        const regWpm = w * Math.min(1.6, wpm) + (1 - w) * 0.6;
        const bowlRating = (7.5 / regEcon) * 0.5 + (regWpm / 1.0) * 0.5 + expBonus;
        qualityTotal += bowlRating * 2.8;
      }
    }
  }

  const player_quality_score = Math.max(10, Math.min(35, Math.round(qualityTotal * 0.55)));

  // -------------------------------------------------------------
  // 4. Batting Depth Score (0 - 15 points)
  // -------------------------------------------------------------
  const sortedBatters = [...nonNullSquad].sort(
    (a, b) => b.stats.bat_average * b.stats.bat_strike_rate - a.stats.bat_average * a.stats.bat_strike_rate
  );

  const lowerOrder = sortedBatters.slice(6, 9);
  let depthPoints = 0;
  for (const p of lowerOrder) {
    if (isTest) {
      if (p.stats.bat_runs >= 300 || p.stats.bat_average >= 22 || p.primary_role === "AR") {
        depthPoints += 5;
      } else if (p.stats.bat_runs >= 150 || p.stats.bat_average >= 15) {
        depthPoints += 3;
      } else {
        depthPoints += 1;
      }
    } else {
      if (p.stats.bat_runs >= 200 || p.stats.bat_average >= 18 || p.primary_role === "AR") {
        depthPoints += 5;
      } else if (p.stats.bat_runs >= 100 || p.stats.bat_average >= 12) {
        depthPoints += 3;
      } else {
        depthPoints += 1;
      }
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

