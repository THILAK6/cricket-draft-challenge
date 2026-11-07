import type { BowlingCategory, MatchFormat, PlayerRole, PlayerWithStats } from "./types";
import { battingRating, bowlingRating } from "./player-quality";

/** Spin or pace from the bowling style text, as the ETL does it. */
export function categoryFromStyle(style: string | undefined): BowlingCategory {
  const s = (style || "").toLowerCase();
  if (!s) return "NONE";
  return /spin|slow|break|orthodox|chinaman|googly/.test(s) ? "SPIN" : "PACE";
}

/**
 * Corrects a role the data clearly contradicts, for one format. The seeded roles come from
 * career-wide rules of thumb, which tag some all-rounders as bowlers (Mitchell Marsh, Lance
 * Klusener, Rachin Ravindra), some batters as bowlers (Aravinda de Silva) and some bowlers as
 * batters (Ashley Giles). Only big gaps between the batting and bowling ratings change anything.
 * Keepers are left alone (their role is about the gloves, which the stats don't show).
 */
export function correctRole(p: PlayerWithStats, format: MatchFormat): PlayerWithStats {
  if (p.primary_role === "WK") return p;
  const bat = battingRating(p, format);
  const bowl = bowlingRating(p, format);
  const share = p.stats.bowl_innings / Math.max(1, p.stats.matches);
  let role: PlayerRole = p.primary_role;
  let cat: BowlingCategory = p.bowling_category;

  if (p.primary_role === "BOWL" && bat >= 40 && bat > bowl + 15) {
    role = bowl >= 20 ? "AR" : "BAT";
  } else if (p.primary_role === "AR" && bat < 20 && bowl >= 30) {
    role = "BOWL";
  } else if (p.primary_role === "BAT" && bowl >= 40 && share >= 0.6 && bowl > bat + 15) {
    role = "BOWL";
  }
  if (role === p.primary_role) return p;
  if (role === "BAT") cat = "NONE";
  else if (cat === "NONE") cat = categoryFromStyle(p.bowling_style);
  if (role !== "BAT" && cat === "NONE") return p; // no bowling style to go on: leave it
  return { ...p, primary_role: role, bowling_category: cat };
}
