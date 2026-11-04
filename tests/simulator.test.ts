import { describe, it, expect } from "vitest";
import { simulateCricketMatch } from "../src/core/simulator";
import type { Challenge, PlayerWithStats } from "../src/core/types";

function createMockPlayer(
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

describe("Realistic Cricket Match Simulator", () => {
  const t20Challenge: Challenge = {
    id: "ch_sim_wankhede",
    title: "Wankhede T20 Blast",
    format: "T20",
    venue: { name: "Wankhede Stadium, Mumbai", country: "IND", pitch_type: "HIGH_SCORING_FLAT" },
    narrative_intro: "True bounce and rapid outfield.",
    constraints: [],
  };

  const userSquad: (PlayerWithStats | null)[] = [
    createMockPlayer("u1", "IND", "BAT", "RHB", "NONE", 8, 145, 40),
    createMockPlayer("u2", "AUS", "BAT", "LHB", "NONE", 8, 140, 36),
    createMockPlayer("u3", "IND", "BAT", "RHB", "NONE", 8, 138, 48),
    createMockPlayer("u4", "RSA", "BAT", "RHB", "NONE", 8, 135, 34),
    createMockPlayer("u5", "ENG", "WK", "RHB", "NONE", 8, 142, 38),
    createMockPlayer("u6", "IND", "AR", "RHB", "PACE", 7.5, 155, 31),
    createMockPlayer("u7", "AUS", "AR", "RHB", "SPIN", 7.6, 150, 28),
    createMockPlayer("u8", "PAK", "BOWL", "RHB", "PACE", 7.2, 110, 15),
    createMockPlayer("u9", "IND", "BOWL", "RHB", "PACE", 6.8, 90, 8),
    createMockPlayer("u10", "RSA", "BOWL", "RHB", "PACE", 7.4, 85, 7),
    createMockPlayer("u11", "AFG", "BOWL", "RHB", "SPIN", 6.7, 80, 6),
  ];

  const aiSquad: (PlayerWithStats | null)[] = [
    createMockPlayer("a1", "ENG", "BAT", "LHB", "NONE", 8, 142, 38),
    createMockPlayer("a2", "IND", "BAT", "RHB", "NONE", 8, 138, 35),
    createMockPlayer("a3", "NZL", "BAT", "RHB", "NONE", 8, 130, 44),
    createMockPlayer("a4", "AUS", "BAT", "LHB", "NONE", 8, 136, 33),
    createMockPlayer("a5", "RSA", "WK", "RHB", "NONE", 8, 134, 30),
    createMockPlayer("a6", "WI", "AR", "RHB", "PACE", 7.8, 148, 26),
    createMockPlayer("a7", "BAN", "AR", "LHB", "SPIN", 7.2, 125, 24),
    createMockPlayer("a8", "AUS", "BOWL", "RHB", "PACE", 7.5, 100, 12),
    createMockPlayer("a9", "ENG", "BOWL", "RHB", "PACE", 7.3, 90, 10),
    createMockPlayer("a10", "IND", "BOWL", "RHB", "SPIN", 7.1, 80, 7),
    createMockPlayer("a11", "PAK", "BOWL", "RHB", "PACE", 7.6, 75, 5),
  ];

  it("simulates a complete T20 match with realistic team scores and player performances", () => {
    const result = simulateCricketMatch(userSquad, aiSquad, t20Challenge, 12345);

    expect(result.format).toBe("T20");
    expect(["USER", "AI", "TIE"]).toContain(result.winner);
    expect(result.userInnings.totalRuns).toBeGreaterThan(100);
    expect(result.aiInnings.totalRuns).toBeGreaterThan(100);
    expect(result.summary).toBeDefined();
    expect(result.playerOfTheMatch.name).toBeDefined();
    expect(result.decisiveDifference).toBeDefined();
  });
});

