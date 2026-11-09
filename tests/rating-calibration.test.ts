import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1 } from "./support/db";
import { getPlayerPool, FULL_MEMBERS } from "../src/worker/challenge-generator";
import { battingRaw, bowlingRaw } from "../src/core/player-quality";
import type { MatchFormat } from "../src/core/types";

// Prints the calibration anchors for player-quality.ts. Run with: RATING_CAL=<file> npx vitest run tests/rating-calibration.test.ts
const out = process.env.RATING_CAL;
it.skipIf(!out)("derives rating calibration anchors", async () => {
  const lines: string[] = [];
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    const pool = (await getPlayerPool(d1, f, 2000, 15)).filter((p) => FULL_MEMBERS.has(p.country));
    const bat = pool.filter((p) => p.primary_role !== "BOWL").map((p) => battingRaw(p, f));
    const bowl = pool.filter((p) => p.primary_role === "BOWL" || p.primary_role === "AR").map((p) => bowlingRaw(p, f)).filter((v) => v > 0);
    lines.push(`  ${f}: { bat: [${q(bat, 0.2).toFixed(3)}, ${q(bat, 0.98).toFixed(3)}], bowl: [${q(bowl, 0.2).toFixed(3)}, ${q(bowl, 0.98).toFixed(3)}] },  // n=${bat.length}/${bowl.length}`);
  }
  writeFileSync(out!, lines.join("\n"));
});

// The IPL pool: its own anchors (CALIBRATION_IPL). Run with: RATING_CAL_IPL=<file> npx vitest run tests/rating-calibration.test.ts
const outIpl = process.env.RATING_CAL_IPL;
it.skipIf(!outIpl)("derives the IPL rating anchors", async () => {
  const pool = await getPlayerPool(d1, "T20", 2000, 20, "IPL");
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const bat = pool.filter((p) => p.primary_role !== "BOWL").map((p) => battingRaw(p, "T20"));
  const bowl = pool.filter((p) => p.primary_role === "BOWL" || p.primary_role === "AR").map((p) => bowlingRaw(p, "T20")).filter((v) => v > 0);
  writeFileSync(outIpl!, `  bat: [${q(bat, 0.2).toFixed(3)}, ${q(bat, 0.98).toFixed(3)}], bowl: [${q(bowl, 0.2).toFixed(3)}, ${q(bowl, 0.98).toFixed(3)}],  // n=${bat.length}/${bowl.length}`);
});
