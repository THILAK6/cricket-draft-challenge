import type { MatchFormat, PlayerWithStats } from "./types";

/**
 * Picks are players, not slots. This places a squad (complete or not) into a sensible batting
 * order: openers at the top, specialist batters through the top order, keeper and all-rounders in
 * the middle, bowlers from the bottom up. With a partial squad the empty slots are left where the
 * missing players would naturally bat. The user can change the order once the draft is over.
 */
type Squad = (PlayerWithStats | null)[];

const share = (p: PlayerWithStats, n: number) => n / Math.max(1, p.stats.bat_innings);

/** Opens the batting in this format: a top-order specialist batter or keeper (or a top-order all-rounder). */
export function isNaturalOpener(p: PlayerWithStats): boolean {
  if (p.primary_role === "BOWL") return false;
  const s = p.stats;
  const top = share(p, s.top_order_innings);
  if (p.primary_role === "AR") return s.top_order_innings >= 10 && top >= 0.6;
  return s.top_order_innings >= 5 && top >= 0.5 && s.top_order_innings >= s.middle_order_innings;
}

/** Batting value used to rank batters within a group (higher bats higher). */
function battingValue(p: PlayerWithStats, format: MatchFormat): number {
  const avg = p.stats.bat_average || 0;
  const sr = p.stats.bat_strike_rate || 0;
  if (format === "TEST") return avg;
  if (format === "ODI") return avg * 0.7 + sr * 0.3 * 0.4;
  return avg * 0.5 + sr * 0.5 * 0.25;
}

const range = (from: number[]): number[] => [...from, ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((i) => !from.includes(i))];

function preferredSlots(p: PlayerWithStats, format: MatchFormat): number[] {
  const test = format === "TEST";
  if (isNaturalOpener(p)) return range([0, 1, 2, 3]);
  switch (p.primary_role) {
    case "BAT":
      return range([2, 3, 4, 1, 0, 5]);
    case "WK":
      return test ? range([6, 5, 4, 7, 3]) : range([4, 5, 3, 6, 2]);
    case "AR":
      return test ? range([5, 6, 7, 4, 8]) : range([5, 6, 4, 7, 3, 8]);
    default:
      return range([10, 9, 8, 7, 6, 5]);
  }
}

/** Order the players are placed in: who gets first choice of slots. */
function placementRank(p: PlayerWithStats): number {
  if (isNaturalOpener(p)) return 0;
  if (p.primary_role === "BAT") return 1;
  if (p.primary_role === "BOWL") return 2;
  return 3; // keepers and all-rounders take the middle slots that are left
}

/** A full XI as a ranked list: two openers, then batters, then keeper and all-rounders, then bowlers. */
function orderFullXI(list: PlayerWithStats[], format: MatchFormat): Squad {
  const byBat = (a: PlayerWithStats, b: PlayerWithStats) => battingValue(b, format) - battingValue(a, format) || a.id.localeCompare(b.id);
  const topShare = (p: PlayerWithStats) => share(p, p.stats.top_order_innings);
  const rest = [...list];
  const take = (p: PlayerWithStats) => rest.splice(rest.indexOf(p), 1)[0];
  // Openers: natural openers first, then whoever has opened most among the non-bowlers
  const openers = rest.filter(isNaturalOpener).sort((a, b) => topShare(b) - topShare(a) || byBat(a, b)).slice(0, 2);
  openers.forEach(take);
  while (openers.length < 2) {
    const next = rest
      .filter((p) => p.primary_role !== "BOWL")
      .sort((a, b) => b.stats.top_order_innings - a.stats.top_order_innings || (a.primary_role === "BAT" ? -1 : 0) - (b.primary_role === "BAT" ? -1 : 0) || byBat(a, b))[0];
    if (!next) break;
    openers.push(take(next));
  }
  const batters = rest.filter((p) => p.primary_role === "BAT" || isNaturalOpener(p)).sort(byBat);
  batters.forEach(take);
  const middle = rest.filter((p) => p.primary_role === "WK" || p.primary_role === "AR").sort(byBat);
  middle.forEach(take);
  const bowlers = rest.sort((a, b) => (b.stats.bat_average || 0) - (a.stats.bat_average || 0) || a.id.localeCompare(b.id));
  // Tests: the keeper usually bats 7, below a batting all-rounder
  if (format === "TEST" && middle.length > 1 && middle[0].primary_role === "WK" && middle[1].primary_role === "AR") {
    [middle[0], middle[1]] = [middle[1], middle[0]];
  }
  const out: Squad = [...openers, ...batters, ...middle, ...bowlers];
  while (out.length < 11) out.push(null);
  return out.slice(0, 11);
}

/** Places a set of players (11 or fewer) into an 11-slot batting order. */
export function arrangeSquad(players: (PlayerWithStats | null)[], format: MatchFormat = "T20"): Squad {
  const list = players.filter((p): p is PlayerWithStats => p !== null);
  if (list.length >= 11) return orderFullXI(list.slice(0, 11), format);
  const out: Squad = Array(11).fill(null);
  const ordered = [...list].sort((a, b) => {
    const r = placementRank(a) - placementRank(b);
    if (r !== 0) return r;
    if (a.primary_role === "BOWL" && b.primary_role === "BOWL") {
      // The weakest batter goes in last
      return (a.stats.bat_average || 0) - (b.stats.bat_average || 0) || a.id.localeCompare(b.id);
    }
    if (isNaturalOpener(a) && isNaturalOpener(b)) {
      return share(b, b.stats.top_order_innings) - share(a, a.stats.top_order_innings) || battingValue(b, format) - battingValue(a, format) || a.id.localeCompare(b.id);
    }
    return battingValue(b, format) - battingValue(a, format) || a.id.localeCompare(b.id);
  });
  for (const p of ordered.slice(0, 11)) {
    const slot = preferredSlots(p, format).find((i) => !out[i]);
    if (slot !== undefined) out[slot] = p;
  }


  return out;
}
