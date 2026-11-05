import { describe, it, expect } from "vitest";
import { findWicketCluster, comparablePhases, phaseRunRate } from "../src/core/phases";
import { computeContributions, matchParRpo } from "../src/core/impact";
import { userInnings, aiInnings } from "./fixtures/gabba";
import { simulateCricketMatch } from "../src/core/simulator";

describe("rule changes", () => {
  it("detects a 5-wicket cluster whether or not the side was all out", () => {
    const fall = [100, 105, 110, 118, 125, 128, 200].map((runs, i) => ({ wicket: i + 1, runs }));
    const c = findWicketCluster("ODI", fall)!;
    expect(c.runs).toBeLessThanOrEqual(30);
    expect(c.fromWicket).toBe(2);
    expect(findWicketCluster("T20", fall)).toBeNull(); // 28 runs is over the T20 limit of 20
    expect(findWicketCluster("ODI", fall.slice(0, 4))).toBeNull();
  });

  it("only compares phases both sides faced at least half of", () => {
    expect(comparablePhases("ODI", { totalBalls: 125 }, { totalBalls: 297 })).toEqual({ powerplay: true, middle: false, death: false });
    expect(comparablePhases("ODI", { totalBalls: 200 }, { totalBalls: 300 }).middle).toBe(true);
    expect(phaseRunRate("ODI", { totalBalls: 60, phaseRuns: { powerplay: 30, middle: 0, death: 0 } }, "powerplay")).toBeCloseTo(3, 5);
  });

  it("par is venue-based and blended with the match's actual rate", () => {
    const flat = matchParRpo("ODI", "HIGH_SCORING_FLAT", [{ totalRuns: 300, totalBalls: 300 }]);
    const green = matchParRpo("ODI", "GREEN_SEAMER", [{ totalRuns: 300, totalBalls: 300 }]);
    expect(flat).toBeGreaterThan(green);
    expect(matchParRpo("ODI", "GREEN_SEAMER", [{ totalRuns: 100, totalBalls: 300 }])).toBeLessThan(green);
  });

  it("batting impact subtracts the full expected runs (a slow 50 is not a good innings)", () => {
    const mk = (runs: number, balls: number) => ({ ...userInnings, batters: [{ playerId: "x", name: "X", runs, balls, fours: 0, sixes: 0, isOut: true }] }) as any;
    const slow = computeContributions({ format: "ODI", userInnings: [mk(50, 120)], aiInnings: [aiInnings], winner: "USER" }).find((c) => c.name === "X")!;
    const fast = computeContributions({ format: "ODI", userInnings: [mk(50, 50)], aiInnings: [aiInnings], winner: "USER" }).find((c) => c.name === "X")!;
    expect(slow.batImpact).toBeLessThan(0);
    expect(fast.batImpact).toBeGreaterThan(slow.batImpact + 20);
  });

  it("a dropped catch costs the fielder in proportion to what the batter went on to make", () => {
    const withDrop = (reprieveRuns: number) =>
      computeContributions({
        format: "ODI", winner: "USER", userInnings: [userInnings],
        aiInnings: [{ ...aiInnings, drops: [{ fielder: "Dropper", fielderId: "dr", batter: "A1", bowler: "B", reprieveRuns }] } as any],
      }).find((c) => c.playerId === "dr")!;
    // aiInnings is AI batting, so the dropper belongs to the USER fielding side
    const small = withDrop(5), big = withDrop(80);
    expect(small.team).toBe("USER");
    expect(big.fieldImpact).toBeLessThan(small.fieldImpact - 40);
  });

  it("simulated drops carry the reprieved runs and the dropper", () => {
    let found = 0;
    const mkP = (id: string, role: any, cat: any): any => ({ id, name: id, country: "IND", batting_hand: "RHB", bowling_category: cat, primary_role: role, bowling_style: "",
      stats: { player_id: id, format: "ODI", matches: 40, bat_innings: 30, bat_runs: 900, bat_average: 35, bat_strike_rate: 88, top_order_innings: 10, middle_order_innings: 10, finisher_innings: 0, bowl_innings: 30, bowl_overs: 8, bowl_wickets: 60, bowl_average: 25, bowl_economy: 5 } });
    const sq = (p: string) => [1, 2, 3, 4, 5].map((i) => mkP(p + i, i === 5 ? "WK" : "BAT", "NONE")).concat([mkP(p + 6, "AR", "PACE"), mkP(p + 7, "AR", "SPIN"), mkP(p + 8, "BOWL", "PACE"), mkP(p + 9, "BOWL", "PACE"), mkP(p + 10, "BOWL", "SPIN"), mkP(p + 11, "BOWL", "SPIN")]);
    for (let seed = 1; seed <= 40; seed++) {
      const r = simulateCricketMatch(sq("u"), sq("a"), { id: "c", title: "t", format: "ODI", venue: { name: "V", country: "IND", pitch_type: "HIGH_SCORING_FLAT" }, narrative_intro: "", constraints: [] } as any, seed);
      for (const inn of [r.userInnings, r.aiInnings]) {
        expect(inn.drops?.length ?? 0).toBe(inn.droppedCatches ?? 0);
        for (const d of inn.drops ?? []) { found++; expect(d.fielderId).toBeTruthy(); expect(d.reprieveRuns).toBeGreaterThanOrEqual(0); }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it("next-time advice always has a concrete line", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const mkP = (id: string, role: any, cat: any): any => ({ id, name: id, country: "IND", batting_hand: "RHB", bowling_category: cat, primary_role: role, bowling_style: "",
        stats: { player_id: id, format: "T20", matches: 40, bat_innings: 30, bat_runs: 900, bat_average: 35, bat_strike_rate: 130, top_order_innings: 10, middle_order_innings: 10, finisher_innings: 0, bowl_innings: 30, bowl_overs: 4, bowl_wickets: 40, bowl_average: 25, bowl_economy: 7.5 } });
      const sq = (p: string) => [1, 2, 3, 4, 5].map((i) => mkP(p + i, i === 5 ? "WK" : "BAT", "NONE")).concat([mkP(p + 6, "AR", "PACE"), mkP(p + 7, "AR", "SPIN"), mkP(p + 8, "BOWL", "PACE"), mkP(p + 9, "BOWL", "PACE"), mkP(p + 10, "BOWL", "SPIN"), mkP(p + 11, "BOWL", "SPIN")]);
      const r = simulateCricketMatch(sq("u"), sq("a"), { id: "c", title: "t", format: "T20", venue: { name: "V", country: "IND", pitch_type: "SLOW_LOW" }, narrative_intro: "", constraints: [] } as any, seed);
      expect(r.selection!.nextTime.length).toBeGreaterThan(0);
      expect(r.selection!.nextTime[0].length).toBeGreaterThan(20);
    }
  });
});
