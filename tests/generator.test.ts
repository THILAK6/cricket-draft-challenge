import { describe, it, expect } from "vitest";
import { ChallengeSchema } from "../src/core/types";
import { checkChallengeFeasibility } from "../src/core/validator";
import type { PlayerWithStats } from "../src/core/types";

function createMockPlayer(
  id: string,
  country: string,
  role: "BAT" | "WK" | "AR" | "BOWL",
  hand: "LHB" | "RHB" = "RHB",
  bowlingCat: "NONE" | "PACE" | "SPIN" = "NONE"
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
      matches: 30,
      bat_innings: 25,
      bat_runs: 600,
      bat_average: 28.0,
      bat_strike_rate: 135.0,
      top_order_innings: role === "BAT" ? 15 : 0,
      middle_order_innings: 10,
      finisher_innings: 0,
      bowl_innings: role === "BOWL" || role === "AR" ? 25 : 0,
      bowl_overs: role === "BOWL" || role === "AR" ? 4.0 : 0,
      bowl_wickets: role === "BOWL" || role === "AR" ? 30 : 0,
      bowl_average: 24.0,
      bowl_economy: 7.8,
    },
  };
}

describe("Challenge Generator & Validation Loop", () => {
  it("validates that generated challenges conform to ChallengeSchema", () => {
    const rawChallenge = {
      id: "ch_test_123",
      title: "Monsoon Trial",
      format: "T20",
      venue: {
        name: "Eden Gardens, Kolkata",
        country: "IND",
        pitch_type: "DUSTBOWL",
      },
      narrative_intro: "A turning pitch under muggy conditions.",
      constraints: [
        { type: "max_per_country", value: 2, exceptions: { IND: 3 } },
        { type: "min_category", category: "SPIN", count: 2 },
      ],
    };

    const parsed = ChallengeSchema.parse(rawChallenge);
    expect(parsed.title).toBe("Monsoon Trial");
    expect(parsed.constraints).toHaveLength(2);
  });

  it("verifies feasibility against a balanced candidate pool", () => {
    const pool: PlayerWithStats[] = [];
    const countries = ["IND", "AUS", "ENG", "RSA", "NZL", "PAK", "WI", "SL", "BAN", "AFG"];
    for (const c of countries) {
      pool.push(createMockPlayer(`${c}_wk`, c, "WK", "RHB", "NONE"));
      pool.push(createMockPlayer(`${c}_bat1`, c, "BAT", "LHB", "NONE"));
      pool.push(createMockPlayer(`${c}_bat2`, c, "BAT", "RHB", "NONE"));
      pool.push(createMockPlayer(`${c}_bowl1`, c, "BOWL", "RHB", "PACE"));
      pool.push(createMockPlayer(`${c}_bowl2`, c, "BOWL", "RHB", "SPIN"));
    }

    const testChallenge = {
      id: "ch_check_feasible",
      title: "Chepauk Dustbowl Trial",
      format: "T20" as const,
      venue: {
        name: "MA Chidambaram Stadium",
        country: "IND",
        pitch_type: "DUSTBOWL" as const,
      },
      narrative_intro: "A spin challenge.",
      constraints: [
        { type: "max_per_country" as const, value: 2 },
        { type: "min_category" as const, category: "SPIN" as const, count: 2 },
      ],
    };

    const result = checkChallengeFeasibility(pool, testChallenge, 50);
    expect(result.isFeasible).toBe(true);
    expect(result.validCombinationsFound).toBeGreaterThanOrEqual(50);
  });
});
