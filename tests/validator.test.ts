import { describe, it, expect } from "vitest";
import { validateSquad, checkChallengeFeasibility, canPickPlayer } from "../src/core/validator";
import type { Challenge, PlayerWithStats } from "../src/core/types";

// Helper to generate mock players
function createMockPlayer(
  id: string,
  country: string,
  role: "BAT" | "WK" | "AR" | "BOWL",
  hand: "LHB" | "RHB" = "RHB",
  bowlingCat: "NONE" | "PACE" | "SPIN" = "NONE",
  econ = 8.0,
  sr = 130.0
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
      matches: 25,
      bat_innings: 20,
      bat_runs: 500,
      bat_average: 30.0,
      bat_strike_rate: sr,
      top_order_innings: role === "BAT" ? 15 : 0,
      middle_order_innings: 5,
      finisher_innings: 0,
      bowl_innings: role === "BOWL" || role === "AR" ? 20 : 0,
      bowl_overs: role === "BOWL" || role === "AR" ? 4.0 : 0,
      bowl_wickets: role === "BOWL" || role === "AR" ? 25 : 0,
      bowl_average: 22.0,
      bowl_economy: econ,
    },
  };
}

describe("Constraint Validator - Squad Level", () => {
  const baseChallenge: Challenge = {
    id: "test-c1",
    title: "Test Challenge",
    format: "T20",
    venue: {
      name: "Eden Gardens",
      country: "IND",
      pitch_type: "DUSTBOWL",
    },
    narrative_intro: "A classic spin trial.",
    constraints: [
      {
        type: "max_per_country",
        value: 1,
        exceptions: { BAN: 2 },
      },
      {
        type: "min_category",
        category: "SPIN",
        count: 2,
      },
    ],
  };

  it("validates a legal squad that satisfies all base and dynamic constraints", () => {
    const squad: PlayerWithStats[] = [
      createMockPlayer("p1", "IND", "BAT", "RHB", "NONE"),
      createMockPlayer("p2", "AUS", "BAT", "LHB", "NONE"),
      createMockPlayer("p3", "ENG", "BAT", "RHB", "NONE"),
      createMockPlayer("p4", "RSA", "BAT", "RHB", "NONE"),
      createMockPlayer("p5", "NZL", "WK", "RHB", "NONE"),
      createMockPlayer("p6", "BAN", "AR", "LHB", "SPIN"), // Ban 1
      createMockPlayer("p7", "BAN", "AR", "RHB", "SPIN"), // Ban 2 (allowed via exception)
      createMockPlayer("p8", "PAK", "BOWL", "RHB", "PACE"),
      createMockPlayer("p9", "WI", "BOWL", "RHB", "PACE"),
      createMockPlayer("p10", "SL", "BOWL", "RHB", "SPIN"), // Spin 3
      createMockPlayer("p11", "AFG", "BOWL", "RHB", "PACE"),
    ];

    const result = validateSquad(squad, baseChallenge);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails if squad has no wicketkeeper", () => {
    const squad: PlayerWithStats[] = [
      createMockPlayer("p1", "IND", "BAT"),
      createMockPlayer("p2", "AUS", "BAT"),
      createMockPlayer("p3", "ENG", "BAT"),
      createMockPlayer("p4", "RSA", "BAT"),
      createMockPlayer("p5", "NZL", "BAT"), // No WK!
      createMockPlayer("p6", "BAN", "AR", "LHB", "SPIN"),
      createMockPlayer("p7", "BAN", "AR", "RHB", "SPIN"),
      createMockPlayer("p8", "PAK", "BOWL", "RHB", "PACE"),
      createMockPlayer("p9", "WI", "BOWL", "RHB", "PACE"),
      createMockPlayer("p10", "SL", "BOWL", "RHB", "SPIN"),
      createMockPlayer("p11", "AFG", "BOWL", "RHB", "PACE"),
    ];

    const result = validateSquad(squad, baseChallenge);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("Squad must have at least 1 designated wicketkeeper.");
  });

  it("fails if squad exceeds country limits without exception", () => {
    const squad: PlayerWithStats[] = [
      createMockPlayer("p1", "AUS", "BAT"),
      createMockPlayer("p2", "AUS", "BAT"), // 2 from AUS (max is 1)
      createMockPlayer("p3", "ENG", "BAT"),
      createMockPlayer("p4", "RSA", "BAT"),
      createMockPlayer("p5", "NZL", "WK"),
      createMockPlayer("p6", "BAN", "AR", "LHB", "SPIN"),
      createMockPlayer("p7", "IND", "AR", "RHB", "SPIN"),
      createMockPlayer("p8", "PAK", "BOWL", "RHB", "PACE"),
      createMockPlayer("p9", "WI", "BOWL", "RHB", "PACE"),
      createMockPlayer("p10", "SL", "BOWL", "RHB", "SPIN"),
      createMockPlayer("p11", "AFG", "BOWL", "RHB", "PACE"),
    ];

    const result = validateSquad(squad, baseChallenge);
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatch(/Exceeded maximum players for AUS: allowed 1, found 2/);
  });

  it("validates batting_hand_order constraint", () => {
    const lhbChallenge: Challenge = {
      ...baseChallenge,
      constraints: [
        {
          type: "batting_hand_order",
          positions: [1, 2, 3, 4],
          hand: "LHB",
        },
      ],
    };

    // Squad with only 2 LHBs
    const squad: PlayerWithStats[] = [
      createMockPlayer("p1", "IND", "BAT", "LHB"),
      createMockPlayer("p2", "AUS", "BAT", "LHB"),
      createMockPlayer("p3", "ENG", "BAT", "RHB"),
      createMockPlayer("p4", "RSA", "BAT", "RHB"),
      createMockPlayer("p5", "NZL", "WK", "RHB"),
      createMockPlayer("p6", "BAN", "AR", "RHB", "PACE"),
      createMockPlayer("p7", "PAK", "AR", "RHB", "PACE"),
      createMockPlayer("p8", "WI", "BOWL", "RHB", "PACE"),
      createMockPlayer("p9", "SL", "BOWL", "RHB", "PACE"),
      createMockPlayer("p10", "AFG", "BOWL", "RHB", "PACE"),
      createMockPlayer("p11", "ZIM", "BOWL", "RHB", "PACE"),
    ];

    const result = validateSquad(squad, lhbChallenge);
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatch(/Requires at least 4 LHB batters/);
  });
});

