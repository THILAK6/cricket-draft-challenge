import { describe, it, expect } from "vitest";
import { simulateCricketMatch } from "../src/core/simulator";
import { phasesReached, collapsedEarly } from "../src/core/phases";
import { computeContributions, topContribution } from "../src/core/impact";
import type { InningsScorecard } from "../src/core/simulator";
import type { Challenge, PlayerWithStats } from "../src/core/types";

const mk = (id: string, role: "BAT" | "WK" | "AR" | "BOWL", cat: "NONE" | "PACE" | "SPIN"): PlayerWithStats => ({
  id, name: `P${id}`, country: "IND", batting_hand: "RHB", bowling_category: cat, primary_role: role,
  bowling_style: cat === "SPIN" ? "Off break" : cat === "PACE" ? "Right-arm fast" : "",
  stats: { player_id: id, format: "T20", matches: 40, bat_innings: 35, bat_runs: 1000, bat_average: 32, bat_strike_rate: 135,
    top_order_innings: 20, middle_order_innings: 10, finisher_innings: 0, bowl_innings: cat === "NONE" ? 0 : 35,
    bowl_overs: cat === "NONE" ? 0 : 4, bowl_wickets: cat === "NONE" ? 0 : 45, bowl_average: 21, bowl_economy: 7.5 },
});
const squad = (p: string) => [
  mk(`${p}1`, "BAT", "NONE"), mk(`${p}2`, "BAT", "NONE"), mk(`${p}3`, "BAT", "NONE"), mk(`${p}4`, "BAT", "NONE"),
  mk(`${p}5`, "WK", "NONE"), mk(`${p}6`, "AR", "PACE"), mk(`${p}7`, "AR", "SPIN"), mk(`${p}8`, "BOWL", "PACE"),
  mk(`${p}9`, "BOWL", "PACE"), mk(`${p}10`, "BOWL", "SPIN"), mk(`${p}11`, "BOWL", "SPIN"),
];
const ch: Challenge = { id: "c", title: "t", format: "T20", venue: { name: "V", country: "IND", pitch_type: "GREEN_SEAMER" }, narrative_intro: "", constraints: [] };

describe("second critique consistency", () => {
  it("key moments never claim a phase the Phases check says was not reached", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = simulateCricketMatch(squad("u"), squad("a"), ch, seed);
      const reached = phasesReached("T20", [r.userInnings, r.aiInnings]);
      const text = r.keyMoments.map((m) => `${m.title} ${m.description}`).join(" ");
      if (!reached.death) expect(text).not.toMatch(/final overs.*produced 0|Closing Phase Duel/);
      const side = (inn: InningsScorecard) => collapsedEarly("T20", inn);
      if (side(r.aiInnings) && !phasesReached("T20", [r.aiInnings]).death) {
        expect(r.keyMoments.map((m) => m.description).join(" ")).not.toMatch(/AI XI produced 0 in the final/);
      }
    }
  });

  it("names who dropped whom whenever drops are simulated for the losing side", () => {
    let seen = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = simulateCricketMatch(squad("u"), squad("a"), ch, seed);
      const drops = [...r.userInnings.drops ?? [], ...r.aiInnings.drops ?? []];
      expect(drops.length).toBe((r.userInnings.droppedCatches ?? 0) + (r.aiInnings.droppedCatches ?? 0));
      if (drops.length && r.whyLoserLost.some((t) => / dropped /.test(t))) seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("player of the match favours a hundred that nearly doubles the opposition total over a cheap 3/20", () => {
    const inn = (batters: any[], bowlers: any[], total: number, wk: number): InningsScorecard => ({
      totalRuns: total, totalWickets: wk, batters, bowlers, fielders: [], phaseRuns: { powerplay: 0, middle: 0, death: 0 },
    } as any);
    const userBat = inn([
      { playerId: "t", name: "Tendulkar", runs: 104, balls: 80, fours: 10, sixes: 2, isOut: false },
      { playerId: "j", name: "Jayasuriya", runs: 0, balls: 1, fours: 0, sixes: 0, isOut: true },
    ], [], 250, 3);
    const aiBat = inn([
      { playerId: "x", name: "X", runs: 20, balls: 25, fours: 1, sixes: 0, isOut: true, bowlerId: "d" },
    ], [{ playerId: "d", name: "de Silva", overs: "4.0", runs: 20, wickets: 3 }], 59, 10);
    const c = computeContributions({ format: "ODI", userInnings: [userBat], aiInnings: [aiBat], winner: "USER" });
    expect(topContribution(c, "USER")?.name).toBe("Tendulkar");
  });
});
