import { describe, it, expect } from "vitest";
import { plainReason, shortName, keyStats, ruleText } from "../web/src/format";
import type { PlayerWithStats } from "../src/core/types";

const player = (over: Partial<PlayerWithStats> = {}): PlayerWithStats => ({
  id: "p",
  name: "Ravindrasinh Anirudhsinh Jadeja",
  country: "IND",
  batting_hand: "LHB",
  bowling_category: "SPIN",
  primary_role: "AR",
  stats: { player_id: "p", format: "T20", matches: 70, bat_innings: 50, bat_runs: 500, bat_average: 22.1, bat_strike_rate: 127.4, top_order_innings: 0, middle_order_innings: 40, finisher_innings: 10, bowl_innings: 60, bowl_overs: 200, bowl_wickets: 54, bowl_average: 29, bowl_economy: 7.11 },
  ...over,
});

describe("UI wording", () => {
  it("turns the AI's reasons into plain words, with no 'selection points'", () => {
    const cases = [
      "AI took Axar Patel to keep him from you: without Axar Patel, your best XI would lose about 2.1 selection points.",
      "AI strategically secured Mustafizur Rahman for Slot #11 (+0.8 selection points).",
      "AI strategically secured Tim Southee for Slot #9 (+-0.3 selection points).",
      "AI opened with Shakib Al Hasan, the pick that builds the strongest XI for dustbowl conditions.",
      "AI picked Kuldeep Yadav into Slot #10.",
    ];
    for (const c of cases) {
      const out = plainReason(c);
      expect(out).not.toMatch(/selection points|Slot #/);
    }
    expect(plainReason(cases[0])).toBe("Taken partly to keep Axar Patel away from you.");
  });

  it("shortens long names for tight rows and keeps short ones", () => {
    expect(shortName({ name: "Ravindrasinh Anirudhsinh Jadeja" })).toBe("R. A. Jadeja");
    expect(shortName({ name: "Virat Kohli" })).toBe("Virat Kohli");
  });

  it("shows the stats that matter for the role and format", () => {
    expect(keyStats(player(), "T20")).toBe("SR 127 · 54w · 7.1 econ");
    expect(keyStats(player({ primary_role: "BAT" }), "TEST")).toMatch(/^Avg 22\.1 · 500 runs$/);
    expect(keyStats(player({ primary_role: "BOWL" }), "ODI")).toBe("54 wkts · Econ 7.11");
  });

  it("describes the scenario rule in words", () => {
    expect(ruleText({ type: "min_category", category: "SPIN", count: 2 })).toBe("At least 2 spinners");
    expect(ruleText({ type: "max_per_country", value: 2, exceptions: { IND: 3 } })).toBe("At most 2 players from one country (3 from IND)");
  });
});
