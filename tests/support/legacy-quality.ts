import type { PlayerWithStats } from "../../src/core/types";

/** Format-specific base quality from career stats only (no names, no reputation). */
export function legacyPlayerQuality(p: PlayerWithStats, format: string): number {
    const isTest = format === "TEST";
    const isOdi = format === "ODI";
    const isAR = p.primary_role === "AR";
    const isBat = p.primary_role === "BAT";
    const isWK = p.primary_role === "WK";
    const isBowl = p.primary_role === "BOWL";
    const matches = Math.max(1, p.stats.matches);
  let quality = 0;
  if (isTest) {
    // TEST: Batting average & resistance are king; Bowling average & wickets per match rule
    if (isBat || isWK || isAR) {
      const avg = p.stats.bat_average || 25;
      quality += Math.pow(Math.min(65, avg) / 38.0, 1.8) * 75;
      if (avg >= 50.0) quality += 40; // Platinum test batters (Smith, Root, Williamson)
      else if (avg >= 42.0) quality += 25;
    }
    if (isBowl || isAR) {
      const bowlAvg = p.stats.bowl_average || 35.0;
      const wpm = p.stats.bowl_wickets / matches;
      quality += (28.0 / Math.max(18.0, bowlAvg)) * 80 + Math.min(3.5, wpm) * 15;
      if (bowlAvg <= 24.0 && matches >= 15) quality += 40; // Elite test strike weapons (Bumrah, Cummins, Anderson)
    }
    // Test Experience / Caps resilience
    quality += Math.min(35, matches * 0.6);
  } else if (isOdi) {
    // ODI: High average + healthy strike rate + low economy
    if (isBat || isWK || isAR) {
      quality += (p.stats.bat_average / 38.0) * 55 + (p.stats.bat_strike_rate / 90.0) * 35;
      if (p.stats.bat_average >= 45.0) quality += 30;
    }
    if (isBowl || isAR) {
      const econ = p.stats.bowl_economy || 5.8;
      quality += (5.2 / Math.max(3.8, econ)) * 55 + (p.stats.bowl_wickets / matches) * 20;
      if (econ <= 4.8) quality += 25;
    }
    quality += Math.min(25, matches * 0.3);
  } else {
    // T20: Boundary hitting strike rate & death economy
    if (isBat || isWK || isAR) {
      quality += (p.stats.bat_strike_rate / 135.0) * 65 + (p.stats.bat_average / 30.0) * 35;
      if (p.stats.bat_strike_rate >= 145.0) quality += 30;
    }
    if (isBowl || isAR) {
      const econ = p.stats.bowl_economy || 8.0;
      quality += (7.6 / Math.max(5.8, econ)) * 55 + (p.stats.bowl_wickets / matches) * 20;
      if (econ <= 7.2) quality += 30;
    }
    quality += Math.min(20, matches * 0.25);
  }
    return quality;
  }
