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
}

/**
 * Validates whether an individual 11-player squad satisfies all cricket rules
 * and challenge-specific constraints.
 */
export function validateSquad(squad: PlayerWithStats[], challenge: Challenge): SquadValidationResult {
  const violations: string[] = [];

  // 1. Cricket Fundamental Rules
  if (squad.length !== 11) {
    violations.push(`Squad must contain exactly 11 players (currently ${squad.length}).`);
  }

  // Duplicate player check
  const playerIds = new Set(squad.map((p) => p.id));
  if (playerIds.size !== squad.length) {
    violations.push("Squad contains duplicate players.");
  }

  // Wicketkeeper rule: At least 1 WK
  const keepers = squad.filter((p) => p.primary_role === "WK");
  if (keepers.length < 1) {
    violations.push("Squad must have at least 1 designated wicketkeeper.");
  }

  // Bowling rule: At least 5 bowling options (BOWL or AR, or >= 2 overs per match)
  const bowlingOptions = squad.filter(
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
        for (const p of squad) {
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
          count = squad.filter((p) => p.bowling_category === "PACE").length;
        } else if (constraint.category === "SPIN") {
          count = squad.filter((p) => p.bowling_category === "SPIN").length;
        } else if (constraint.category === "WK") {
          count = squad.filter((p) => p.primary_role === "WK").length;
        } else if (constraint.category === "AR") {
          count = squad.filter((p) => p.primary_role === "AR").length;
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
        const matchingHandPlayers = squad.filter((p) => p.batting_hand === constraint.hand);
        const requiredCount = constraint.positions.length;
        if (matchingHandPlayers.length < requiredCount) {
          violations.push(
            `Requires at least ${requiredCount} ${constraint.hand} batters for positions ${constraint.positions.join(",")}, but only ${matchingHandPlayers.length} in squad.`
          );
        }
        break;
      }

      case "min_bowlers_economy_under": {
        const qualifyingBowlers = squad.filter(
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
        const highSrBatters = squad.filter(
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
 * Fast backtracking constraint satisfaction checker.
 * Explores combination tree to guarantee at least `targetSolutions` (default: 50)
 * valid 11-player squads can be formed from the pool.
 */
export function checkChallengeFeasibility(
  pool: PlayerWithStats[],
  challenge: Challenge,
  targetSolutions = 50
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

  function backtrack(startIndex: number) {
    if (solutionsFound >= targetSolutions) return;

    // Prune if remaining pool cannot fill 11
    const needed = 11 - currentSelection.length;
    if (sortedPool.length - startIndex < needed) return;

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
      if (solutionsFound >= targetSolutions) return;

      const candidate = sortedPool[i];
      const curCountryCount = countryUsage.get(candidate.country) || 0;
      const maxCountry = getCountryCap(candidate.country);

      // Branch pruning: Country limit exceeded
      if (curCountryCount >= maxCountry) continue;

      // Choose
      currentSelection.push(candidate);
      countryUsage.set(candidate.country, curCountryCount + 1);

      // Recurse
      backtrack(i + 1);

      // Unchoose
      currentSelection.pop();
      countryUsage.set(candidate.country, curCountryCount);
    }
  }

  backtrack(0);

  const isFeasible = solutionsFound >= targetSolutions;
  if (!isFeasible) {
    reasons.push(
      `Only found ${solutionsFound} valid combinations (minimum required: ${targetSolutions}). Challenge is too restrictive.`
    );
  }

  return {
    isFeasible,
    validCombinationsFound: solutionsFound,
    sampleSquad,
    reasons,
  };
}

