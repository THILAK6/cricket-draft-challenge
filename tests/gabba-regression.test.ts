import { it, expect } from "vitest";
import { writeFileSync } from "fs";
import { computeContributions } from "../src/core/impact";
import { buildMatchFacts, checkTacticClaims } from "../src/core/match-facts";
import { userInnings, aiInnings } from "./fixtures/gabba";
import type { PlayerWithStats } from "../src/core/types";

const P = (id: string, name: string, role: PlayerWithStats["primary_role"], cat: "NONE" | "PACE" | "SPIN" = "NONE"): PlayerWithStats =>
  ({
    id, name, country: "AUS", batting_hand: "RHB", bowling_category: cat, primary_role: role,
    stats: { player_id: id, format: "ODI", matches: 40, bat_innings: 30, bat_runs: 900, bat_average: 30, bat_strike_rate: 85, top_order_innings: 10, middle_order_innings: 10, finisher_innings: 0,
      bowl_innings: cat === "NONE" ? 0 : 30, bowl_overs: cat === "NONE" ? 0 : 8, bowl_wickets: cat === "NONE" ? 0 : 60, bowl_average: 25, bowl_economy: 5 },
  } as PlayerWithStats);
// Drafted order: Shakib was drafted at #4 and Dhoni at #5; on the card Dhoni batted #4 and Shakib #5
const userSquad = [P("jay", "Jayasuriya", "BAT"), P("sang", "Sangakkara", "WK"), P("tend", "Tendulkar", "BAT"), P("shak", "Shakib", "AR", "SPIN"), P("dhon", "Dhoni", "WK"),
  P("hbj", "Harbhajan", "BOWL", "SPIN"), P("mcg", "McGrath", "BOWL", "PACE"), P("desi", "de Silva", "AR", "SPIN"), P("flow", "Flower", "WK"), P("malk", "Malik", "BAT"), P("camp", "Campher", "AR", "PACE")];
const aiSquad = Array.from({ length: 11 }, (_, i) => P(`a${i}`, `A${i}`, "BAT"));

const run = () => {
  const contributions = computeContributions({ format: "ODI", userInnings: [userInnings], aiInnings: [aiInnings], winner: "USER", pitch: "GREEN_SEAMER" });
  const facts = buildMatchFacts({ format: "ODI", winner: "USER", userInnings: [userInnings], aiInnings: [aiInnings], userSquad, aiSquad, pitch: "GREEN_SEAMER", contributions });
  return { contributions, facts };
};

it("Gabba ODI: awards, collapse and claim checks follow the documented rules", () => {
  const { contributions, facts } = run();
  if (process.env.OUT) {
    const rows = contributions.filter((c) => c.team === "USER").sort((a, b) => b.impact - a.impact)
      .map((x) => `${x.name.padEnd(11)} bat ${x.batImpact.toFixed(1).padStart(6)} bowl ${x.bowlImpact.toFixed(1).padStart(6)} field ${x.fieldImpact.toFixed(1).padStart(5)} = ${x.impact.toFixed(1).padStart(6)}`);
    writeFileSync(process.env.OUT, rows.join("\n") + `\nPOTM ${facts.awards.playerOfMatch?.name} | best ${facts.awards.bestPick?.name} | weakest ${facts.awards.weakestPick?.name}\n`);
  }
  expect(["Tendulkar", "Harbhajan"]).toContain(facts.awards.playerOfMatch?.name);
  expect(facts.awards.weakestPick?.name).toBe("Jayasuriya");
  expect(facts.sides.AI.collapsed).toBe(true);
  expect(facts.commonPhases.death).toBe(false);
  const malik = contributions.find((c) => c.name === "Malik")!;
  expect(malik.impact).toBeGreaterThan(20); // 2/11 in 18 balls is a strong spell
  const desilva = contributions.find((c) => c.name === "de Silva")!;
  expect(desilva.impact).toBeLessThan(facts.awards.playerOfMatch!.impact);

  // Shakib batted below his drafted slot's neighbour: a "promoted" line must be dropped; Dhoni really was moved up
  const shak = facts.players.find((p) => p.name === "Shakib")!;
  const dhon = facts.players.find((p) => p.name === "Dhoni")!;
  expect(shak.battingPos).toBeGreaterThanOrEqual(shak.lineupPos);
  expect(checkTacticClaims([{ text: "Your XI: Shakib promoted up the order", side: "Your XI", kind: "promo", playerId: "shak" }], facts)).toEqual([]);
  expect(dhon.battingPos).toBeLessThan(dhon.lineupPos);
  expect(checkTacticClaims([{ text: "Your XI: Dhoni promoted up the order", side: "Your XI", kind: "promo", playerId: "dhon" }], facts)).toHaveLength(1);
});
