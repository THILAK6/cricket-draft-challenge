import { describe, it, expect } from "vitest";
import { canCompleteSquad, canPickPlayer, checkChallengeFeasibility, checkDraftFeasibility, validateSquad } from "../src/core/validator";
import type { Challenge, PlayerWithStats } from "../src/core/types";

const mk = (id: string, country: string, role: PlayerWithStats["primary_role"] = "BAT", cat: PlayerWithStats["bowling_category"] = "NONE"): PlayerWithStats => ({
  id, name: id, country, batting_hand: "RHB", bowling_category: cat, primary_role: role,
  stats: { player_id: id, format: "T20", matches: 50, bat_innings: 40, bat_runs: 900, bat_average: 28, bat_strike_rate: 130, top_order_innings: 20, middle_order_innings: 15, finisher_innings: 5, bowl_innings: role === "BOWL" || role === "AR" ? 40 : 0, bowl_overs: role === "BOWL" || role === "AR" ? 120 : 0, bowl_wickets: 40, bowl_average: 25, bowl_economy: 8 },
});
const ipl: Challenge = {
  id: "c", title: "IPL", format: "T20", league: "IPL", venue: { name: "Wankhede Stadium, Mumbai", country: "IND", pitch_type: "HIGH_SCORING_FLAT" },
  narrative_intro: "", constraints: [{ type: "max_overseas", value: 4, home: "IND" }],
};
/** `home` Indian players (two keepers, six bowlers, the rest batters) and `away` overseas ones (every other one a bowler) */
const league = (home: number, away: number) => [
  mk("wk", "IND", "WK"),
  mk("wk2", "IND", "WK"),
  ...Array.from({ length: Math.min(6, home - 2) }, (_, i) => mk(`bowl${i}`, "IND", "BOWL", i % 2 ? "SPIN" : "PACE")),
  ...Array.from({ length: Math.max(0, home - 8) }, (_, i) => mk(`ind${i}`, "IND")),
  ...Array.from({ length: away }, (_, i) => (i % 2 ? mk(`os${i}`, i % 3 ? "AUS" : "ENG", "BOWL", "PACE") : mk(`os${i}`, i % 3 ? "AUS" : "ENG"))),
];

describe("the franchise overseas limit", () => {
  it("is a violation to field a fifth overseas player", () => {
    const pool = league(14, 8);
    const four = [...pool.filter((p) => p.country === "IND").slice(0, 7), ...pool.filter((p) => p.country !== "IND").slice(0, 4)];
    expect(validateSquad(four, ipl).violations.join()).not.toMatch(/overseas/i);
    const five = [...four.slice(0, 6), ...pool.filter((p) => p.country !== "IND").slice(0, 5)];
    expect(validateSquad(five, ipl).violations.join()).toMatch(/overseas/i);
  });

  it("stops the fifth overseas pick, never an Indian one", () => {
    const pool = league(14, 8);
    const abroad = pool.filter((p) => p.country !== "IND");
    const squad = [...pool.slice(0, 3), ...abroad.slice(0, 4)];
    const no = canPickPlayer(abroad[4], squad, ipl);
    expect(no.allowed).toBe(false);
    expect(no.reason).toMatch(/Overseas limit/);
    expect(canPickPlayer(pool.find((p) => p.id === "ind0")!, squad, ipl).allowed).toBe(true);
  });

  it("sees at the endgame when an XI can no longer be finished", () => {
    // Four overseas already; the pool left has only overseas players
    const squad = [...league(14, 8).filter((p) => p.country === "IND").slice(0, 5), ...league(14, 8).filter((p) => p.country !== "IND").slice(0, 4)];
    const onlyAbroad = Array.from({ length: 6 }, (_, i) => mk(`late${i}`, "AUS"));
    expect(canCompleteSquad(squad, onlyAbroad, ipl)).toBe(false);
    const withHome = [...onlyAbroad, ...Array.from({ length: 6 }, (_, i) => mk(`home${i}`, "IND", i < 2 ? "BOWL" : "BAT", i < 2 ? "PACE" : "NONE"))];
    expect(canCompleteSquad(squad, withHome, ipl)).toBe(true);
  });

  it("makes a pool with too few Indian players infeasible, for one XI and for two", () => {
    // 6 home + 4 overseas = 10 < 11
    const few = checkChallengeFeasibility(league(6, 10), ipl);
    expect(few.isFeasible).toBe(false);
    expect(few.reasons.join()).toMatch(/overseas limit/i);
    expect(checkChallengeFeasibility(league(14, 10), ipl).isFeasible).toBe(true);
    // Two XIs need 22: 14 Indian + 8 overseas is just enough, 13 + 9 is not
    expect(checkDraftFeasibility(league(14, 12), ipl).isFeasible).toBe(true);
    expect(checkDraftFeasibility(league(13, 12), ipl).isFeasible).toBe(false);
  });

  it("explains the rule in plain words", async () => {
    const { ruleText } = await import("../web/src/format");
    expect(ruleText(ipl.constraints[0])).toBe("At most 4 overseas players (from outside India)");
  });
});
