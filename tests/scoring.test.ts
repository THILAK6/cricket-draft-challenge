import { describe, it, expect } from "vitest";
import {
  calculateDeterministicScore,
  buildRefereePromptPayload,
  applyBoundedAdjustment,
} from "../src/core/scoring";
import type { Challenge, PlayerWithStats } from "../src/core/types";

function createPlayer(
  id: string,
  country: string,
  role: "BAT" | "WK" | "AR" | "BOWL",
  hand: "LHB" | "RHB" = "RHB",
  bowlingCat: "NONE" | "PACE" | "SPIN" = "NONE",
  econ = 7.5,
  sr = 135.0,
  batAvg = 32.0
): PlayerWithStats {
  return {
    id,
    name: `Player ${id}`,
    country,
    batting_hand: hand,
    bowling_category: bowlingCat,
    primary_role: role,
    stats: {
      player_id: id,
      format: "T20",
      matches: 40,
      bat_innings: 35,
      bat_runs: 1000,
      bat_average: batAvg,
      bat_strike_rate: sr,
      top_order_innings: role === "BAT" ? 25 : 0,
      middle_order_innings: 10,
      finisher_innings: 0,
      bowl_innings: role === "BOWL" || role === "AR" ? 35 : 0,
      bowl_overs: role === "BOWL" || role === "AR" ? 4.0 : 0,
      bowl_wickets: role === "BOWL" || role === "AR" ? 45 : 0,
      bowl_average: 21.0,
      bowl_economy: econ,
    },
  };
}

describe("Scoring Engine - Deterministic Layer", () => {
  const dustbowlChallenge: Challenge = {
    id: "c-dust",
    title: "Chepauk Trial",
    format: "T20",
    venue: {
      name: "MA Chidambaram Stadium, Chennai",
      country: "IND",
      pitch_type: "DUSTBOWL",
    },
    narrative_intro: "A raging turner.",
    constraints: [],
  };

  it("scores higher for a squad with 3 spinners on a DUSTBOWL compared to 0 spinners", () => {
    // Squad A: 3 quality spinners
    const spinSquad: PlayerWithStats[] = [
      createPlayer("p1", "IND", "BAT", "RHB", "NONE"),
      createPlayer("p2", "AUS", "BAT", "LHB", "NONE"),
      createPlayer("p3", "ENG", "BAT", "RHB", "NONE"),
      createPlayer("p4", "RSA", "BAT", "RHB", "NONE"),
      createPlayer("p5", "NZL", "WK", "RHB", "NONE"),
      createPlayer("p6", "BAN", "AR", "LHB", "SPIN"),   // Spin 1
      createPlayer("p7", "AFG", "AR", "RHB", "SPIN"),   // Spin 2
      createPlayer("p8", "IND", "BOWL", "RHB", "SPIN"), // Spin 3
      createPlayer("p9", "PAK", "BOWL", "RHB", "PACE"),
      createPlayer("p10", "WI", "BOWL", "RHB", "PACE"),
      createPlayer("p11", "SL", "BOWL", "RHB", "PACE"),
    ];

    // Squad B: 0 spinners (all pace)
    const paceOnlySquad: PlayerWithStats[] = spinSquad.map((p, idx) =>
      p.bowling_category === "SPIN"
        ? createPlayer(`pace_${idx}`, p.country, p.primary_role, p.batting_hand, "PACE")
        : p
    );

    const spinScore = calculateDeterministicScore(spinSquad, dustbowlChallenge);
    const paceScore = calculateDeterministicScore(paceOnlySquad, dustbowlChallenge);

    expect(spinScore.pitch_suitability_score).toBeGreaterThan(paceScore.pitch_suitability_score);
    expect(spinScore.deterministic_total).toBeGreaterThan(paceScore.deterministic_total);
  });

  it("calculates batting depth based on lower order contributions", () => {
    const strongDepthSquad: PlayerWithStats[] = [
      createPlayer("p1", "IND", "BAT"),
      createPlayer("p2", "AUS", "BAT"),
      createPlayer("p3", "ENG", "BAT"),
      createPlayer("p4", "RSA", "BAT"),
      createPlayer("p5", "NZL", "WK"),
      createPlayer("p6", "BAN", "AR", "LHB", "SPIN", 7.0, 140, 28), // AR pos 6
      createPlayer("p7", "WI", "AR", "RHB", "PACE", 7.8, 155, 26),  // AR pos 7
      createPlayer("p8", "PAK", "AR", "RHB", "PACE", 7.5, 130, 22), // AR pos 8
      createPlayer("p9", "AFG", "BOWL", "RHB", "SPIN"),
      createPlayer("p10", "SL", "BOWL", "RHB", "SPIN"),
      createPlayer("p11", "ENG", "BOWL", "RHB", "PACE"),
    ];

    const score = calculateDeterministicScore(strongDepthSquad, dustbowlChallenge);
    expect(score.batting_depth_score).toBeGreaterThanOrEqual(10);
    expect(score.deterministic_total).toBeGreaterThanOrEqual(70);
  });
});

