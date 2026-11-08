import { phaseMixFactors } from "./phase-stats";
import type { MatchFormat, PlayerWithStats } from "./types";
import { ERA_BASELINES, PLAYER_MID_YEAR, type EraBaseline } from "./era-data";
import { DATA_NORMS } from "./data-norms.generated";

/**
 * League numbers by era: Full Member v Full Member matches from the Cricsheet ETL (src/etl/splits.ts)
 * when present; the older table counted Associate matches too, which since 2019 are most T20Is and
 * made the 2020s look low-scoring (marking 2010s batters down and 2020s batters up).
 */
const ERA_TABLE = (format: MatchFormat): Record<string, EraBaseline> =>
  ((DATA_NORMS as any)[format]?.era as Record<string, EraBaseline> | undefined) ?? ERA_BASELINES[format];

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
  const table = ERA_TABLE(format);
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

/** The player with strike rate, average, economy and bowling average scaled to the common baseline (era and, in T20, phase mix). */
export function eraAdjusted(p: PlayerWithStats, format: MatchFormat): PlayerWithStats {
  let byFormat = cache.get(p.stats);
  let stats = byFormat?.get(format);
  if (!stats) {
    const f = eraFactors(p, format);
    // T20: also put the numbers on an average mix of powerplay, middle and death overs
    const m = phaseMixFactors(p, format);
    const mixed = m.sr !== 1 || m.bpo !== 1 || m.econ !== 1 || m.bpw !== 1;
    stats =
      f === NEUTRAL && !mixed
        ? p.stats
        : {
            ...p.stats,
            bat_strike_rate: p.stats.bat_strike_rate * f.sr * m.sr,
            // average = balls per dismissal x strike rate
            bat_average: p.stats.bat_average * f.avg * m.sr * m.bpo,
            bowl_economy: p.stats.bowl_economy * f.econ * m.econ,
            // bowling average = balls per wicket x economy
            bowl_average: p.stats.bowl_average * f.bavg * m.econ * m.bpw,
          };
    if (!byFormat) cache.set(p.stats, (byFormat = new Map()));
    byFormat.set(format, stats);
  }
  return stats === p.stats ? p : { ...p, stats };
}