describe("Constraint Validator - Feasibility Solver", () => {
  it("confirms feasibility when pool has abundant valid combinations", () => {
    // Generate pool of 20 players across countries and roles
    const pool: PlayerWithStats[] = [];
    const countries = ["IND", "AUS", "ENG", "RSA", "NZL", "PAK", "WI", "SL", "BAN", "AFG", "ZIM", "IRE"];

    for (let i = 0; i < countries.length; i++) {
      const c = countries[i];
      // 1 WK
      pool.push(createMockPlayer(`${c}_wk`, c, "WK", "RHB", "NONE"));
      // 2 Batters
      pool.push(createMockPlayer(`${c}_bat1`, c, "BAT", "LHB", "NONE"));
      pool.push(createMockPlayer(`${c}_bat2`, c, "BAT", "RHB", "NONE"));
      // 2 Bowlers
      pool.push(createMockPlayer(`${c}_bowl1`, c, "BOWL", "RHB", "PACE"));
      pool.push(createMockPlayer(`${c}_bowl2`, c, "BOWL", "RHB", "SPIN"));
    }

    const challenge: Challenge = {
      id: "c-feasi-1",
      title: "Solvable Challenge",
      format: "T20",
      venue: { name: "Lord's", country: "ENG", pitch_type: "GREEN_SEAMER" },
      narrative_intro: "Balanced test",
      constraints: [
        { type: "max_per_country", value: 1 },
        { type: "min_category", category: "PACE", count: 3 },
      ],
    };

    const result = checkChallengeFeasibility(pool, challenge, 50);
    expect(result.isFeasible).toBe(true);
    expect(result.validCombinationsFound).toBeGreaterThanOrEqual(50);
    expect(result.sampleSquad).toBeDefined();
    expect(result.sampleSquad).toHaveLength(11);
  });

  it("detects impossible challenge immediately via pigeonhole pruning (0 keepers)", () => {
    const pool = [
      createMockPlayer("p1", "IND", "BAT"),
      createMockPlayer("p2", "AUS", "BAT"),
      createMockPlayer("p3", "ENG", "BAT"),
      createMockPlayer("p4", "PAK", "BOWL", "RHB", "PACE"),
      createMockPlayer("p5", "NZL", "BOWL", "RHB", "PACE"),
      createMockPlayer("p6", "WI", "BOWL", "RHB", "PACE"),
      createMockPlayer("p7", "RSA", "BOWL", "RHB", "PACE"),
      createMockPlayer("p8", "SL", "BOWL", "RHB", "PACE"),
      createMockPlayer("p9", "BAN", "BOWL", "RHB", "PACE"),
      createMockPlayer("p10", "AFG", "BOWL", "RHB", "PACE"),
      createMockPlayer("p11", "ZIM", "BOWL", "RHB", "PACE"),
    ];

    const challenge: Challenge = {
      id: "c-impossible",
      title: "No Keepers",
      format: "T20",
      venue: { name: "Wankhede", country: "IND", pitch_type: "HIGH_SCORING_FLAT" },
      narrative_intro: "Impossible test",
      constraints: [],
    };

    const result = checkChallengeFeasibility(pool, challenge);
    expect(result.isFeasible).toBe(false);
    expect(result.reasons[0]).toContain("No wicketkeepers available in the pool");
  });

  it("detects impossible challenge when country caps cannot sum to 11", () => {
    // Only 5 countries available, max 1 each => max 5 players, impossible to get 11
    const pool: PlayerWithStats[] = [];
    const countries = ["IND", "AUS", "ENG", "PAK", "RSA"];
    for (const c of countries) {
      pool.push(createMockPlayer(`${c}_wk`, c, "WK"));
      pool.push(createMockPlayer(`${c}_bowl`, c, "BOWL", "RHB", "PACE"));
      pool.push(createMockPlayer(`${c}_bat`, c, "BAT"));
    }

    const challenge: Challenge = {
      id: "c-cap-fail",
      title: "Cap impossible",
      format: "T20",
      venue: { name: "Melbourne", country: "AUS", pitch_type: "HIGH_SCORING_FLAT" },
      narrative_intro: "Testing pigeonhole",
      constraints: [{ type: "max_per_country", value: 1 }],
    };

    const result = checkChallengeFeasibility(pool, challenge);
    expect(result.isFeasible).toBe(false);
    expect(result.reasons[0]).toContain("Country constraints make 11-player squad impossible");
  });
});

