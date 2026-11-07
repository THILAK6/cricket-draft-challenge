import type { Challenge, Constraint, MatchFormat, PlayerWithStats } from "../../src/core/types";

export type Player = PlayerWithStats;
export type Squad = (Player | null)[];

export const PITCH_LABEL: Record<string, string> = {
  GREEN_SEAMER: "Green seamer",
  DUSTBOWL: "Dustbowl",
  HIGH_SCORING_FLAT: "Flat track",
  SLOW_LOW: "Slow & low",
};

export const PITCH_TIP: Record<string, string> = {
  GREEN_SEAMER: "Seamers rule here. Three good pace bowlers and batters who leave well.",
  DUSTBOWL: "Spin wins it. Two or three spinners, and batters who play turn.",
  HIGH_SCORING_FLAT: "Runs everywhere. Big hitters, and bowlers who stay economical.",
  SLOW_LOW: "Hard to score. Spinners, cutters and batters who rotate the strike.",
};

export const FORMAT_LABEL: Record<MatchFormat, string> = { T20: "T20", ODI: "ODI", TEST: "Test" };

export type RoleKey = "BAT" | "WK" | "AR" | "PACE" | "SPIN";

/** One label per player: batters, keepers and all-rounders by role, bowlers by type. */
export function roleKey(p: Player): RoleKey {
  if (p.primary_role === "BOWL") return p.bowling_category === "SPIN" ? "SPIN" : "PACE";
  return p.primary_role;
}

export const ROLE_LABEL: Record<RoleKey, string> = { BAT: "Batter", WK: "Keeper", AR: "All-rounder", PACE: "Pace", SPIN: "Spin" };
export const ROLE_SHORT: Record<RoleKey, string> = { BAT: "BAT", WK: "WK", AR: "AR", PACE: "PACE", SPIN: "SPIN" };

const n1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const n0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toString() : "–");

/** The two numbers that matter for this player in this format, for a compact list row. */
export function keyStats(p: Player, format: MatchFormat): string {
  const s = p.stats;
  const test = format === "TEST";
  const bat = test ? `Avg ${n1(s.bat_average)} · ${n0(s.bat_runs)} runs` : `Avg ${n1(s.bat_average)} · SR ${n0(s.bat_strike_rate)}`;
  const bowl = test ? `${n0(s.bowl_wickets)} wkts · Avg ${n1(s.bowl_average)}` : `${n0(s.bowl_wickets)} wkts · Econ ${s.bowl_economy.toFixed(2)}`;
  if (p.primary_role === "BOWL") return bowl;
  if (p.primary_role === "AR") {
    const b = test ? `Avg ${n0(s.bat_average)}` : `SR ${n0(s.bat_strike_rate)}`;
    const w = test ? `${n0(s.bowl_wickets)}w @ ${n0(s.bowl_average)}` : `${n0(s.bowl_wickets)}w · ${s.bowl_economy.toFixed(1)} econ`;
    return `${b} · ${w}`;
  }
  return bat;
}

/** Shorter given names: "Ravindrasinh Anirudhsinh Jadeja" reads as "R. A. Jadeja" in tight rows. */
export function shortName(p: { name: string; short_name?: string }, max = 22): string {
  if (p.short_name) return p.short_name;
  const name = p.name.trim();
  if (name.length <= max) return name;
  const parts = name.split(/\s+/);
  const last = parts.pop()!;
  return `${parts.map((x) => x[0] + ".").join(" ")} ${last}`;
}

export function ruleText(c: Constraint): string {
  switch (c.type) {
    case "max_per_country": {
      const ex = c.exceptions ? Object.entries(c.exceptions).map(([k, v]) => ` (${v} from ${k})`).join("") : "";
      return `At most ${c.value} players from one country${ex}`;
    }
    case "min_category": {
      const what = { PACE: "pace bowlers", SPIN: "spinners", WK: "wicketkeepers", AR: "all-rounders" }[c.category];
      return `At least ${c.count} ${what}`;
    }
    case "batting_hand_order":
      return `${c.hand === "LHB" ? "Left" : "Right"}-hander at ${c.positions.map((x) => `#${x}`).join(", ")}`;
    case "min_strike_rate_top_order":
      return `Top-order strike rate of ${c.threshold}+`;
    case "min_bowlers_economy_under":
      return `${c.min_count} bowlers with economy under ${c.threshold}`;
  }
}

/** Every XI needs these, on top of the scenario rule. */
export const BASE_RULES = ["11 players", "At least 1 wicketkeeper", "At least 5 bowling options"];

export const scenarioRules = (ch: Challenge): string[] => ch.constraints.map(ruleText);

export const overs = (s: string | number) => `${s} ov`;

/** The AI's pick reason in plain cricket words, without the "selection points" jargon. */
export function plainReason(reason: string): string {
  return reason
    .replace(/^AI took (.+?) to keep him from you: without .+?, your best XI would lose about -?[\d.]+ selection points\.$/, "Taken partly to keep $1 away from you.")
    .replace(/^AI strategically secured (.+?) for Slot #\d+ \(\+-?[\d.]+ selection points\)\.$/, "$1 fills a gap in its XI.")
    .replace(/^AI opened with (.+?), the pick that builds the strongest XI for (.+?) conditions\.$/, "$1 suits these $2 conditions.")
    .replace(/^AI picked (.+?) into Slot #\d+\.$/, "$1 was the best player left that fits its XI.");
}
