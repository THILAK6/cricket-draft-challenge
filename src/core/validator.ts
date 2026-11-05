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

  // Slot-role rule (set level): need 2 opener-capable and 3 tail-capable players
  if (nonNullSquad.filter(isOpenerCapable).length < OPENER_SLOTS.length) {
    violations.push("Squad needs at least 2 specialist batters or keepers to open the innings.");
  }
  if (nonNullSquad.filter(isTailCapable).length < TAIL_SLOTS.length) {
    violations.push("Squad needs at least 3 bowlers or all-rounders for batting slots 9-11.");
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
    { matches: isOpenerCapable, need: OPENER_SLOTS.length },
    { matches: isTailCapable, need: TAIL_SLOTS.length },
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
  if (pool.filter(isOpenerCapable).length < 2 * OPENER_SLOTS.length) {
    return fail("Pool cannot support two disjoint XIs: fewer than 4 openers.");
  }
  if (pool.filter(isTailCapable).length < 2 * TAIL_SLOTS.length) {
    return fail("Pool cannot support two disjoint XIs: fewer than 6 bowlers or all-rounders for slots 9-11.");
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

/**
 * Checks in real time whether drafting this player is legal given the current
 * squad composition, remaining draft slots, and challenge constraints.
 */
export function canPickPlayer(
  player: PlayerWithStats,
  currentSquad: (PlayerWithStats | null)[],
  challenge: Challenge,
  targetSlotIndex?: number,
  ctx?: PickContext
): PickLegalityResult {
  const filledPlayers = currentSquad.filter((p): p is PlayerWithStats => p !== null);

  // 1. Full squad check
  const isReplacing =
    typeof targetSlotIndex === "number" &&
    targetSlotIndex >= 0 &&
    targetSlotIndex < currentSquad.length &&
    currentSquad[targetSlotIndex] !== null;

  if (filledPlayers.length >= 11 && !isReplacing) {
    return { allowed: false, reason: "Squad already full (11 players)" };
  }

  // 2. Duplicate player check
  const isDuplicate = currentSquad.some(
    (p, idx) => p !== null && p.id === player.id && idx !== targetSlotIndex
  );
  if (isDuplicate) {
    return { allowed: false, reason: "Player already in your squad" };
  }

  // 3. Country Limits (Hard Cap)
  const countryCounts = new Map<string, number>();
  for (let i = 0; i < currentSquad.length; i++) {
    const p = currentSquad[i];
    if (p && i !== targetSlotIndex) {
      countryCounts.set(p.country, (countryCounts.get(p.country) || 0) + 1);
    }
  }
  const curCountryCount = countryCounts.get(player.country) || 0;

  for (const constraint of challenge.constraints) {
    if (constraint.type === "max_per_country") {
      const maxAllowed = constraint.exceptions?.[player.country] ?? constraint.value;
      if (curCountryCount >= maxAllowed) {
        return {
          allowed: false,
          reason: `Country cap reached for ${player.country} (Max ${maxAllowed})`,
        };
      }
    }
  }

  // Determine slot index
  let slotIndex: number;
  if (typeof targetSlotIndex === "number" && targetSlotIndex >= 0 && targetSlotIndex < 11) {
    slotIndex = targetSlotIndex;
  } else {
    const nullIdx = currentSquad.findIndex((p) => p === null);
    if (nullIdx !== -1) {
      slotIndex = nullIdx;
    } else {
      slotIndex = currentSquad.length;
    }
  }

  const targetSlot = slotIndex + 1; // 1-based slot index (1 to 11)

  // 3b. Slot-role rules: openers must be batters/keepers, slots 9-11 bowlers/all-rounders
  if (OPENER_SLOTS.includes(slotIndex) && !isOpenerCapable(player)) {
    return { allowed: false, reason: `Slot ${targetSlot} needs a specialist batter or keeper to open` };
  }
  if (TAIL_SLOTS.includes(slotIndex) && !isTailCapable(player)) {
    return { allowed: false, reason: `Slot ${targetSlot} needs a bowler or all-rounder` };
  }

  // 4. Batting Hand Order (Slot-specific constraint)
  for (const constraint of challenge.constraints) {
    if (constraint.type === "batting_hand_order") {
      if (constraint.positions.includes(targetSlot)) {
        if (player.batting_hand !== constraint.hand) {
          return {
            allowed: false,
            reason: `Slot ${targetSlot} requires a ${constraint.hand} batter`,
          };
        }
      }
    }
  }

  // Remaining empty slots after this pick
  const remainingSlotsAfterThisPick = Math.max(
    0,
    11 - (filledPlayers.length + (isReplacing ? 0 : 1))
  );

  // Which empty slots can still take each kind of player (slot-role rules)
  const emptyAfter: number[] = [];
  for (let i = 0; i < 11; i++) {
    if (i === slotIndex) continue;
    if (!currentSquad[i]) emptyAfter.push(i);
  }
  const keeperSlots = emptyAfter.filter((i) => !TAIL_SLOTS.includes(i)).length; // keepers can't bat 9-11
  const bowlerSlots = emptyAfter.filter((i) => !OPENER_SLOTS.includes(i)).length; // bowlers can't open

  // 5. Critical Slot Guards (Pigeonhole principle on minimum required roles)
  const isWK = player.primary_role === "WK";
  const isBowler =
    player.primary_role === "BOWL" ||
    player.primary_role === "AR" ||
    player.stats.bowl_overs >= 2.0;

  // 5a. Wicketkeeper Guard
  const otherKeepers = currentSquad.filter(
    (p, idx) => p !== null && idx !== targetSlotIndex && p.primary_role === "WK"
  ).length;
  const keepersWithThisPick = otherKeepers + (isWK ? 1 : 0);
  const neededKeepers = Math.max(0, 1 - keepersWithThisPick);
  if (keeperSlots < neededKeepers) {
    return {
      allowed: false,
      reason: "Must pick a Wicketkeeper for remaining slot",
    };
  }

  // 5b. Bowling Options Guard (At least 5 bowling options required)
  const otherBowling = currentSquad.filter((p, idx) => {
    if (!p || idx === targetSlotIndex) return false;
    return (
      p.primary_role === "BOWL" ||
      p.primary_role === "AR" ||
      p.stats.bowl_overs >= 2.0
    );
  }).length;
  const bowlingWithThisPick = otherBowling + (isBowler ? 1 : 0);
  const neededBowlers = Math.max(0, 5 - bowlingWithThisPick);
  if (bowlerSlots < neededBowlers || neededKeepers + neededBowlers > remainingSlotsAfterThisPick) {
    return {
      allowed: false,
      reason: `Must pick a bowler (${5 - otherBowling} more needed for remaining slots)`,
    };
  }

  // 5c. Challenge min_category Guard
  for (const constraint of challenge.constraints) {
    if (constraint.type === "min_category") {
      let candidateMatches = false;
      if (constraint.category === "PACE" && player.bowling_category === "PACE") candidateMatches = true;
      if (constraint.category === "SPIN" && player.bowling_category === "SPIN") candidateMatches = true;
      if (constraint.category === "WK" && player.primary_role === "WK") candidateMatches = true;
      if (constraint.category === "AR" && player.primary_role === "AR") candidateMatches = true;

      const otherCatCount = currentSquad.filter((p, idx) => {
        if (!p || idx === targetSlotIndex) return false;
        if (constraint.category === "PACE") return p.bowling_category === "PACE";
        if (constraint.category === "SPIN") return p.bowling_category === "SPIN";
        if (constraint.category === "WK") return p.primary_role === "WK";
        if (constraint.category === "AR") return p.primary_role === "AR";
        return false;
      }).length;

      const catWithThisPick = otherCatCount + (candidateMatches ? 1 : 0);
      const neededCat = Math.max(0, constraint.count - catWithThisPick);
      // Keepers can't bat 9-11; bowling categories (PACE/SPIN/AR) can't open
      const slotsForCat = constraint.category === "WK" ? keeperSlots : bowlerSlots;
      if (slotsForCat < neededCat) {
        return {
          allowed: false,
          reason: `Must pick a ${constraint.category} player (${constraint.count - otherCatCount} needed for remaining slots)`,
        };
      }
    }
  }

  // 5c-joint. Competing needs share the same empty slots: add up what must still be filled.
  {
    const catNeeded = (cat: string) => {
      let best = 0;
      for (const c of challenge.constraints) {
        if (c.type !== "min_category" || c.category !== cat) continue;
        const matchesCat = (q: PlayerWithStats) =>
          cat === "PACE" ? q.bowling_category === "PACE"
          : cat === "SPIN" ? q.bowling_category === "SPIN"
          : cat === "WK" ? q.primary_role === "WK"
          : q.primary_role === "AR";
        const have =
          currentSquad.filter((q, idx) => q && idx !== slotIndex && idx !== targetSlotIndex && matchesCat(q)).length +
          (matchesCat(player) ? 1 : 0);
        best = Math.max(best, c.count - have);
      }
      return Math.max(0, best);
    };
    const keeperDemand = Math.max(neededKeepers, catNeeded("WK"));
    // PACE and SPIN players are different people; AR and bowling options can overlap with them
    const bowlerDemand = Math.max(neededBowlers, catNeeded("PACE") + catNeeded("SPIN"), catNeeded("AR"));
    if (
      keeperDemand > keeperSlots ||
      bowlerDemand > bowlerSlots ||
      keeperDemand + bowlerDemand > remainingSlotsAfterThisPick
    ) {
      return {
        allowed: false,
        reason: "That pick leaves too few open slots for the keeper, bowlers and categories you still need",
      };
    }
  }

  // 5d. At most two wicketkeepers in an XI (a second keeper must earn a place as a batter)
  if (keepersWithThisPick > 2) {
    return { allowed: false, reason: "At most 2 wicketkeepers allowed in an XI" };
  }

  // 6. Shared-pool reserve: both sides draw from one pool, so a pick must not leave
  // either side unable to fill its remaining required roles.
  if (ctx) {
    const reserve = checkPoolReserve(player, currentSquad, challenge, targetSlotIndex, slotIndex, ctx);
    if (reserve) return { allowed: false, reason: reserve };

    // Endgame lookahead: with only a few slots left, prove each side can still finish a legal XI.
    const poolAfter = ctx.pool.filter((q) => q.id !== player.id);
    const mineAfter = currentSquad.slice();
    mineAfter[slotIndex] = player;
    if (!canCompleteSquad(mineAfter, poolAfter, challenge)) {
      return { allowed: false, reason: "That pick would leave you unable to complete a legal XI from the remaining pool" };
    }
    if (!canCompleteSquad(ctx.opponentSquad, poolAfter, challenge)) {
      return { allowed: false, reason: "That pick would leave your opponent unable to complete a legal XI from the remaining pool" };
    }
  }

  return { allowed: true };
}

export interface PickContext {
  /** Players still available to both sides (may include the candidate). */
  pool: PlayerWithStats[];
  /** The other side's current squad. */
  opponentSquad: (PlayerWithStats | null)[];
}

interface RoleNeed {
  label: string;
  required: number;
  matches: (p: PlayerWithStats) => boolean;
}

function roleNeeds(challenge: Challenge): RoleNeed[] {
  const needs: RoleNeed[] = [
    { label: "Wicketkeeper", required: 1, matches: (p) => p.primary_role === "WK" },
    {
      label: "bowling option",
      required: 5,
      matches: (p) => p.primary_role === "BOWL" || p.primary_role === "AR" || p.stats.bowl_overs >= 2.0,
    },
  ];
  for (const c of challenge.constraints) {
    if (c.type !== "min_category") continue;
    needs.push({
      label: c.category,
      required: c.count,
      matches: (p) =>
        c.category === "PACE" ? p.bowling_category === "PACE"
        : c.category === "SPIN" ? p.bowling_category === "SPIN"
        : c.category === "WK" ? p.primary_role === "WK"
        : p.primary_role === "AR",
    });
  }
  return needs;
}

function countryCap(challenge: Challenge, country: string): number {
  let cap = Infinity;
  for (const c of challenge.constraints) {
    if (c.type === "max_per_country") cap = Math.min(cap, c.exceptions?.[country] ?? c.value);
  }
  return cap;
}

/** Returns a reason string if the pick would strand either side, otherwise null. */
function checkPoolReserve(
  player: PlayerWithStats,
  squad: (PlayerWithStats | null)[],
  challenge: Challenge,
  replacedIndex: number | undefined,
  slotIndex: number,
  ctx: PickContext
): string | null {
  const mine = squad.filter((p, i): p is PlayerWithStats => p !== null && i !== replacedIndex);
  mine.push(player);
  const theirs = ctx.opponentSquad.filter((p): p is PlayerWithStats => p !== null);
  const pool = ctx.pool.filter((p) => p.id !== player.id);

  const eligibleFor = (squadPlayers: PlayerWithStats[], need: RoleNeed) => {
    const counts = new Map<string, number>();
    for (const p of squadPlayers) counts.set(p.country, (counts.get(p.country) || 0) + 1);
    return pool.filter((p) => need.matches(p) && (counts.get(p.country) || 0) < countryCap(challenge, p.country)).length;
  };

  for (const need of roleNeeds(challenge)) {
    const myNeed = Math.max(0, need.required - mine.filter(need.matches).length);
    const theirNeed = Math.max(0, need.required - theirs.filter(need.matches).length);
    if (myNeed > 0 && eligibleFor(mine, need) < myNeed) {
      return `Taking this player would leave too few ${need.label} options in the pool for your squad`;
    }
    if (theirNeed > 0 && eligibleFor(theirs, need) < theirNeed) {
      return `Taking this player would leave too few ${need.label} options in the pool for your opponent`;
    }
    if (myNeed + theirNeed > 0 && pool.filter(need.matches).length < myNeed + theirNeed) {
      return `Not enough ${need.label} options left in the pool for both squads`;
    }
  }

  // Slot groups: every empty opener / tail slot needs a capable player left in the pool.
  const mineSlots = squad.slice();
  mineSlots[slotIndex] = player;
  const groups: { label: string; slots: number[]; capable: (p: PlayerWithStats) => boolean }[] = [
    { label: "opener", slots: OPENER_SLOTS, capable: isOpenerCapable },
    { label: "tail-end bowler", slots: TAIL_SLOTS, capable: isTailCapable },
  ];
  for (const g of groups) {
    const empties = (sl: (PlayerWithStats | null)[]) => g.slots.filter((i) => !sl[i]).length;
    const myEmpty = empties(mineSlots);
    const theirEmpty = empties(ctx.opponentSquad);
    const need: RoleNeed = { label: g.label, required: 0, matches: g.capable };
    if (myEmpty > 0 && eligibleFor(mine, need) < myEmpty) {
      return `Taking this player would leave too few ${g.label} options in the pool for your squad`;
    }
    if (theirEmpty > 0 && eligibleFor(theirs, need) < theirEmpty) {
      return `Taking this player would leave too few ${g.label} options in the pool for your opponent`;
    }
    if (myEmpty + theirEmpty > 0 && pool.filter(g.capable).length < myEmpty + theirEmpty) {
      return `Not enough ${g.label} options left in the pool for both squads`;
    }
  }
  return null;
}

/** Endgame lookahead only runs when this few slots remain (earlier, the cheap guards are enough). */
const LOOKAHEAD_MAX_EMPTY = 5;
/** Cap on canPickPlayer calls per lookahead so worst-case CPU stays tiny (Workers free plan). */
const LOOKAHEAD_CALL_BUDGET = 600;

/**
 * Can this squad still be completed into a fully valid XI using only `pool`?
 * Exact depth-first fill of the empty slots, most constrained slots first. Returns true when the
 * search budget runs out (unknown is treated as feasible so a pick is never blocked on a guess).
 */
export function canCompleteSquad(
  squad: (PlayerWithStats | null)[],
  pool: PlayerWithStats[],
  challenge: Challenge,
  callBudget = LOOKAHEAD_CALL_BUDGET
): boolean {
  const work = squad.slice();
  while (work.length < 11) work.push(null);
  const empties = work.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  if (empties.length === 0) return validateSquad(work, challenge).valid;
  if (empties.length > LOOKAHEAD_MAX_EMPTY) return true;

  // Most constrained slots first: hand-order slots, openers, tail, then the middle
  const handSlots = new Set<number>();
  for (const c of challenge.constraints) {
    if (c.type === "batting_hand_order") for (const pos of c.positions) handSlots.add(pos - 1);
  }
  const rank = (i: number) => (handSlots.has(i) ? 0 : OPENER_SLOTS.includes(i) ? 1 : TAIL_SLOTS.includes(i) ? 2 : 3);
  empties.sort((a, b) => rank(a) - rank(b));

  let calls = 0;
  let exhausted = false;
  const used = new Set(work.filter((p): p is PlayerWithStats => p !== null).map((p) => p.id));

  const fill = (k: number): boolean => {
    if (k === empties.length) return validateSquad(work, challenge).valid;
    const slot = empties[k];
    for (const cand of pool) {
      if (used.has(cand.id)) continue;
      if (++calls > callBudget) {
        exhausted = true;
        return true;
      }
      if (!canPickPlayer(cand, work, challenge, slot).allowed) continue;
      work[slot] = cand;
      used.add(cand.id);
      const ok = fill(k + 1);
      work[slot] = null;
      used.delete(cand.id);
      if (ok) return true;
      if (exhausted) return true;
    }
    return false;
  };
  return fill(0);
}
