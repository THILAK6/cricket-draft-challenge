import type { Challenge, Constraint, MatchFormat, PlayerWithStats } from "./types";

export interface SquadValidationResult {
  valid: boolean;
  violations: string[];
}

export interface FeasibilityResult {
  isFeasible: boolean;
  validCombinationsFound: number;
  sampleSquad?: PlayerWithStats[];
  reasons: string[];
  /** Backtracking nodes visited, so callers can share one CPU budget across several searches. */
  nodesVisited?: number;
}

/**
 * Validates whether an individual 11-player squad satisfies all cricket rules
 * and challenge-specific constraints.
 */
/** Batting-order slots (0-based) that need specific kinds of player. */
export const OPENER_SLOTS = [0, 1];
export const TAIL_SLOTS = [8, 9, 10];

/** Specialist batter or keeper, or an all-rounder with a genuine top-order record. */
export function isOpenerCapable(p: PlayerWithStats): boolean {
  return (
    p.primary_role === "BAT" ||
    p.primary_role === "WK" ||
    (p.primary_role === "AR" && p.stats.top_order_innings >= 6)
  );
}

/** Frontline bowler or all-rounder: the only players who may bat 9-11. */
export function isTailCapable(p: PlayerWithStats): boolean {
  return p.primary_role === "BOWL" || p.primary_role === "AR";
}