describe("Constraint Validator - Proactive In-Draft Checks (canPickPlayer)", () => {
  const challenge: Challenge = {
    id: "c-proactive",
    title: "Proactive Test",
    format: "T20",
    venue: { name: "Lord's", country: "ENG", pitch_type: "GREEN_SEAMER" },
    narrative_intro: "Testing proactive constraints",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { IND: 3 } },
      { type: "min_category", category: "SPIN", count: 2 },
      { type: "batting_hand_order", positions: [1, 2], hand: "LHB" },
    ],
  };

  it("blocks pick when country cap is reached", () => {
    const squad: PlayerWithStats[] = [
      createMockPlayer("p1", "AUS", "BAT", "LHB"),
      createMockPlayer("p2", "AUS", "BAT", "LHB"),
    ];

    const thirdAus = createMockPlayer("p3", "AUS", "BOWL", "RHB", "PACE");
    const result = canPickPlayer(thirdAus, squad, challenge);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Country cap reached for AUS (Max 2)");
  });

  it("respects country cap exceptions", () => {
    const squad: PlayerWithStats[] = [
      createMockPlayer("p1", "IND", "BAT", "LHB"),
      createMockPlayer("p2", "IND", "BAT", "LHB"),
    ];

    // IND allows up to 3 via exception
    const thirdInd = createMockPlayer("p3", "IND", "BOWL", "RHB", "PACE");
    const result = canPickPlayer(thirdInd, squad, challenge);

    expect(result.allowed).toBe(true);
  });

  it("blocks non-LHB for positions specified in batting_hand_order", () => {
    // Current squad is empty, so pick 1 is slot 1
    const rhbBatter = createMockPlayer("p1", "ENG", "BAT", "RHB");
    const result = canPickPlayer(rhbBatter, [], challenge);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Slot 1 requires a LHB batter");

    const lhbBatter = createMockPlayer("p1", "ENG", "BAT", "LHB");
    expect(canPickPlayer(lhbBatter, [], challenge).allowed).toBe(true);
  });

  it("blocks non-WK on final pick if 0 WKs currently drafted", () => {
    // 10 players drafted, 0 WKs
    const squad: PlayerWithStats[] = [];
    for (let i = 1; i <= 10; i++) {
      squad.push(createMockPlayer(`p${i}`, `C${i}`, i <= 5 ? "BOWL" : "BAT", "RHB", i <= 2 ? "SPIN" : "PACE"));
    }

    const batter = createMockPlayer("p11", "ENG", "BAT", "RHB");
    const keeper = createMockPlayer("p11_wk", "ENG", "WK", "RHB");

    const batterResult = canPickPlayer(batter, squad, challenge);
    expect(batterResult.allowed).toBe(false);
    expect(batterResult.reason).toContain("Must pick a Wicketkeeper for remaining slot");

    const keeperResult = canPickPlayer(keeper, squad, challenge);
    expect(keeperResult.allowed).toBe(true);
  });

  it("blocks non-bowlers when remaining slots must all be bowlers to satisfy 5 bowling options", () => {
    // 8 players drafted, only 2 bowlers (needs 3 more, exactly 3 slots remaining: picks 9, 10, 11)
    const squad: PlayerWithStats[] = [
      createMockPlayer("p1", "C1", "BAT", "LHB"),
      createMockPlayer("p2", "C2", "BAT", "LHB"),
      createMockPlayer("p3", "C3", "BAT", "RHB"),
      createMockPlayer("p4", "C4", "BAT", "RHB"),
      createMockPlayer("p5", "C5", "BAT", "RHB"),
      createMockPlayer("p6", "C6", "WK", "RHB"),
      createMockPlayer("p7", "C7", "BOWL", "RHB", "SPIN"),
      createMockPlayer("p8", "C8", "BOWL", "RHB", "SPIN"),
    ];

    const nonBowler = createMockPlayer("p9_bat", "C9", "BAT", "RHB");
    const bowler = createMockPlayer("p9_bowl", "C9", "BOWL", "RHB", "PACE");

    const nonBowlerResult = canPickPlayer(nonBowler, squad, challenge);
    expect(nonBowlerResult.allowed).toBe(false);
    expect(nonBowlerResult.reason).toContain("Must pick a bowler");

    const bowlerResult = canPickPlayer(bowler, squad, challenge);
    expect(bowlerResult.allowed).toBe(true);
  });
});

