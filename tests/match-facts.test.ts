import { describe, it, expect } from "vitest";
import { simulateCricketMatch } from "../src/core/simulator";
import { checkTacticClaims } from "../src/core/match-facts";
import type { Challenge, PlayerWithStats } from "../src/core/types";

const mk = (id: string, role: "BAT" | "WK" | "AR" | "BOWL", cat: "NONE" | "PACE" | "SPIN", avg = 32, econ = 7.5): PlayerWithStats => ({
  id, name: `P${id}`, country: "IND", batting_hand: "RHB", bowling_category: cat, primary_role: role,
  bowling_style: cat === "SPIN" ? "Off break" : cat === "PACE" ? "Right-arm fast" : "",
  stats: { player_id: id, format: "ODI", matches: 40, bat_innings: 35, bat_runs: 1000, bat_average: avg, bat_strike_rate: 90,
    top_order_innings: 20, middle_order_innings: 10, finisher_innings: 0, bowl_innings: cat === "NONE" ? 0 : 35,
    bowl_overs: cat === "NONE" ? 0 : 8, bowl_wickets: cat === "NONE" ? 0 : 60, bowl_average: 25, bowl_economy: econ },
});
const squad = (p: string, avg = 32, econ = 5.5) => [
  mk(`${p}1`, "BAT", "NONE", avg), mk(`${p}2`, "BAT", "NONE", avg), mk(`${p}3`, "BAT", "NONE", avg), mk(`${p}4`, "BAT", "NONE", avg),
  mk(`${p}5`, "WK", "NONE", avg), mk(`${p}6`, "AR", "PACE", avg, econ), mk(`${p}7`, "AR", "SPIN", avg, econ), mk(`${p}8`, "BOWL", "PACE", 10, econ),
  mk(`${p}9`, "BOWL", "PACE", 8, econ), mk(`${p}10`, "BOWL", "SPIN", 6, econ), mk(`${p}11`, "BOWL", "SPIN", 5, econ),
];
const ch = (pitch: Challenge["venue"]["pitch_type"] = "GREEN_SEAMER"): Challenge => ({
  id: "c", title: "t", format: "ODI", venue: { name: "V", country: "AUS", pitch_type: pitch }, narrative_intro: "", constraints: [],
});

function run(seed: number, uAvg = 32, aAvg = 32) {
  const user = squad("u", uAvg, uAvg > aAvg ? 4.6 : 5.8);
  const ai = squad("a", aAvg, aAvg > uAvg ? 4.6 : 5.8);
  const r = simulateCricketMatch(user, ai, ch(), seed);
  const facts = r.matchFacts!;
  return { r, facts };
}

function invariants(seed: number, uAvg: number, aAvg: number) {
  const { r, facts } = run(seed, uAvg, aAvg);
  // Awards come from one ranking
  expect(r.playerOfTheMatch.name).toBe(facts.awards.playerOfMatch?.name ?? r.playerOfTheMatch.name);
  const sel = r.selection!;
  if (sel.bestPick && sel.weakestPick) expect(sel.bestPick.name).not.toBe(sel.weakestPick.name);
  // Weakest never has a positive impact and is never the top scorer for the side
  if (sel.weakestPick) {
    const c = facts.contributions.find((x) => x.team === "USER" && x.name === sel.weakestPick!.name)!;
    expect(c.impact).toBeLessThanOrEqual(-8);
  }
  // The decisive difference never talks about a phase one side did not reach
  const text = `${r.decisiveDifference} ${r.keyMoments.map((m) => m.description).join(" ")}`;
  if (!facts.commonPhases.death) expect(text).not.toMatch(/produced 0 in the final|scored \d+ in the final overs, while/);
  // A side bowled out early: the story is the collapse, not a phase comparison
  for (const side of ["USER", "AI"] as const) {
    if (facts.sides[side].allOut && !facts.sides[side].reached.death && facts.winner !== side) {
      expect(r.decisiveDifference).not.toMatch(/middle overs/i);
    }
  }
  // Promotion claims match the scorecard
  const claims = r.tactics.filter((t) => t.includes("promoted up the order"));
  for (const t of claims) {
    const side = t.startsWith("Your XI") ? "USER" : "AI";
    const mine = facts.players.filter((p) => p.team === side && t.includes(p.name));
    expect(mine.some((p) => p.battingPos >= 0 && p.battingPos < p.lineupPos)).toBe(true);
  }
  // Keeper dismissals use the dagger, never an asterisk
  for (const b of [...r.userInnings.batters, ...r.aiInnings.batters]) expect(b.dismissal ?? "").not.toMatch(/\*/);
  // No tactic repeats a bowler
  const bowlerNotes = r.tactics.filter((t) => /brought on|takes the new ball|attack the new batter/.test(t));
  expect(new Set(bowlerNotes.map((t) => t.split(" ").slice(0, 3).join(" "))).size).toBe(bowlerNotes.length);
  return { r, facts };
}

describe("MatchFacts keeps every section consistent", () => {
  it("heavy win: tone scales and no 'raise the quality' after a dominant win", () => {
    let seen = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const { r, facts } = invariants(seed, 45, 22);
      if (facts.winner === "USER" && facts.margin.tier === "dominant") {
        seen++;
        expect(r.selection!.headline).not.toMatch(/enough on the day/);
        expect(r.selection!.nextTime.join(" ")).not.toMatch(/Raise the quality/);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("close chase and level sides stay consistent", () => {
    for (let seed = 1; seed <= 80; seed++) invariants(seed, 32, 32);
  });

  it("a side bowled out before the death overs never gets a death-over comparison", () => {
    let seen = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const { facts } = invariants(seed, 45, 20);
      if (!facts.commonPhases.death) seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("collapses are flagged from the scorecard", () => {
    let seen = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const { facts } = run(seed, 45, 20);
      if (facts.sides.AI.collapsed) {
        seen++;
        // Either bowled out early, or a cluster of wickets for next to nothing
        expect((facts.sides.AI.allOut && !facts.sides.AI.reached.death) || facts.sides.AI.cluster !== null).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("flags a part-time or spin opener on a green seamer instead of 'as planned'", () => {
    const { facts } = run(3);
    const spinner = facts.players.find((p) => p.team === "USER" && p.bowlerType === "SPIN")!;
    const out = checkTacticClaims([{ text: `Your XI: ${spinner.name} takes the new ball as planned`, side: "Your XI", kind: "plan", playerId: spinner.playerId }], facts);
    expect(out[0]).toMatch(/poor call/);
    expect(out[0]).not.toMatch(/as planned/);
  });

  it("drops a promotion claim that the scorecard contradicts", () => {
    const { facts } = run(3);
    const p = facts.players.find((x) => x.team === "USER" && x.lineupPos === 0)!; // opener cannot be promoted
    expect(checkTacticClaims([{ text: `Your XI: ${p.name} promoted up the order`, side: "Your XI", kind: "promo", playerId: p.playerId }], facts)).toEqual([]);
  });
});
