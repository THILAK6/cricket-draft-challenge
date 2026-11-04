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
});
