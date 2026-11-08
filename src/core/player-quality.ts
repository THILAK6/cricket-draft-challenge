import type { MatchFormat, PlayerWithStats } from "./types";
import { eraAdjusted } from "./era";

/**
 * How good a player is in a format, from career stats only (no names, no reputation).
 *
 * Batting and bowling each get a raw value from era-adjusted stats, with small samples pulled
 * towards a replacement-level player (so 12 good innings don't outrank 120). Each raw value is
 * then mapped onto one 0-100 scale (CALIBRATION: about 30 for a fringe international, 95 for
 * the very best), so a batter's 80 and a bowler's 80 mean the same.
 *
 * Overall: batters and keepers by batting (keepers +4, the gloves are scarce), bowlers by
 * bowling, all-rounders by their better skill plus 40% of the other. Adding both skills in
 * full made every all-rounder look better than a great specialist.
 */

/** Replacement-level stats that small samples are pulled towards, and how hard (k = innings of prior). */
const PRIOR: Record<MatchFormat, { avg: number; sr: number; batK: number; bavg: number; econ: number; wpi: number; bowlK: number }> = {
  T20: { avg: 17, sr: 112, batK: 15, bavg: 32, econ: 8.4, wpi: 0.7, bowlK: 15 },
  ODI: { avg: 22, sr: 72, batK: 20, bavg: 42, econ: 5.7, wpi: 0.9, bowlK: 20 },
  TEST: { avg: 22, sr: 45, batK: 20, bavg: 42, econ: 3.4, wpi: 1.3, bowlK: 12 },
};

const shrink = (value: number, n: number, prior: number, k: number) => (value * n + prior * k) / (n + k);

/**
 * Career economy by bowling type (era-adjusted, weighted by overs; frontline bowlers and
 * all-rounders of Full Member nations with 15+ innings). In white-ball cricket spinners go for
 * fewer because captains keep them away from the powerplay and the death overs, not because they
 * are better bowlers: a T20 spinner's 7.3 is worth a pacer's 8.2. Tests have no such phases, so
 * there a spinner's lower economy is his own. Re-check with tests/player-data.test.ts.
 */
export const TYPE_ECONOMY: Record<MatchFormat, { PACE: number; SPIN: number; ALL: number }> = {
  T20: { PACE: 8.163, SPIN: 7.31, ALL: 7.852 },
  ODI: { PACE: 5.159, SPIN: 4.737, ALL: 5.023 },
  TEST: { PACE: 3.059, SPIN: 3.059, ALL: 3.059 },
};

/** Economy judged against bowlers of the same type, on the common scale (part-timers unchanged). */
export function typeAdjustedEconomy(econ: number, category: string, format: MatchFormat): number {
  const t = TYPE_ECONOMY[format];
  if (category === "PACE") return (econ * t.ALL) / t.PACE;
  if (category === "SPIN") return (econ * t.ALL) / t.SPIN;
  return econ;
}

/** Raw values depend only on a player's stats and era, so they are cached by the stats object. */
const rawCache = new WeakMap<PlayerWithStats["stats"], Map<string, number>>();
function memo(p: PlayerWithStats, key: string, fn: () => number): number {
  let m = rawCache.get(p.stats);
  if (!m) rawCache.set(p.stats, (m = new Map()));
  let v = m.get(key);
  if (v === undefined) m.set(key, (v = fn()));
  return v;
}

/** Raw batting value: average and strike rate combined the way the format rewards them. */
export function battingRaw(raw: PlayerWithStats, format: MatchFormat): number {
  return memo(raw, `bat:${format}`, () => battingRawUncached(raw, format));
}

function battingRawUncached(raw: PlayerWithStats, format: MatchFormat): number {
  const p = eraAdjusted(raw, format);
  const s = p.stats;
  const pr = PRIOR[format];
  const inn = Math.max(0, s.bat_innings);
  const avg = shrink(Math.min(s.bat_average || 0, format === "TEST" ? 70 : 65), inn, pr.avg, pr.batK);
  const sr = shrink(Math.min(s.bat_strike_rate || pr.sr, format === "T20" ? 175 : format === "ODI" ? 125 : 90), inn, pr.sr, pr.batK);
  if (format === "T20") return avg * Math.pow(sr / 100, 1.2);
  if (format === "ODI") return avg * Math.pow(sr / 100, 0.8);
  return avg * Math.pow(sr / 50, 0.2);
}