describe("Scoring Engine - LLM Layer Guardrails", () => {
  it("strictly bounds LLM adjustments to [-10, +10]", () => {
    // Extreme positive adjustment clamped to 10
    const overzealous = applyBoundedAdjustment(70, 25, "Amazing balance!");
    expect(overzealous.bounded_delta).toBe(10);
    expect(overzealous.final_score).toBe(80);

    // Extreme negative adjustment clamped to -10
    const overlyHarsh = applyBoundedAdjustment(70, -35, "Terrible tactics!");
    expect(overlyHarsh.bounded_delta).toBe(-10);
    expect(overlyHarsh.final_score).toBe(60);

    // Clamping against 0 and 100 boundary
    const boundaryHigh = applyBoundedAdjustment(96, 8, "Flawless");
    expect(boundaryHigh.final_score).toBe(100);

    const boundaryLow = applyBoundedAdjustment(5, -9, "Broken");
    expect(boundaryLow.final_score).toBe(0);
  });

  it("builds a clean factual referee prompt payload without hallucinations", () => {
    const squad: PlayerWithStats[] = [
      createPlayer("p1", "IND", "BAT", "LHB"),
      createPlayer("p2", "AUS", "BAT", "RHB"),
      createPlayer("p3", "ENG", "BAT", "RHB"),
      createPlayer("p4", "RSA", "BAT", "RHB"),
      createPlayer("p5", "NZL", "WK", "RHB"),
      createPlayer("p6", "BAN", "AR", "LHB", "SPIN"),
      createPlayer("p7", "WI", "BOWL", "RHB", "PACE"),
      createPlayer("p8", "PAK", "BOWL", "RHB", "PACE"),
      createPlayer("p9", "AFG", "BOWL", "RHB", "SPIN"),
      createPlayer("p10", "SL", "BOWL", "RHB", "PACE"),
      createPlayer("p11", "ENG", "BOWL", "RHB", "PACE"),
    ];

    const challenge: Challenge = {
      id: "c1",
      title: "Test",
      format: "T20",
      venue: { name: "Lord's", country: "ENG", pitch_type: "GREEN_SEAMER" },
      narrative_intro: "A green pitch",
      constraints: [],
    };

    const breakdown = calculateDeterministicScore(squad, challenge);
    const payload = buildRefereePromptPayload(squad, challenge, breakdown);

    expect(payload.calculated_stats.base_total).toBe(breakdown.deterministic_total);
    expect(payload.team_composition.total_pacers).toBe(4);
    expect(payload.team_composition.total_spinners).toBe(2);
    expect(payload.team_composition.wicketkeepers).toContain("Player p5");
    expect(payload.referee_instructions).toContain("-10 and +10");
  });

  it("penalizes teams with no finishers in slots 5-7 compared to teams with explosive finishers", () => {
    const challenge: Challenge = {
      id: "c-finisher",
      title: "Finisher Test",
      format: "T20",
      venue: { name: "Wankhede", country: "IND", pitch_type: "HIGH_SCORING_FLAT" },
      narrative_intro: "High scoring venue",
      constraints: [],
    };

    // Squad with explosive finisher at pos 6 (Maxwell / Klaasen profile)
    const squadWithFinisher: PlayerWithStats[] = [
      createPlayer("p1", "IND", "BAT", "RHB", "NONE", 8, 140, 35),
      createPlayer("p2", "AUS", "BAT", "LHB", "NONE", 8, 145, 33),
      createPlayer("p3", "ENG", "BAT", "RHB", "NONE", 8, 138, 38),
      createPlayer("p4", "RSA", "BAT", "RHB", "NONE", 8, 135, 34),
      createPlayer("p5", "NZL", "WK", "RHB", "NONE", 8, 136, 32),
      createPlayer("p6", "AUS", "AR", "RHB", "SPIN", 7.8, 155, 31), // Explosive Finisher
      createPlayer("p7", "IND", "AR", "RHB", "PACE", 7.5, 145, 29), // Finisher AR
      createPlayer("p8", "PAK", "AR", "RHB", "PACE", 7.6, 130, 22),
      createPlayer("p9", "WI", "BOWL", "RHB", "PACE", 7.2, 100, 10),
      createPlayer("p10", "SL", "BOWL", "RHB", "SPIN", 7.1, 95, 8),
      createPlayer("p11", "AFG", "BOWL", "RHB", "SPIN", 6.8, 90, 7),
    ];

    // Squad with NO finishers (slow accumulators in middle order: SR 110, 0 finisher innings)
    const squadNoFinisher: PlayerWithStats[] = [
      createPlayer("p1", "IND", "BAT", "RHB", "NONE", 8, 140, 35),
      createPlayer("p2", "AUS", "BAT", "LHB", "NONE", 8, 145, 33),
      createPlayer("p3", "ENG", "BAT", "RHB", "NONE", 8, 138, 38),
      createPlayer("p4", "RSA", "BAT", "RHB", "NONE", 8, 120, 28),
      createPlayer("p5", "NZL", "WK", "RHB", "NONE", 8, 120, 28),
      createPlayer("p6_slow", "BAN", "BAT", "RHB", "NONE", 8, 112, 26), // Slow accumulator
      createPlayer("p7_slow", "ZIM", "BAT", "RHB", "NONE", 8, 110, 24), // Slow accumulator
      createPlayer("p8", "PAK", "AR", "RHB", "PACE", 7.6, 120, 18),
      createPlayer("p9", "WI", "BOWL", "RHB", "PACE", 7.2, 100, 10),
      createPlayer("p10", "SL", "BOWL", "RHB", "SPIN", 7.1, 95, 8),
      createPlayer("p11", "AFG", "BOWL", "RHB", "SPIN", 6.8, 90, 7),
    ];

    const withFinisherScore = calculateDeterministicScore(squadWithFinisher, challenge);
    const noFinisherScore = calculateDeterministicScore(squadNoFinisher, challenge);

    expect(withFinisherScore.role_balance_score).toBeGreaterThan(noFinisherScore.role_balance_score);
  });

  it("weighs matches played smartly: a 100-match veteran scores higher than a 6-match player with inflated stats", () => {
    const challenge: Challenge = {
      id: "c-exp",
      title: "Experience Test",
      format: "T20",
      venue: { name: "MCG", country: "AUS", pitch_type: "HIGH_SCORING_FLAT" },
      narrative_intro: "Pressure test",
      constraints: [],
    };

    // 100-match battle-tested veteran (Virat Kohli / Rohit Sharma profile)
    const veteranSquad: PlayerWithStats[] = [];
    for (let i = 1; i <= 11; i++) {
      const p = createPlayer(`vet_${i}`, "IND", i === 5 ? "WK" : i >= 7 ? "BOWL" : "BAT", "RHB", i >= 7 ? "PACE" : "NONE");
      p.stats.matches = 110;
      p.stats.bat_average = 36.0;
      p.stats.bat_strike_rate = 138.0;
      veteranSquad.push(p);
    }

    // 6-match small-sample squad with inflated raw averages
    const smallSampleSquad: PlayerWithStats[] = [];
    for (let i = 1; i <= 11; i++) {
      const p = createPlayer(`novice_${i}`, "IND", i === 5 ? "WK" : i >= 7 ? "BOWL" : "BAT", "RHB", i >= 7 ? "PACE" : "NONE");
      p.stats.matches = 6;
      p.stats.bat_average = 48.0; // High raw average, but only 6 matches
      p.stats.bat_strike_rate = 152.0;
      smallSampleSquad.push(p);
    }

    const veteranScore = calculateDeterministicScore(veteranSquad, challenge);
    const noviceScore = calculateDeterministicScore(smallSampleSquad, challenge);

    // Proven international pedigree beats small sample size
    expect(veteranScore.player_quality_score).toBeGreaterThan(noviceScore.player_quality_score);
  });

  it("evaluates country conditions: express pacers like Dale Steyn score higher in South Africa (RSA)", () => {
    const saChallenge: Challenge = {
      id: "c-sa",
      title: "Wanderers Highveld Clash",
      format: "T20",
      venue: { name: "Wanderers Stadium, Johannesburg", country: "RSA", pitch_type: "GREEN_SEAMER" },
      narrative_intro: "Steep pace and bounce at high altitude.",
      constraints: [],
    };

    // Squad with high-wicket express pacers (Dale Steyn / Kagiso Rabada profile)
    const expressPaceSquad: PlayerWithStats[] = [
      createPlayer("p1", "IND", "BAT"),
      createPlayer("p2", "AUS", "BAT"),
      createPlayer("p3", "ENG", "BAT"),
      createPlayer("p4", "RSA", "BAT"),
      createPlayer("p5", "NZL", "WK"),
      createPlayer("p6", "WI", "AR", "RHB", "PACE", 7.8, 145),
      createPlayer("p7", "IND", "AR", "RHB", "PACE", 7.5, 140),
      createPlayer("p8", "RSA", "BOWL", "RHB", "PACE", 7.2, 100), // Steyn: 50+ wkts, econ 7.2
      createPlayer("p9", "RSA", "BOWL", "RHB", "PACE", 7.4, 100), // Rabada: 45+ wkts, econ 7.4
      createPlayer("p10", "PAK", "BOWL", "RHB", "PACE", 7.5, 100),
      createPlayer("p11", "AFG", "BOWL", "RHB", "SPIN", 6.8, 90),
    ];
    expressPaceSquad[7].stats.bowl_wickets = 55;
    expressPaceSquad[8].stats.bowl_wickets = 48;

    // Squad with 3+ spinners in South Africa (ineffective on high-bounce fast tracks)
    const spinHeavySquad: PlayerWithStats[] = [
      createPlayer("p1", "IND", "BAT"),
      createPlayer("p2", "AUS", "BAT"),
      createPlayer("p3", "ENG", "BAT"),
      createPlayer("p4", "RSA", "BAT"),
      createPlayer("p5", "NZL", "WK"),
      createPlayer("p6", "BAN", "AR", "LHB", "SPIN"),
      createPlayer("p7", "IND", "AR", "RHB", "SPIN"),
      createPlayer("p8", "AFG", "BOWL", "RHB", "SPIN"),
      createPlayer("p9", "SL", "BOWL", "RHB", "SPIN"),
      createPlayer("p10", "PAK", "BOWL", "RHB", "PACE"),
      createPlayer("p11", "ENG", "BOWL", "RHB", "PACE"),
    ];

    const paceScore = calculateDeterministicScore(expressPaceSquad, saChallenge);
    const spinScore = calculateDeterministicScore(spinHeavySquad, saChallenge);

    expect(paceScore.pitch_suitability_score).toBeGreaterThan(spinScore.pitch_suitability_score);
  });

  it("rewards attack diversity: balanced pace + spin synergy outperforms a one-dimensional attack", () => {
    const balancedChallenge: Challenge = {
      id: "c-bal",
      title: "Standard International Pitch",
      format: "T20",
      venue: { name: "Adelaide Oval", country: "AUS", pitch_type: "HIGH_SCORING_FLAT" },
      narrative_intro: "Balanced surface with true bounce.",
      constraints: [],
    };

    // Balanced attack: 3 pacers + 2 spinners
    const balancedSquad: PlayerWithStats[] = [
      createPlayer("p1", "IND", "BAT", "RHB", "NONE", 8, 140),
      createPlayer("p2", "AUS", "BAT", "LHB", "NONE", 8, 140),
      createPlayer("p3", "ENG", "BAT", "RHB", "NONE", 8, 135),
      createPlayer("p4", "RSA", "BAT", "RHB", "NONE", 8, 130),
      createPlayer("p5", "NZL", "WK", "RHB", "NONE", 8, 130),
      createPlayer("p6", "WI", "AR", "RHB", "PACE", 7.5, 145),   // Finisher + Pacer
      createPlayer("p7", "BAN", "AR", "LHB", "SPIN", 7.0, 135),  // Spinner 1
      createPlayer("p8", "IND", "BOWL", "RHB", "SPIN", 7.2, 100), // Spinner 2
      createPlayer("p9", "PAK", "BOWL", "RHB", "PACE", 7.4, 100), // Pacer 2
      createPlayer("p10", "RSA", "BOWL", "RHB", "PACE", 7.3, 100), // Pacer 3
      createPlayer("p11", "AUS", "BOWL", "RHB", "PACE", 7.5, 100), // Pacer 4
    ];

    // One-dimensional attack: 5 pacers + 0 spinners
    const oneDimSquad: PlayerWithStats[] = balancedSquad.map((p, idx) =>
      p.bowling_category === "SPIN"
        ? createPlayer(`pace_rep_${idx}`, p.country, p.primary_role, p.batting_hand, "PACE", 7.5, p.stats.bat_strike_rate)
        : p
    );

    const balancedScore = calculateDeterministicScore(balancedSquad, balancedChallenge);
    const oneDimScore = calculateDeterministicScore(oneDimSquad, balancedChallenge);

    expect(balancedScore.role_balance_score).toBeGreaterThan(oneDimScore.role_balance_score);
  });
});

