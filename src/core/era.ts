import type { MatchFormat, PlayerWithStats } from "./types";
import { ERA_BASELINES, PLAYER_MID_YEAR } from "./era-data";

const bucketOf = (format: MatchFormat, year: number): string => String(format === "T20" ? Math.floor(year / 3) * 3 : Math.floor(year / 5) * 5);
const clamp = (x: number) => Math.min(1.2, Math.max(0.85, x));

export interface EraFactors {
  sr: number;
  avg: number;
  econ: number;
  bavg: number;
}
const NEUTRAL: EraFactors = { sr: 1, avg: 1, econ: 1, bavg: 1 };

/**
 * Multipliers that express a player's stats against the all-time league average for the era he played in:
 * a 75 ODI strike rate in 2002 is worth more than the same number in 2016. Players with no era data
 * (or synthetic test players) are left unchanged.
 */
const factorCache = new Map<string, EraFactors>();
export function eraFactors(p: { id: string }, format: MatchFormat): EraFactors {
  const year = PLAYER_MID_YEAR[format]?.[p.id];
  if (!year) return NEUTRAL;
  // Same (format, year) always gives the same factors: compute each once per isolate
  const key = `${format}:${year}`;
  const hit = factorCache.get(key);
  if (hit) return hit;
  const f = computeFactors(format, year);
  factorCache.set(key, f);
  return f;
}

function computeFactors(format: MatchFormat, year: number): EraFactors {
  const table = ERA_BASELINES[format];
  const all = table.all;
  let era = table[bucketOf(format, year)];
  if (!era) {
    // nearest bucket we have data for
    const keys = Object.keys(table).filter((k) => k !== "all").map(Number);
    const near = keys.sort((a, b) => Math.abs(a - year) - Math.abs(b - year))[0];
    era = near === undefined ? all : table[String(near)];
  }
  return {
    sr: clamp(all.sr / era.sr),
    avg: clamp(all.avg / era.avg),
    econ: clamp(all.econ / era.econ),
    bavg: clamp(all.bavg / era.bavg),
  };
}

/**
 * Adjusted stats, cached by the stats object: copies of a player (`{ ...p, primary_role }`) share
 * their stats, so they share the cache entry too.
 */
const cache = new WeakMap<PlayerWithStats["stats"], Map<MatchFormat, PlayerWithStats["stats"]>>();

/** The player with strike rate, average, economy and bowling average scaled to the common baseline. */
export function eraAdjusted(p: PlayerWithStats, format: MatchFormat): PlayerWithStats {
  let byFormat = cache.get(p.stats);
  let stats = byFormat?.get(format);
  if (!stats) {
    const f = eraFactors(p, format);
    stats =
      f === NEUTRAL
        ? p.stats
        : {
            ...p.stats,
            bat_strike_rate: p.stats.bat_strike_rate * f.sr,
            bat_average: p.stats.bat_average * f.avg,
            bowl_economy: p.stats.bowl_economy * f.econ,
            bowl_average: p.stats.bowl_average * f.bavg,
          };
    if (!byFormat) cache.set(p.stats, (byFormat = new Map()));
    byFormat.set(format, stats);
  }
  return stats === p.stats ? p : { ...p, stats };
}