export function validateSquad(squad: (PlayerWithStats | null)[], challenge: Challenge): SquadValidationResult {
  const violations: string[] = [];
  const nonNullSquad = squad.filter((p): p is PlayerWithStats => p !== null);

  // 1. Cricket Fundamental Rules
  if (nonNullSquad.length !== 11) {
    violations.push(`Squad must contain exactly 11 players (currently ${nonNullSquad.length}).`);
  }

  // Duplicate player check
  const playerIds = new Set(nonNullSquad.map((p) => p.id));
  if (playerIds.size !== nonNullSquad.length) {
    violations.push("Squad contains duplicate players.");
  }

  // Wicketkeeper rule: At least 1 WK
  const keepers = nonNullSquad.filter((p) => p.primary_role === "WK");
  if (keepers.length < 1) {
    violations.push("Squad must have at least 1 designated wicketkeeper.");
  }

  // Bowling rule: At least 5 bowling options (BOWL or AR, or >= 2 overs per match)
  const bowlingOptions = nonNullSquad.filter(
    (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0
  );
  if (bowlingOptions.length < 5) {
    violations.push(`Squad must have at least 5 bowling options (currently ${bowlingOptions.length}).`);
  }

  // 2. Challenge Specific Constraints
  for (const constraint of challenge.constraints) {
    switch (constraint.type) {
      case "max_per_country": {
        const countryCounts = new Map<string, number>();
        for (const p of nonNullSquad) {
          countryCounts.set(p.country, (countryCounts.get(p.country) || 0) + 1);
        }

        for (const [country, count] of countryCounts.entries()) {
          const maxAllowed = constraint.exceptions?.[country] ?? constraint.value;
          if (count > maxAllowed) {
            violations.push(
              `Exceeded maximum players for ${country}: allowed ${maxAllowed}, found ${count}.`
            );
          }
        }
        break;
      }

      case "min_category": {
        let count = 0;
        if (constraint.category === "PACE") {
          count = nonNullSquad.filter((p) => p.bowling_category === "PACE").length;
        } else if (constraint.category === "SPIN") {
          count = nonNullSquad.filter((p) => p.bowling_category === "SPIN").length;
        } else if (constraint.category === "WK") {
          count = nonNullSquad.filter((p) => p.primary_role === "WK").length;
        } else if (constraint.category === "AR") {
          count = nonNullSquad.filter((p) => p.primary_role === "AR").length;
        }

        if (count < constraint.count) {
          violations.push(
            `Requires at least ${constraint.count} ${constraint.category} players (found ${count}).`
          );
        }
        break;
      }

      case "batting_hand_order": {
        // Check if squad has enough players with requested hand to cover specified positions
        const matchingHandPlayers = nonNullSquad.filter((p) => p.batting_hand === constraint.hand);
        const requiredCount = constraint.positions.length;
        if (matchingHandPlayers.length < requiredCount) {
          violations.push(
            `Requires at least ${requiredCount} ${constraint.hand} batters for positions ${constraint.positions.join(",")}, but only ${matchingHandPlayers.length} in squad.`
          );
        }
        break;
      }

      case "min_bowlers_economy_under": {
        const qualifyingBowlers = nonNullSquad.filter(
          (p) =>
            (p.primary_role === "BOWL" || p.primary_role === "AR") &&
            p.stats.bowl_economy > 0 &&
            p.stats.bowl_economy <= constraint.threshold
        );
        if (qualifyingBowlers.length < constraint.min_count) {
          violations.push(
            `Requires at least ${constraint.min_count} bowlers with economy <= ${constraint.threshold} (found ${qualifyingBowlers.length}).`
          );
        }
        break;
      }

      case "min_strike_rate_top_order": {
        const highSrBatters = nonNullSquad.filter(
          (p) => p.stats.bat_strike_rate >= constraint.threshold
        );
        if (highSrBatters.length < 2) {
          violations.push(
            `Requires at least 2 batters with Strike Rate >= ${constraint.threshold} (found ${highSrBatters.length}).`
          );
        }
        break;
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Upper bound on backtracking nodes visited per feasibility search. With pruning, realistic
 * challenges need under ~10k nodes (a few ms); impossible ones fail at the root. The cap
 * keeps worst-case CPU inside the Workers free plan's 10 ms-per-request limit.
 */
export const DEFAULT_SEARCH_NODE_BUDGET = 20_000;

/**
 * Fast backtracking constraint satisfaction checker.
 * Explores combination tree to guarantee at least `targetSolutions` (default: 50)
 * valid 11-player squads can be formed from the pool.
 */
export function checkChallengeFeasibility(
  pool: PlayerWithStats[],
  challenge: Challenge,
  targetSolutions = 50,
  maxNodes = DEFAULT_SEARCH_NODE_BUDGET
): FeasibilityResult {
  const reasons: string[] = [];

  // Fast pre-flight pigeonhole checks
  if (pool.length < 11) {
    return {
      isFeasible: false,
      validCombinationsFound: 0,
      reasons: [`Pool has fewer than 11 players (${pool.length}).`],
    };
  }

  const keepers = pool.filter((p) => p.primary_role === "WK");
  if (keepers.length < 1) {
    return {
      isFeasible: false,
      validCombinationsFound: 0,
      reasons: ["No wicketkeepers available in the pool."],
    };
  }

  const bowlers = pool.filter(
    (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0
  );
  if (bowlers.length < 5) {
    return {
      isFeasible: false,
      validCombinationsFound: 0,
      reasons: [`Fewer than 5 bowling options in the pool (${bowlers.length}).`],
    };
  }

  // Pre-filter country caps
  for (const constraint of challenge.constraints) {
    if (constraint.type === "max_per_country") {
      let maxPossibleSquad = 0;
      const countryCounts = new Map<string, number>();
      for (const p of pool) {
        countryCounts.set(p.country, (countryCounts.get(p.country) || 0) + 1);
      }
      for (const [country, count] of countryCounts.entries()) {
        const cap = constraint.exceptions?.[country] ?? constraint.value;
        maxPossibleSquad += Math.min(cap, count);
      }
      if (maxPossibleSquad < 11) {
        return {
          isFeasible: false,
          validCombinationsFound: 0,
          reasons: [
            `Country constraints make 11-player squad impossible (maximum possible is ${maxPossibleSquad}).`,
          ],
        };
      }
    }

    if (constraint.type === "min_category") {
      let available = 0;
      if (constraint.category === "PACE") available = pool.filter((p) => p.bowling_category === "PACE").length;
      else if (constraint.category === "SPIN") available = pool.filter((p) => p.bowling_category === "SPIN").length;
      else if (constraint.category === "WK") available = keepers.length;
      else if (constraint.category === "AR") available = pool.filter((p) => p.primary_role === "AR").length;

      if (available < constraint.count) {
        return {
          isFeasible: false,
          validCombinationsFound: 0,
          reasons: [
            `Pool only has ${available} ${constraint.category} players, but ${constraint.count} required.`,
          ],
        };
      }
    }

    if (constraint.type === "batting_hand_order") {
      const handCount = pool.filter((p) => p.batting_hand === constraint.hand).length;
      if (handCount < constraint.positions.length) {
        return {
          isFeasible: false,
          validCombinationsFound: 0,
          reasons: [
            `Pool only has ${handCount} ${constraint.hand} batters, but ${constraint.positions.length} required for top order.`,
          ],
        };
      }
    }
  }

  // Heuristic Sorting: Sort players so most constrained slots (WK, rare roles) are tried first
  const sortedPool = [...pool].sort((a, b) => {
    // Keepers first
    if (a.primary_role === "WK" && b.primary_role !== "WK") return -1;
    if (b.primary_role === "WK" && a.primary_role !== "WK") return 1;
    // Bowlers/Allrounders second
    const aIsBowler = a.primary_role === "BOWL" || a.primary_role === "AR";
    const bIsBowler = b.primary_role === "BOWL" || b.primary_role === "AR";
    if (aIsBowler && !bIsBowler) return -1;
    if (bIsBowler && !aIsBowler) return 1;
    return 0;
  });

  // Necessary-condition pruning: every squad-level rule is a "need >= N players matching X".
  // Track how many matching players are selected and how many remain in the unexplored suffix;
  // a branch that can no longer reach any requirement is cut immediately instead of being
  // enumerated to a full 11 players. Keeps worst-case CPU tiny (Workers free plan: 10 ms).
  const requirements: { matches: (p: PlayerWithStats) => boolean; need: number }[] = [
    { matches: (p) => p.primary_role === "WK", need: 1 },
    {
      matches: (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0,
      need: 5,
    },
  ];
  for (const c of challenge.constraints) {
    if (c.type === "min_category") {
      const cat = c.category;
      requirements.push({
        matches: (p) =>
          cat === "PACE" ? p.bowling_category === "PACE"
          : cat === "SPIN" ? p.bowling_category === "SPIN"
          : cat === "WK" ? p.primary_role === "WK"
          : p.primary_role === "AR",
        need: c.count,
      });
    } else if (c.type === "batting_hand_order") {
      requirements.push({ matches: (p) => p.batting_hand === c.hand, need: c.positions.length });
    } else if (c.type === "min_bowlers_economy_under") {
      requirements.push({
        matches: (p) =>
          (p.primary_role === "BOWL" || p.primary_role === "AR") &&
          p.stats.bowl_economy > 0 &&
          p.stats.bowl_economy <= c.threshold,
        need: c.min_count,
      });
    } else if (c.type === "min_strike_rate_top_order") {
      requirements.push({ matches: (p) => p.stats.bat_strike_rate >= c.threshold, need: 2 });
    }
  }
  // suffixAvail[r][i] = players in sortedPool[i..] that satisfy requirement r
  const suffixAvail = requirements.map((r) => {
    const arr = new Array<number>(sortedPool.length + 1).fill(0);
    for (let i = sortedPool.length - 1; i >= 0; i--) arr[i] = arr[i + 1] + (r.matches(sortedPool[i]) ? 1 : 0);
    return arr;
  });
  const have = requirements.map(() => 0);

  let solutionsFound = 0;
  let sampleSquad: PlayerWithStats[] | undefined;
  const currentSelection: PlayerWithStats[] = [];

  // Track partial counts to prune branches early
  const countryUsage = new Map<string, number>();

  function getCountryCap(country: string): number {
    for (const c of challenge.constraints) {
      if (c.type === "max_per_country") {
        return c.exceptions?.[country] ?? c.value;
      }
    }
    return 11;
  }

  let nodesVisited = 0;
  let budgetExhausted = false;

  function backtrack(startIndex: number) {
    if (solutionsFound >= targetSolutions || budgetExhausted) return;
    if (++nodesVisited > maxNodes) {
      budgetExhausted = true;
      return;
    }

    // Prune if remaining pool cannot fill 11
    const needed = 11 - currentSelection.length;
    if (sortedPool.length - startIndex < needed) return;

    // Prune if any squad-level requirement is already unreachable
    for (let r = 0; r < requirements.length; r++) {
      const stillNeeded = requirements[r].need - have[r];
      if (stillNeeded > needed) return; // not enough open slots left to reach this quota
      if (stillNeeded > suffixAvail[r][startIndex]) return; // not enough matching players left
    }

    if (currentSelection.length === 11) {
      const result = validateSquad(currentSelection, challenge);
      if (result.valid) {
        solutionsFound++;
        if (!sampleSquad) {
          sampleSquad = [...currentSelection];
        }
      }
      return;
    }

    for (let i = startIndex; i < sortedPool.length; i++) {
      if (solutionsFound >= targetSolutions || budgetExhausted) return;

      const candidate = sortedPool[i];
      const curCountryCount = countryUsage.get(candidate.country) || 0;
      const maxCountry = getCountryCap(candidate.country);

      // Branch pruning: Country limit exceeded
      if (curCountryCount >= maxCountry) continue;

      // Choose
      currentSelection.push(candidate);
      countryUsage.set(candidate.country, curCountryCount + 1);
      for (let r = 0; r < requirements.length; r++) if (requirements[r].matches(candidate)) have[r]++;

      // Recurse
      backtrack(i + 1);

      // Unchoose
      currentSelection.pop();
      countryUsage.set(candidate.country, curCountryCount);
      for (let r = 0; r < requirements.length; r++) if (requirements[r].matches(candidate)) have[r]--;
    }
  }

  backtrack(0);

  const isFeasible = solutionsFound >= targetSolutions;
  if (!isFeasible) {
    reasons.push(
      budgetExhausted
        ? `Search budget of ${maxNodes} nodes exhausted after ${solutionsFound} valid combinations (minimum required: ${targetSolutions}). Challenge is too restrictive.`
        : `Only found ${solutionsFound} valid combinations (minimum required: ${targetSolutions}). Challenge is too restrictive.`
    );
  }

  return {
    isFeasible,
    validCombinationsFound: solutionsFound,
    sampleSquad,
    reasons,
    nodesVisited,
  };
}

/**
 * The user and the AI draft from one shared pool, so a challenge is only playable if two
 * disjoint legal XIs exist. Cheap necessary conditions run first (each team needs its own
 * keeper, bowlers, category and handedness quota, and the country caps must allow 22 players),
 * then one XI is searched for and removed from the pool and a second must still be found.
 * Passing guarantees two disjoint XIs exist (sufficient, not necessary). `maxNodes` is shared
 * across both searches so total CPU stays bounded.
 */
export function checkDraftFeasibility(
  pool: PlayerWithStats[],
  challenge: Challenge,
  targetSolutions = 50,
  maxNodes = DEFAULT_SEARCH_NODE_BUDGET
): FeasibilityResult {
  const fail = (reason: string): FeasibilityResult => ({
    isFeasible: false,
    validCombinationsFound: 0,
    reasons: [reason],
  });

  // --- Two-team necessary conditions (O(pool), no search) ---
  const isBowlingOption = (p: PlayerWithStats) =>
    p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0;
  if (pool.filter((p) => p.primary_role === "WK").length < 2) {
    return fail("Pool cannot support two disjoint XIs: fewer than 2 wicketkeepers.");
  }
  if (pool.filter(isBowlingOption).length < 10) {
    return fail("Pool cannot support two disjoint XIs: fewer than 10 bowling options.");
  }
  for (const c of challenge.constraints) {
    if (c.type === "min_category") {
      const available = pool.filter((p) =>
        c.category === "PACE" ? p.bowling_category === "PACE"
        : c.category === "SPIN" ? p.bowling_category === "SPIN"
        : c.category === "WK" ? p.primary_role === "WK"
        : p.primary_role === "AR"
      ).length;
      if (available < 2 * c.count) {
        return fail(`Pool cannot support two disjoint XIs: ${available} ${c.category} players, ${2 * c.count} needed.`);
      }
    } else if (c.type === "batting_hand_order") {
      const available = pool.filter((p) => p.batting_hand === c.hand).length;
      if (available < 2 * c.positions.length) {
        return fail(`Pool cannot support two disjoint XIs: ${available} ${c.hand} batters, ${2 * c.positions.length} needed.`);
      }
    } else if (c.type === "max_per_country") {
      const counts = new Map<string, number>();
      for (const p of pool) counts.set(p.country, (counts.get(p.country) || 0) + 1);
      let capacity = 0;
      for (const [country, count] of counts) {
        capacity += Math.min(2 * (c.exceptions?.[country] ?? c.value), count);
      }
      if (capacity < 22) {
        return fail(`Pool cannot support two disjoint XIs: country caps allow only ${capacity} of 22 players.`);
      }
    }
  }

  // --- Search ---
  // Strategy 1 (greedy): find an XI in the full pool, remove it, find a second from the rest.
  const first = checkChallengeFeasibility(pool, challenge, targetSolutions, maxNodes);
  if (!first.isFeasible || !first.sampleSquad) return first;

  let used = first.nodesVisited ?? 0;
  const takenIds = new Set(first.sampleSquad.map((p) => p.id));
  const remaining = pool.filter((p) => !takenIds.has(p.id));
  const second = checkChallengeFeasibility(remaining, challenge, 1, Math.max(2_000, maxNodes - used));
  used += second.nodesVisited ?? 0;
  if (second.isFeasible) return { ...first, nodesVisited: used };

  // Strategy 2 (dealt halves): the greedy XI may have hoarded a scarce role (e.g. both keepers).
  // Deal the pool like cards by role/category/hand/country so each half holds an even share of
  // every scarce group; an XI found in each half independently proves two disjoint XIs exist.
  const dealt = [...pool].sort(
    (a, b) =>
      a.primary_role.localeCompare(b.primary_role) ||
      a.bowling_category.localeCompare(b.bowling_category) ||
      a.batting_hand.localeCompare(b.batting_hand) ||
      a.country.localeCompare(b.country)
  );
  const halfA: PlayerWithStats[] = [];
  const halfB: PlayerWithStats[] = [];
  dealt.forEach((p, i) => (i % 2 === 0 ? halfA : halfB).push(p));
  const perHalf = Math.max(2_000, Math.floor((maxNodes - used) / 2));
  const resA = checkChallengeFeasibility(halfA, challenge, 1, perHalf);
  used += resA.nodesVisited ?? 0;
  if (resA.isFeasible) {
    const resB = checkChallengeFeasibility(halfB, challenge, 1, perHalf);
    used += resB.nodesVisited ?? 0;
    if (resB.isFeasible) return { ...first, nodesVisited: used };
  }

  return {
    isFeasible: false,
    validCombinationsFound: first.validCombinationsFound,
    sampleSquad: first.sampleSquad,
    reasons: [`Pool cannot support two disjoint XIs for a head-to-head draft: ${second.reasons.join("; ")}`],
    nodesVisited: used,
  };
}

export interface PickLegalityResult {
  allowed: boolean;
  reason?: string;
}

export interface PickContext {
  /** Players still available to both sides (may include the candidate). */
  pool: PlayerWithStats[];
  /**
   * The other side's current squad. Kept for callers that pass it; a pick is never refused because
   * it hurts the other side. If the pool runs dry of a required type, that rule is waived for
   * whoever can no longer meet it (see `rulesFor`).
   */
  opponentSquad?: (PlayerWithStats | null)[];
}

/**
 * Picks are players, not batting slots: the batting order is arranged automatically during the
 * draft (core/batting-order.ts) and set by the user once the draft is over. So legality only asks
 * whether the XI can still meet the squad rules: a keeper, five bowling options, the scenario rule
 * and the country cap.
 */
export interface Need {
  key: string;
  /** Plain-language name for messages, e.g. "a wicketkeeper", "pace bowlers". */
  label: string;
  required: number;
  matches: (p: PlayerWithStats) => boolean;
  /** True when the pool ran out of this type, so the rule no longer binds this side. */
  waived?: boolean;
}

export const isBowlingOption = (p: PlayerWithStats): boolean =>
  p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0;

const categoryMatcher = (cat: "PACE" | "SPIN" | "WK" | "AR") => (p: PlayerWithStats) =>
  cat === "PACE" ? p.bowling_category === "PACE"
  : cat === "SPIN" ? p.bowling_category === "SPIN"
  : cat === "WK" ? p.primary_role === "WK"
  : p.primary_role === "AR";

const CATEGORY_LABEL: Record<string, string> = { PACE: "pace bowlers", SPIN: "spinners", WK: "wicketkeepers", AR: "all-rounders" };

function countryCap(challenge: Challenge, country: string): number {
  let cap = Infinity;
  for (const c of challenge.constraints) {
    if (c.type === "max_per_country") cap = Math.min(cap, c.exceptions?.[country] ?? c.value);
  }
  return cap;
}

/**
 * The squad rules for one side. With `pool` given, a rule is capped at what the side can still
 * reach (what it has plus what the pool still offers under the country cap): when the other side
 * has taken every spinner, "at least 2 spinners" stops binding instead of blocking the draft.
 */
export function rulesFor(challenge: Challenge, mine: PlayerWithStats[] = [], pool?: PlayerWithStats[]): Need[] {
  const needs: Need[] = [
    { key: "WK", label: "a wicketkeeper", required: 1, matches: categoryMatcher("WK") },
    { key: "BOWL", label: "bowling options", required: 5, matches: isBowlingOption },
  ];
  for (const c of challenge.constraints) {
    if (c.type !== "min_category") continue;
    const existing = needs.find((n) => n.key === c.category);
    if (existing) existing.required = Math.max(existing.required, c.count);
    else needs.push({ key: c.category, label: CATEGORY_LABEL[c.category], required: c.count, matches: categoryMatcher(c.category) });
  }
  if (pool) {
    const counts = new Map<string, number>();
    for (const p of mine) counts.set(p.country, (counts.get(p.country) || 0) + 1);
    const ids = new Set(mine.map((p) => p.id));
    const open = pool.filter((p) => !ids.has(p.id) && (counts.get(p.country) || 0) < countryCap(challenge, p.country));
    for (const n of needs) {
      const reachable = mine.filter(n.matches).length + open.filter(n.matches).length;
      if (reachable < n.required) {
        n.required = reachable;
        n.waived = true;
      }
    }
  }
  return needs;
}

/** What is still missing, and how many of the remaining picks it must take at the least. */
function outstanding(needs: Need[], mine: PlayerWithStats[]): { missing: { need: Need; count: number }[]; demand: number } {
  const missing = needs
    .map((need) => ({ need, count: Math.max(0, need.required - mine.filter(need.matches).length) }))
    .filter((m) => m.count > 0);
  const of = (key: string) => missing.find((m) => m.need.key === key)?.count ?? 0;
  // Pace and spin are different players; bowling options and all-rounders can overlap with them.
  // Keepers almost never bowl, so they add on top.
  const demand = of("WK") + Math.max(of("BOWL"), of("PACE") + of("SPIN"), of("AR"));
  return { missing, demand };
}

const describeMissing = (missing: { need: Need; count: number }[]): string =>
  missing
    .map(({ need, count }) => (need.key === "WK" ? need.label : `${count} more ${count === 1 ? need.label.replace(/s$/, "").replace(/ options$/, " option") : need.label}`))
    .join(", ");

/**
 * Checks whether picking this player is legal. `targetSlotIndex` is accepted for older callers and
 * ignored: picks are final and never replace a player already in the squad.
 */
export function canPickPlayer(
  player: PlayerWithStats,
  currentSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  _targetSlotIndex?: number,
  ctx?: PickContext
): PickLegalityResult {
  const mine = currentSquad.filter((p): p is PlayerWithStats => p !== null);
  if (mine.length >= 11) return { allowed: false, reason: "Your XI is already full" };
  if (mine.some((p) => p.id === player.id)) return { allowed: false, reason: "Already in your XI" };

  const cap = countryCap(challenge, player.country);
  if (mine.filter((p) => p.country === player.country).length >= cap) {
    return { allowed: false, reason: `Country cap: at most ${cap} from ${player.country}` };
  }

  const after = [...mine, player];
  const poolAfter = ctx ? ctx.pool.filter((q) => q.id !== player.id) : undefined;
  const needs = rulesFor(challenge, after, poolAfter);
  const left = 11 - after.length;
  const { missing, demand } = outstanding(needs, after);
  if (demand > left) {
    const before = outstanding(rulesFor(challenge, mine, ctx?.pool), mine).missing;
    return { allowed: false, reason: `${left + 1} pick${left === 0 ? "" : "s"} left and you still need ${describeMissing(before)}` };
  }

  // Endgame: prove the XI can still be finished from what is left in the pool.
  if (poolAfter && left > 0 && left <= LOOKAHEAD_MAX_EMPTY && !canCompleteSquad(after, poolAfter, challenge)) {
    return { allowed: false, reason: `You couldn't finish a legal XI after this pick: you still need ${describeMissing(missing) || "players the pool no longer has"}` };
  }
  return { allowed: true };
}

/** Endgame lookahead only runs when this few picks remain (earlier, the cheap counting check is enough). */
const LOOKAHEAD_MAX_EMPTY = 5;
/** Cap on search steps per lookahead so worst-case CPU stays tiny (Workers free plan). */
const LOOKAHEAD_CALL_BUDGET = 4000;

/**
 * Can this squad still be completed into a legal XI using only `pool`? Searches combinations of
 * the remaining picks (order does not matter). Rules the pool can no longer meet are waived, as in
 * canPickPlayer. Returns true when the search budget runs out, so a pick is never blocked on a guess.
 */
export function canCompleteSquad(
  squad: (PlayerWithStats | null)[],
  pool: PlayerWithStats[],
  challenge: Challenge,
  callBudget = LOOKAHEAD_CALL_BUDGET
): boolean {
  const mine = squad.filter((p): p is PlayerWithStats => p !== null);
  const left = 11 - mine.length;
  if (left <= 0) return true;
  if (left > LOOKAHEAD_MAX_EMPTY) return true;
  const ids = new Set(mine.map((p) => p.id));
  const cands = pool.filter((p) => !ids.has(p.id));
  if (cands.length < left) return false;
  const needs = rulesFor(challenge, mine, cands);
  // Players who meet an outstanding need first, so a completion is found quickly
  const useful = (p: PlayerWithStats) => needs.filter((n) => n.matches(p)).length;
  cands.sort((a, b) => useful(b) - useful(a));

  const counts = new Map<string, number>();
  for (const p of mine) counts.set(p.country, (counts.get(p.country) || 0) + 1);
  const chosen = [...mine];
  let calls = 0;
  let exhausted = false;
  const fill = (start: number, remaining: number): boolean => {
    if (outstanding(needs, chosen).demand > remaining) return false;
    if (remaining === 0) return true;
    for (let i = start; i <= cands.length - remaining; i++) {
      if (++calls > callBudget) {
        exhausted = true;
        return true;
      }
      const c = cands[i];
      const n = counts.get(c.country) || 0;
      if (n >= countryCap(challenge, c.country)) continue;
      counts.set(c.country, n + 1);
      chosen.push(c);
      const ok = fill(i + 1, remaining - 1);
      chosen.pop();
      counts.set(c.country, n);
      if (ok || exhausted) return true;
    }
    return false;
  };
  return fill(0, left);
}

/** What one side still needs, for the UI's need chips. */
export function squadNeeds(
  squad: (PlayerWithStats | null)[],
  challenge: Challenge,
  pool?: PlayerWithStats[]
): { key: string; label: string; have: number; required: number; waived: boolean }[] {
  const mine = squad.filter((p): p is PlayerWithStats => p !== null);
  return rulesFor(challenge, mine, pool).map((n) => ({
    key: n.key,
    label: n.label,
    have: mine.filter(n.matches).length,
    required: n.required,
    waived: !!n.waived,
  }));
}
