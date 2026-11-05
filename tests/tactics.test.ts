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


const mk = (id: string, role: "BAT" | "WK" | "AR" | "BOWL", cat: "NONE" | "PACE" | "SPIN", sr: number, avg: number, hand: "LHB" | "RHB" = "RHB") => {
  const p = createMockPlayer(id, "IND", role, hand, cat, 7.5, sr, avg);
  p.bowling_style = cat === "SPIN" ? "Slow left-arm orthodox" : cat === "PACE" ? "Right-arm fast" : "";
  return p;
};
const squad = (prefix: string): PlayerWithStats[] => [
  mk(`${prefix}1`, "BAT", "NONE", 120, 42),
  mk(`${prefix}2`, "BAT", "NONE", 135, 36, "LHB"),
  mk(`${prefix}3`, "BAT", "NONE", 128, 45),
  mk(`${prefix}4`, "BAT", "NONE", 160, 28),
  mk(`${prefix}5`, "WK", "NONE", 150, 30),
  mk(`${prefix}6`, "AR", "PACE", 150, 30),
  mk(`${prefix}7`, "AR", "SPIN", 140, 26),
  mk(`${prefix}8`, "BOWL", "PACE", 100, 10),
  mk(`${prefix}9`, "BOWL", "PACE", 90, 8),
  mk(`${prefix}10`, "BOWL", "SPIN", 80, 6),
  mk(`${prefix}11`, "BOWL", "SPIN", 75, 5),
];
const ch = (pitch: Challenge["venue"]["pitch_type"], format: Challenge["format"] = "T20"): Challenge => ({
  id: "c", title: "t", format, venue: { name: "V", country: "IND", pitch_type: pitch }, narrative_intro: "", constraints: [],
});

describe("conditions-driven tactics", () => {
  it("honours the user's new-ball and death plan", () => {
    const user = squad("u");
    const r = simulateCricketMatch(user, squad("a"), ch("HIGH_SCORING_FLAT"), 11, {
      userPlan: { newBall: ["u11", "u10"], death: "u9" },
    });
    expect(r.tactics.some((t) => t.includes("takes the new ball as planned"))).toBe(true);
    expect(r.tactics.some((t) => t.includes("death overs"))).toBe(true);
    // Plan is for your side only: the AI line-up never reports being on a plan
    expect(r.tactics.filter((t) => t.startsWith("AI XI:")).some((t) => t.includes("as planned"))).toBe(false);
  });

  it("opens with spin on a turning pitch when no plan is set", () => {
    let spinOpened = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const r = simulateCricketMatch(squad("u"), squad("a"), ch("DUSTBOWL"), seed);
      if (r.tactics.some((t) => t.includes("opens the bowling on a turning pitch"))) spinOpened++;
    }
    expect(spinOpened).toBe(10);
  });

  it("does not open with spin on a green seamer", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = simulateCricketMatch(squad("u"), squad("a"), ch("GREEN_SEAMER"), seed);
      expect(r.tactics.some((t) => t.includes("opens the bowling on a turning pitch"))).toBe(false);
    }
  });

  it("adjusts the batting order and bowling to the situation in T20", () => {
    const all: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      all.push(...simulateCricketMatch(squad("u"), squad("a"), ch("HIGH_SCORING_FLAT"), seed).tactics);
    }
    expect(all.some((t) => t.includes("promoted up the order"))).toBe(true);
    expect(all.some((t) => t.includes("brought on against") || t.includes("attack the new batter"))).toBe(true);
  });

  it("keeps the log short and the batting card in the order they actually batted", () => {
    const r = simulateCricketMatch(squad("u"), squad("a"), ch("HIGH_SCORING_FLAT"), 5);
    expect(r.tactics.length).toBeLessThanOrEqual(8);
    for (const inn of [r.userInnings, r.aiInnings]) {
      expect(new Set(inn.batters.map((b) => b.playerId)).size).toBe(inn.batters.length);
    }
  });
});