describe("Scoring Engine - Multi-Format Realism (ODI & TEST)", () => {
  it("evaluates TEST match conditions: green seamer swing attack with elite bowling averages at Lord's", () => {
    const lordsTestChallenge: Challenge = {
      id: "ch_test_lords",
      title: "The Ashes at Lord's - Day 1 Seam Battle",
      format: "TEST",
      venue: { name: "Lord's, London", country: "ENG", pitch_type: "GREEN_SEAMER" },
      narrative_intro: "Day 1 seam and swing under heavy English clouds.",
      constraints: [],
    };

    // Elite Test Squad: High batting averages (48+), 3-4 seamers with low bowling average (Anderson / Broad / McGrath profile)
    const eliteTestSquad: PlayerWithStats[] = [
      createPlayer("t1", "ENG", "BAT", "LHB", "NONE", 3.0, 52, 48),  // Opener Avg 48
      createPlayer("t2", "ENG", "BAT", "RHB", "NONE", 3.0, 50, 46),  // Opener Avg 46
      createPlayer("t3", "IND", "BAT", "RHB", "NONE", 3.0, 58, 52),  // #3 Anchor Avg 52 (Kohli/Root)
      createPlayer("t4", "AUS", "BAT", "RHB", "NONE", 3.0, 55, 55),  // #4 Smith Avg 55
      createPlayer("t5", "ENG", "WK", "RHB", "NONE", 3.0, 54, 38),   // #5 Keeper
      createPlayer("t6", "ENG", "AR", "LHB", "PACE", 3.1, 62, 36),   // #6 Stokes counter-attack
      createPlayer("t7", "IND", "AR", "LHB", "SPIN", 2.8, 52, 34),   // #7 Jadeja Avg 34 + Spin
      createPlayer("t8", "ENG", "BOWL", "RHB", "PACE", 2.6, 25, 14), // #8 Seamer Avg 22
      createPlayer("t9", "AUS", "BOWL", "RHB", "PACE", 2.7, 20, 12), // #9 Cummins Avg 21
      createPlayer("t10", "ENG", "BOWL", "RHB", "PACE", 2.5, 18, 10),// #10 Anderson Avg 24
      createPlayer("t11", "IND", "BOWL", "RHB", "SPIN", 2.7, 15, 8),  // #11 Ashwin Avg 23
    ];
    // Set format to TEST and test-like bowling averages
    eliteTestSquad.forEach((p, idx) => {
      p.stats.format = "TEST";
      p.stats.matches = 75;
      if (idx >= 7) {
        p.stats.bowl_average = 23.5;
        p.stats.bowl_wickets = 250;
      }
    });

    // Sub-optimal Test Squad: T20 players with low Test averages and high bowling averages
    const subOptimalTestSquad: PlayerWithStats[] = eliteTestSquad.map((p, idx) => {
      const copy = { ...p, stats: { ...p.stats, matches: 15, bat_average: 24.0, bowl_average: 44.0 } };
      return copy;
    });

    const eliteScore = calculateDeterministicScore(eliteTestSquad, lordsTestChallenge);
    const subScore = calculateDeterministicScore(subOptimalTestSquad, lordsTestChallenge);

    expect(eliteScore.player_quality_score).toBeGreaterThan(subScore.player_quality_score);
    expect(eliteScore.deterministic_total).toBeGreaterThan(subScore.deterministic_total);
  });

  it("evaluates ODI conditions: anchors, strike rotators, and middle/death controllers at Wanderers", () => {
    const wanderersOdiChallenge: Challenge = {
      id: "ch_odi_wanderers",
      title: "Wanderers 438 Tribute Match",
      format: "ODI",
      venue: { name: "Wanderers Stadium, Johannesburg", country: "RSA", pitch_type: "HIGH_SCORING_FLAT" },
      narrative_intro: "High-scoring 50-over match where 340 is par.",
      constraints: [],
    };

    const strongOdiSquad: PlayerWithStats[] = [
      createPlayer("o1", "IND", "BAT", "RHB", "NONE", 5.0, 92, 49),   // Rohit profile: Avg 49, SR 92
      createPlayer("o2", "AUS", "BAT", "LHB", "NONE", 5.2, 95, 45),   // Warner profile: Avg 45, SR 95
      createPlayer("o3", "IND", "BAT", "RHB", "NONE", 5.0, 93, 58),   // Kohli profile: Avg 58, SR 93
      createPlayer("o4", "NZL", "BAT", "RHB", "NONE", 5.0, 85, 47),   // Williamson profile: Avg 47
      createPlayer("o5", "RSA", "WK", "RHB", "NONE", 5.2, 105, 44),   // Klaasen/de Kock profile
      createPlayer("o6", "IND", "AR", "RHB", "PACE", 5.4, 112, 33),   // Hardik profile: Finisher SR 112
      createPlayer("o7", "AUS", "AR", "RHB", "SPIN", 5.3, 120, 35),   // Maxwell profile: Finisher SR 120
      createPlayer("o8", "RSA", "BOWL", "RHB", "PACE", 4.9, 50, 16),  // Rabada profile: Econ 4.9, RSA pace
      createPlayer("o9", "AUS", "BOWL", "RHB", "PACE", 5.1, 40, 12),  // Starc profile: Econ 5.1
      createPlayer("o10", "IND", "BOWL", "RHB", "PACE", 4.6, 30, 8),  // Bumrah profile: Econ 4.6
      createPlayer("o11", "AFG", "BOWL", "RHB", "SPIN", 4.4, 25, 7),  // Rashid profile: Econ 4.4
    ];
    strongOdiSquad.forEach((p, idx) => {
      p.stats.format = "ODI";
      p.stats.matches = 120;
      if (idx >= 7 || p.primary_role === "AR") {
        p.stats.bowl_wickets = 160;
        p.stats.bowl_overs = 850;
      }
    });

    const score = calculateDeterministicScore(strongOdiSquad, wanderersOdiChallenge);
    expect(score.role_balance_score).toBeGreaterThanOrEqual(18);
    expect(score.pitch_suitability_score).toBeGreaterThanOrEqual(18);
    expect(score.player_quality_score).toBeGreaterThanOrEqual(25);
    expect(score.deterministic_total).toBeGreaterThanOrEqual(75);
  });
});