/** Raw bowling value: wickets and economy combined the way the format rewards them. 0 for non-bowlers. */
export function bowlingRaw(raw: PlayerWithStats, format: MatchFormat): number {
  return memo(raw, `bowl:${format}`, () => bowlingRawUncached(raw, format));
}

function bowlingRawUncached(raw: PlayerWithStats, format: MatchFormat): number {
  const p = eraAdjusted(raw, format);
  const s = p.stats;
  const pr = PRIOR[format];
  // Innings actually bowled in, so a batter's three overs of part-time spin don't count as a record
  const inn = Math.max(0, Math.min(s.bowl_innings || 0, s.matches));
  if (inn === 0 || s.bowl_overs <= 0) return 0;
  const bavg = shrink(s.bowl_wickets > 0 ? Math.max(15, s.bowl_average) : pr.bavg * 1.5, inn, pr.bavg, pr.bowlK);
  const econ = shrink(Math.max(3, s.bowl_economy ? typeAdjustedEconomy(s.bowl_economy, p.bowling_category, format) : pr.econ), inn, pr.econ, pr.bowlK);
  const wpi = shrink(s.bowl_wickets / inn, inn, pr.wpi, pr.bowlK);
  // Overs per innings: a bowler who bowls his full quota matters more than a part-timer
  const load = Math.min(1, s.bowl_overs / inn / (format === "T20" ? 3.5 : format === "ODI" ? 8.5 : 22));
  let v: number;
  if (format === "T20") v = Math.pow(8 / econ, 2) * Math.pow(wpi, 0.4);
  else if (format === "ODI") v = Math.pow(30 / bavg, 0.6) * Math.pow(5 / econ, 0.9) * Math.pow(wpi, 0.4);
  else v = Math.pow(30 / bavg, 1.5) * Math.sqrt(wpi);
  return v * (0.5 + 0.5 * load);
}

/**
 * Raw values at "fringe international" (maps to 30) and "the very best" (maps to 95), from the
 * seeded players (with career overrides and data fixes) of Full Member nations with 15+ matches
 * (20th and 98th percentiles). Re-derive with tests/rating-calibration.test.ts if the data or
 * the formulas change.
 */
export const CALIBRATION: Record<MatchFormat, { bat: [number, number]; bowl: [number, number] }> = {
  T20: { bat: [20.807, 53.069], bowl: [0.776, 1.363] },
  ODI: { bat: [19.552, 43.209], bowl: [0.701, 1.354] },
  TEST: { bat: [26.231, 50.163], bowl: [0.946, 2.803] },
};

const scale = (v: number, [lo, hi]: [number, number]) => Math.max(0, Math.min(110, 30 + ((v - lo) / (hi - lo)) * 65));

/** Batting on the common 0-100 scale. */
export const battingRating = (p: PlayerWithStats, format: MatchFormat) => scale(battingRaw(p, format), CALIBRATION[format].bat);
/** Bowling on the common 0-100 scale (0 for players who don't bowl). */
export const bowlingRating = (p: PlayerWithStats, format: MatchFormat) => {
  const raw = bowlingRaw(p, format);
  return raw > 0 ? scale(raw, CALIBRATION[format].bowl) : 0;
};

/** Format-specific overall quality, about 30-100, from career stats only. */
export function playerQuality(p: PlayerWithStats, format: string): number {
  const f = (format === "ODI" || format === "TEST" ? format : "T20") as MatchFormat;
  const bat = battingRating(p, f);
  const bowl = bowlingRating(p, f);
  switch (p.primary_role) {
    case "BOWL":
      return bowl;
    case "AR":
      return Math.min(110, Math.max(bat, bowl) + 0.4 * Math.min(bat, bowl));
    case "WK":
      return bat + 4;
    default:
      return bat;
  }
}

/**
 * Stature: quality plus a little for a long career, so the pool's "top players" are the stars a
 * fan would recognise rather than whoever has the most caps (or a great 15-match record).
 */
export function stature(p: PlayerWithStats, format: string): number {
  return playerQuality(p, format) + Math.min(10, p.stats.matches / 15);
}
