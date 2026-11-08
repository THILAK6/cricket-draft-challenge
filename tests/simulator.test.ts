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
      bowl_overs: role === "BOWL" || role === "AR" ? 140 : 0, // 35 innings of 4 overs (career total)
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
    for (const seed of [12345, 99999, 45678, 88812, 34211]) {
      const result = simulateCricketMatch(userSquad, aiSquad, t20Challenge, seed);

      expect(result.format).toBe("T20");
      expect(["USER", "AI", "TIE"]).toContain(result.winner);
      // Realistic T20 score bounds: must never exceed 265 runs (definitely never 300+)
      expect(result.userInnings.totalRuns).toBeGreaterThanOrEqual(90);
      expect(result.userInnings.totalRuns).toBeLessThan(265);
      expect(result.aiInnings.totalRuns).toBeGreaterThanOrEqual(90);
      expect(result.aiInnings.totalRuns).toBeLessThan(265);

      expect(result.summary).toBeDefined();
      expect(result.playerOfTheMatch.name).toBeDefined();
      expect(result.decisiveDifference).toBeDefined();

      // If defending team won, narrative must NOT say "paced the chase"
      if (result.summary.includes("won by") && result.summary.includes("run")) {
        expect(result.decisiveDifference).not.toContain("paced");
        expect(result.decisiveDifference).not.toContain("crossing the line");
      }
    }
  });

  it("simulates a multi-innings Test match with toss and lead dynamics", () => {
    const testChallenge: Challenge = {
      id: "ch_sim_lords",
      title: "Lord's Seam Battle",
      format: "TEST",
      venue: { name: "Lord's Cricket Ground, London", country: "ENG", pitch_type: "GREEN_SEAMER" },
      narrative_intro: "Overcast skies with lateral seam movement.",
      constraints: [],
    };

    const result = simulateCricketMatch(userSquad, aiSquad, testChallenge, 54321);

    expect(result.format).toBe("TEST");
    expect(["USER", "AI", "DRAW"]).toContain(result.winner);
    expect(result.toss).toBeDefined();
    expect(result.userInnings).toBeDefined();
    expect(result.aiInnings).toBeDefined();
    expect(result.userSecondInnings).toBeDefined();
    expect(result.aiSecondInnings).toBeDefined();
    expect(result.leadFirstInnings).toBeDefined();
    expect(result.keyMoments.length).toBeGreaterThan(0);
    expect(result.dayChronicle).toBeDefined();
    expect(result.dayChronicle!.length).toBeGreaterThanOrEqual(4);
    expect(result.dayChronicle![0].day).toBe(1);
    expect(result.dayChronicle![0].pitchBehavior).toBeDefined();
  });

  it("simulates an ODI match with accurate overs notation, dynamic player quotes, and no canned phrases", () => {
    const odiChallenge: Challenge = {
      id: "ch_sim_mcg",
      title: "MCG ODI Classic",
      format: "ODI",
      venue: { name: "Melbourne Cricket Ground", country: "AUS", pitch_type: "HIGH_SCORING_FLAT" },
      narrative_intro: "50-over battle under the lights.",
      constraints: [],
    };

    // Run across multiple seeds to verify formatting consistency
    for (const seed of [101, 202, 303, 404, 505]) {
      const result = simulateCricketMatch(userSquad, aiSquad, odiChallenge, seed);

      expect(result.format).toBe("ODI");
      // Never say "0.0 ov remaining"
      expect(result.summary).not.toContain("0.0 ov remaining");
      expect(result.summary).not.toContain("0.0 ov");

      // Scorecards must have valid oversString
      expect(result.userInnings.oversString).toMatch(/^\d+\.\d$/);
      expect(result.aiInnings.oversString).toMatch(/^\d+\.\d$/);

      // Must never have hardcoded T20 phrases
      expect(result.decisiveDifference).not.toContain("sub-7.8");
      expect(result.whyWinnerWon.join(" ")).not.toContain("sub-7.8");
      expect(result.whyLoserLost.join(" ")).not.toContain("sub-7.8");
    }
  });

  it("strictly prohibits pure batters and keepers from bowling when 5 specialist bowlers are present", () => {
    const odiChallenge: Challenge = {
      id: "ch_sim_ahmedabad",
      title: "Ahmedabad ODI Duel",
      format: "ODI",
      venue: { name: "Narendra Modi Stadium, Ahmedabad", country: "IND", pitch_type: "HIGH_SCORING_FLAT" },
      narrative_intro: "50-over match.",
      constraints: [],
    };

    const result = simulateCricketMatch(userSquad, aiSquad, odiChallenge, 777);

    // userSquad has 6 genuine bowlers: u6 (AR), u7 (AR), u8 (BOWL), u9 (BOWL), u10 (BOWL), u11 (BOWL)
    // Pure batters: u1, u2, u3, u4 and WK u5 must NOT bowl against AI XI!
    const bowlerIdsWhoBowled = result.aiInnings.bowlers.map((b) => b.playerId);
    expect(bowlerIdsWhoBowled).not.toContain("u1");
    expect(bowlerIdsWhoBowled).not.toContain("u2");
    expect(bowlerIdsWhoBowled).not.toContain("u3");
    expect(bowlerIdsWhoBowled).not.toContain("u4");
    expect(bowlerIdsWhoBowled).not.toContain("u5");
  });

  it("never lets a bowler exceed the per-format over limit, even with only three frontline bowlers", () => {
    // 3 frontline bowlers only: part-timers and other non-keepers must fill the remaining overs.
    const thin = (prefix: string): (PlayerWithStats | null)[] => [
      createMockPlayer(`${prefix}1`, "IND", "BAT", "RHB", "PACE", 8, 140, 40),
      createMockPlayer(`${prefix}2`, "AUS", "BAT", "LHB", "SPIN", 8, 140, 36),
      createMockPlayer(`${prefix}3`, "ENG", "BAT", "RHB", "NONE", 8, 138, 40),
      createMockPlayer(`${prefix}4`, "RSA", "BAT", "RHB", "NONE", 8, 135, 34),
      createMockPlayer(`${prefix}5`, "NZL", "WK", "RHB", "NONE", 8, 142, 38),
      createMockPlayer(`${prefix}6`, "IND", "AR", "RHB", "PACE", 7.5, 150, 31),
      createMockPlayer(`${prefix}7`, "PAK", "BAT", "RHB", "NONE", 8, 130, 28),
      createMockPlayer(`${prefix}8`, "SL", "BAT", "RHB", "NONE", 8, 130, 25),
      createMockPlayer(`${prefix}9`, "PAK", "BOWL", "RHB", "PACE", 7.2, 110, 15),
      createMockPlayer(`${prefix}10`, "IND", "BOWL", "RHB", "PACE", 6.8, 90, 8),
      createMockPlayer(`${prefix}11`, "AFG", "BOWL", "RHB", "SPIN", 6.7, 80, 6),
    ];
    for (const [format, quota] of [["T20", 4], ["ODI", 10]] as const) {
      const ch: Challenge = { ...t20Challenge, format };
      for (let seed = 1; seed <= 25; seed++) {
        const r = simulateCricketMatch(thin("x"), thin("y"), ch, seed);
        for (const inn of [r.userInnings, r.aiInnings]) {
          for (const b of inn.bowlers) {
            const [o, balls] = b.overs.split(".").map(Number);
            expect(o + balls / 6).toBeLessThanOrEqual(quota);
          }
        }
      }
    }
  });

  it("settles level T20 scores with a super over and always names a winner or a tie", () => {
    let superOvers = 0;
    for (let seed = 1; seed <= 4000 && superOvers < 3; seed++) {
      const r = simulateCricketMatch(userSquad, aiSquad, t20Challenge, seed);
      if (r.superOver) {
        superOvers++;
        expect(r.userInnings.totalRuns).toBe(r.aiInnings.totalRuns);
        expect(["USER", "AI", "TIE"]).toContain(r.winner);
        expect(r.superOver.rounds.length).toBeGreaterThan(0);
        expect(r.superOver.rounds.length).toBeLessThanOrEqual(3);
        expect(r.summary).toContain("Super Over");
        if (r.superOver.decidedBy === "RUNS") expect(r.winner).toBe(r.superOver.winner);
      } else {
        expect(r.winner).not.toBe("TIE");
      }
    }
    expect(superOvers).toBeGreaterThan(0);
  });

  it("does not use a super over for ODIs", () => {
    const ch: Challenge = { ...t20Challenge, format: "ODI" };
    for (let seed = 1; seed <= 300; seed++) {
      expect(simulateCricketMatch(userSquad, aiSquad, ch, seed).superOver).toBeUndefined();
    }
  });

  it("reports batting, bowling and fielding scores that match the scorecards", () => {
    for (const format of ["T20", "ODI", "TEST"] as const) {
      const ch: Challenge = { ...t20Challenge, format };
      for (let seed = 1; seed <= 15; seed++) {
        const r = simulateCricketMatch(userSquad, aiSquad, ch, seed);
        for (const side of ["USER", "AI"] as const) {
          const t = r.performance[side];
          for (const v of [t.battingScore, t.bowlingScore, t.fieldingScore, t.overallScore]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(100);
          }
        }
        const innings = [r.userInnings, r.aiInnings, r.userSecondInnings, r.aiSecondInnings].filter(Boolean) as NonNullable<typeof r.userInnings>[];
        const dismissals = innings.reduce((n, i) => n + i.batters.filter((b) => b.isOut).length, 0);
        const bowlerWickets = r.performance.USER.stats.wicketsTaken + r.performance.AI.stats.wicketsTaken;
        const runOuts = r.performance.USER.stats.runOuts + r.performance.AI.stats.runOuts;
        // Every dismissal is either a bowler's wicket or a run out
        expect(bowlerWickets + runOuts).toBe(dismissals);
        expect(r.performance.USER.stats.runs).toBe(
          r.userInnings.totalRuns + (r.userSecondInnings?.totalRuns ?? 0)
        );
      }
    }
  });

  it("describes each dismissal and credits the right fielder", () => {
    const r = simulateCricketMatch(userSquad, aiSquad, t20Challenge, 7);
    const outs = [...r.userInnings.batters, ...r.aiInnings.batters].filter((b) => b.isOut);
    expect(outs.length).toBeGreaterThan(0);
    for (const b of outs) expect(b.dismissal).toMatch(/^(b |lbw b |c & b |c .+ b |st .+ b |run out)/);
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const m = simulateCricketMatch(userSquad, aiSquad, t20Challenge, seed);
      [...m.userInnings.batters, ...m.aiInnings.batters].filter((b) => b.isOut).forEach((b) => kinds.add(b.dismissal!.split(" ")[0]));
    }
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });

  it("returns a selection report that explains the result in terms of the picks", () => {
    for (const seed of [11, 222, 3333, 44444]) {
      const r = simulateCricketMatch(userSquad, aiSquad, t20Challenge, seed);
      const sel = r.selection;
      expect(sel).toBeDefined();
      expect(sel.headline.length).toBeGreaterThan(10);
      expect(sel.categories).toHaveLength(4);
      for (const c of sel.categories) {
        expect(c.user).toBeGreaterThanOrEqual(0);
        expect(c.user).toBeLessThanOrEqual(c.max);
        expect(c.ai).toBeGreaterThanOrEqual(0);
        expect(c.ai).toBeLessThanOrEqual(c.max);
      }
      expect(sel.totals.USER).toBe(sel.categories.reduce((a, c) => a + c.user, 0));
      expect(sel.totals.AI).toBe(sel.categories.reduce((a, c) => a + c.ai, 0));
      expect(["PICKS_DECIDED", "UPSET", "CLOSE", "LEVEL"]).toContain(sel.outcome);
      expect(Array.isArray(sel.nextTime)).toBe(true);
      for (const p of [...sel.userPoints, ...sel.aiPoints]) {
        expect(["good", "bad"]).toContain(p.tone);
        expect(p.text.length).toBeGreaterThan(0);
      }
    }
  });
});
