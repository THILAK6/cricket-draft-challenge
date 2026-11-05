import { describe, it, expect } from "vitest";
import { buildSelectionReport } from "../src/core/selection-report";
import { computeMatchPerformance } from "../src/core/performance";
import type { InningsScorecard } from "../src/core/simulator";
import type { Challenge, PlayerWithStats } from "../src/core/types";

function player(id: string, role: "BAT" | "WK" | "AR" | "BOWL", cat: "NONE" | "PACE" | "SPIN" = "NONE", econ = 8, sr = 135, avg = 32): PlayerWithStats {
  return {
    id, name: `P ${id}`, country: "IND", batting_hand: "RHB", bowling_category: cat, primary_role: role,
    stats: { player_id: id, format: "T20", matches: 40, bat_innings: 35, bat_runs: 1000, bat_average: avg, bat_strike_rate: sr,
      top_order_innings: 20, middle_order_innings: 10, finisher_innings: 3, bowl_innings: cat === "NONE" ? 0 : 30,
      bowl_overs: cat === "NONE" ? 0 : 4, bowl_wickets: cat === "NONE" ? 0 : 40, bowl_average: 22, bowl_economy: cat === "NONE" ? 0 : econ },
  };
}
const squad = (prefix: string) => [
  player(prefix + "1", "BAT"), player(prefix + "2", "BAT"), player(prefix + "3", "BAT"), player(prefix + "4", "WK"),
  player(prefix + "5", "AR", "PACE"), player(prefix + "6", "AR", "SPIN"), player(prefix + "7", "BOWL", "PACE"),
  player(prefix + "8", "BOWL", "PACE"), player(prefix + "9", "BOWL", "SPIN"), player(prefix + "10", "BOWL", "PACE"), player(prefix + "11", "BOWL", "SPIN"),
];
const ch: Challenge = { id: "c", title: "t", format: "T20", venue: { name: "Wankhede", country: "IND", pitch_type: "HIGH_SCORING_FLAT" }, narrative_intro: "", constraints: [] };

function inn(batters: [string, number, number][], bowlers: [string, string, number, number][], phase = { powerplay: 50, middle: 80, death: 30 }): InningsScorecard {
  const runs = batters.reduce((n, b) => n + b[1], 0);
  return {
    teamName: "x", totalRuns: runs, totalWickets: 5, totalBalls: 120, oversString: "20.0", oversCompleted: 20, maxOvers: 20,
    batters: batters.map(([id, r, b]) => ({ playerId: id, name: `P ${id}`, country: "IND", runs: r, balls: b, fours: 0, sixes: 0, isOut: true, strikeRate: 0 })),
    bowlers: bowlers.map(([id, ov, r, w]) => ({ playerId: id, name: `P ${id}`, country: "IND", overs: ov, maidens: 0, runs: r, wickets: w, economy: 0 })),
    phaseRuns: phase,
  };
}

describe("selection report accuracy", () => {
  const u = squad("u"), a = squad("a");

  it("names the genuinely expensive bowler as weakest, not the most economical one", () => {
    const userBat = inn([["u1", 40, 30], ["u2", 30, 25], ["u3", 20, 15], ["u5", 6, 6]], [["u7", "4.0", 38, 0], ["u5", "3.0", 36, 0]]);
    const aiBat = inn([["a1", 50, 30]], [["a7", "4.0", 20, 2]]);
    // user bowled in aiBat: Arshdeep-like u7 4-0-38-0 and Hardik-like u5 3-0-36-0
    const aiInnings = inn([["a1", 80, 40], ["a2", 60, 40]], [], { powerplay: 59, middle: 90, death: 60 });
    aiInnings.bowlers = [];
    const userInnings = inn([["u1", 40, 30], ["u5", 6, 6]], [["a7", "4.0", 20, 2]], { powerplay: 57, middle: 88, death: 35 });
    const bowlingVsAi = inn([["a1", 80, 40], ["a2", 60, 40]], [["a7", "4.0", 20, 2]], { powerplay: 59, middle: 93, death: 60 });
    // bowlers attached to the innings that *they* bowled in: user's bowlers are listed on the AI's batting innings
    bowlingVsAi.bowlers = [
      { playerId: "u7", name: "P u7", country: "IND", overs: "4.0", maidens: 0, runs: 38, wickets: 0, economy: 9.5 },
      { playerId: "u5", name: "P u5", country: "IND", overs: "3.0", maidens: 0, runs: 36, wickets: 0, economy: 12 },
    ];
    const perf = computeMatchPerformance("T20", [userInnings], [bowlingVsAi]);
    const rep = buildSelectionReport({ userSquad: u, aiSquad: a, challenge: ch, winner: "AI", userInnings: [userInnings], aiInnings: [bowlingVsAi], performance: perf });
    expect(rep.weakestPick?.name).toBe("P u5");
    expect(userBat.totalRuns + aiBat.totalRuns).toBeGreaterThan(0);
  });

  it("describes flat-pitch fit through hitters and economical bowlers, not a seam/spin split", () => {
    const rep = buildSelectionReport({ userSquad: u, aiSquad: a, challenge: ch, winner: "USER", userInnings: [inn([["u1", 50, 30]], [])], aiInnings: [inn([["a1", 20, 30]], [])], performance: computeMatchPerformance("T20", [inn([["u1", 50, 30]], [])], [inn([["a1", 20, 30]], [])]) });
    for (const p of [...rep.userPoints, ...rep.aiPoints]) expect(p.text).not.toMatch(/\d seam and \d spin/);
  });

  it("does not call the selection strong when the AI's was clearly better", () => {
    const weak = squad("w").map((p) => ({ ...p, stats: { ...p.stats, bat_average: 15, bat_strike_rate: 90 } }));
    const rep = buildSelectionReport({ userSquad: weak, aiSquad: a, challenge: ch, winner: "AI", userInnings: [inn([["w1", 20, 30]], [])], aiInnings: [inn([["a1", 90, 40]], [])], performance: computeMatchPerformance("T20", [inn([["w1", 20, 30]], [])], [inn([["a1", 90, 40]], [])]) });
    if (rep.totals.AI - rep.totals.USER >= 3) {
      expect(rep.nextTime.join(" ")).not.toMatch(/strong, balanced selection/i);
    }
  });
});

describe("team report scoring", () => {
  it("keeps fielding neutral when there were almost no chances", () => {
    const mine = inn([["u1", 150, 100]], []);
    const theirs = inn([["a1", 120, 100]], [["u7", "4.0", 30, 2]]);
    theirs.fielders = [];
    const perf = computeMatchPerformance("T20", [mine], [theirs]);
    expect(perf.USER.fieldingScore).toBe(50);
    expect(perf.USER.stats.fieldingChances).toBe(0);
  });

  it("does not floor a two-wicket bowling display at zero on a flat track", () => {
    const mine = inn([["u1", 150, 100]], []);
    const theirs = inn([["a1", 150, 100]], [["u7", "20.0", 150, 2]]);
    const perf = computeMatchPerformance("T20", [mine], [theirs]);
    expect(perf.USER.bowlingScore).toBeGreaterThan(0);
  });
});
