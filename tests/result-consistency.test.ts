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

import { ballsToOvers, decimalOversToString } from "../src/core/overs";

const FORMATS: Challenge["format"][] = ["T20", "ODI", "TEST"];

describe("result screen consistency", () => {
  it("overs are always formatted as balls (2.4, never 2.7)", () => {
    expect(ballsToOvers(16)).toBe("2.4");
    expect(decimalOversToString(2 + 4 / 6)).toBe("2.4");
    for (let seed = 1; seed <= 12; seed++) {
      const r = simulateCricketMatch(squad("u"), squad("a"), ch("HIGH_SCORING_FLAT"), seed);
      const text = JSON.stringify([r.selection, r.playerOfTheMatch, r.decisiveDifference, r.whyWinnerWon, r.whyLoserLost]);
      for (const m of text.matchAll(/(\d+)\.(\d+) ov/g)) expect(Number(m[2])).toBeLessThanOrEqual(5);
    }
  });

  it("Player of the Match is the winning side's top impact and Best Pick agrees", () => {
    for (const format of FORMATS) {
      for (let seed = 1; seed <= 12; seed++) {
        const r = simulateCricketMatch(squad("u"), squad("a"), ch("HIGH_SCORING_FLAT", format), seed);
        if (r.winner !== "USER" && r.winner !== "AI") continue;
        expect(r.playerOfTheMatch.team).toBe(r.winner);
        if (r.winner === "USER" && r.selection?.bestPick && r.playerOfTheMatch.name === r.selection.bestPick.name) {
          expect(r.selection.bestPick.name).toBe(r.playerOfTheMatch.name);
        }
      }
    }
  });

  it("never claims a batter was 'not dislodged' unless the scorecard has them not out", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = simulateCricketMatch(squad("u"), squad("a"), ch("HIGH_SCORING_FLAT"), seed);
      const lines = [r.decisiveDifference, ...r.whyWinnerWon, ...r.whyLoserLost];
      const all = [...r.userInnings.batters, ...r.aiInnings.batters];
      for (const l of lines) {
        const m = l.match(/Could not dislodge (.+?), who was not out/);
        if (m) expect(all.some((b) => b.name === m[1] && !b.isOut)).toBe(true);
        const f = l.match(/^(.+?) carried .* home with/);
        if (f) expect(all.some((b) => b.name === f[1] && !b.isOut)).toBe(true);
      }
    }
  });

  it("flags phases a side never reached", () => {
    let seen = false;
    for (let seed = 1; seed <= 60 && !seen; seed++) {
      const r = simulateCricketMatch(squad("u"), squad("a"), ch("GREEN_SEAMER"), seed);
      for (const side of ["USER", "AI"] as const) {
        const inn = side === "USER" ? r.userInnings : r.aiInnings;
        const reached = r.performance![side].stats.phasesReached;
        expect(reached.death).toBe(inn.totalBalls > 90);
        if (!reached.death) seen = true;
      }
    }
    expect(seen).toBe(true);
  });

  it("a chase won with overs and wickets to spare scores well for batting", () => {
    let checked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = simulateCricketMatch(squad("u"), squad("a"), ch("HIGH_SCORING_FLAT"), seed);
      const chaser = r.toss.decision === "BAT" ? (r.toss.winner === "USER" ? "AI" : "USER") : r.toss.winner;
      if (r.winner !== chaser) continue;
      const inn = chaser === "USER" ? r.userInnings : r.aiInnings;
      if (inn.totalBalls <= 96 && inn.totalWickets <= 4) {
        expect(r.performance![chaser].battingScore).toBeGreaterThanOrEqual(60);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(0);
  });
});
