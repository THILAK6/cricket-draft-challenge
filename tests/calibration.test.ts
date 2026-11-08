import { it } from "vitest";
import { writeFileSync } from "fs";
import { simulateCricketMatch, type InningsScorecard } from "../src/core/simulator";
import type { Challenge, MatchFormat, PlayerWithStats } from "../src/core/types";

// Run with: CALIBRATE=<output path> npx vitest run tests/calibration.test.ts
const out = process.env.CALIBRATE;
const N = Number(process.env.CALIBRATE_N ?? 1000);

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function squad(prefix: string, format: MatchFormat, r: () => number): PlayerWithStats[] {
  const range = (a: number, b: number) => a + (b - a) * r();
  const sr = format === "T20" ? [118, 150] : format === "ODI" ? [78, 100] : [42, 62];
  const avg = format === "TEST" ? [28, 52] : [24, 46];
  const econ = format === "T20" ? [7.0, 8.8] : format === "ODI" ? [4.5, 5.7] : [2.5, 3.5];
  // Bowling strike rate (balls per wicket) by format; bowling average follows from it and economy
  const bsr = format === "T20" ? [16, 24] : format === "ODI" ? [30, 45] : [50, 70];
  const overs = format === "T20" ? 300 : format === "ODI" ? 700 : 2000;
  const mk = (i: number, role: PlayerWithStats["primary_role"], cat: "NONE" | "PACE" | "SPIN"): PlayerWithStats => {
    const bowls = cat !== "NONE";
    const p = {
      id: `${prefix}${i}`, name: `${prefix}${i}`, country: "IND", batting_hand: r() < 0.25 ? "LHB" : "RHB", bowling_category: cat, primary_role: role,
      bowling_style: cat === "SPIN" ? "Off break" : cat === "PACE" ? "Right-arm fast" : "",
      stats: {
        player_id: `${prefix}${i}`, format, matches: 60, bat_innings: 50, bat_runs: 1500,
        bat_average: role === "BOWL" ? range(8, 18) : role === "AR" ? range(avg[0] - 4, avg[1] - 8) : range(avg[0], avg[1]),
        bat_strike_rate: range(sr[0], sr[1]) * (role === "BOWL" ? 0.8 : 1),
        top_order_innings: i < 4 ? 40 : 0, middle_order_innings: 15, finisher_innings: i === 5 ? 10 : 2,
        bowl_innings: bowls ? 50 : 0, bowl_overs: bowls ? overs : 0, bowl_wickets: 0, bowl_average: 0, bowl_economy: range(econ[0], econ[1]),
      },
    } as PlayerWithStats;
    if (bowls) {
      const sr = range(bsr[0], bsr[1]);
      p.stats.bowl_wickets = Math.round((overs * 6) / sr);
      p.stats.bowl_average = (sr * p.stats.bowl_economy) / 6;
    }
    return p;
  };
  return [mk(1, "BAT", "NONE"), mk(2, "BAT", "NONE"), mk(3, "BAT", "NONE"), mk(4, "BAT", "NONE"), mk(5, "WK", "NONE"), mk(6, "AR", "PACE"),
    mk(7, "AR", "SPIN"), mk(8, "BOWL", "PACE"), mk(9, "BOWL", "PACE"), mk(10, "BOWL", "SPIN"), mk(11, "BOWL", "SPIN")];
}

const PITCHES = ["GREEN_SEAMER", "DUSTBOWL", "HIGH_SCORING_FLAT", "SLOW_LOW"] as const;
const RANGES: Record<string, { total: [number, number]; pace?: [number, number]; spin?: [number, number] }> = {
  "T20": { total: [140, 185] }, "ODI": { total: [230, 300] }, "TEST": { total: [260, 380] },
};

(out ? it : it.skip)("calibration table", () => {
  const lines: string[] = [];
  lines.push(`Calibration: ${N} sims per pitch x format, synthetic mid-quality squads`);
  lines.push("format pitch               avg_inn  pace_wkt% spin_wkt%  caught% bowled%  lbw% runout% stumped%  flags");
  for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    for (const pitch of PITCHES) {
      const r = lcg(format.length * 7919 + pitch.length * 104729);
      let innTotal = 0, innCount = 0, pace = 0, spin = 0;
      const d = { caught: 0, bowled: 0, lbw: 0, runout: 0, stumped: 0 };
      const n = format === "TEST" ? Math.min(N, 300) : N;
      for (let k = 0; k < n; k++) {
        const u = squad("u", format, r), a = squad("a", format, r);
        const cat = new Map([...u, ...a].map((p) => [p.id, p.bowling_category]));
        const ch: Challenge = { id: "c", title: "t", format, venue: { name: "V", country: "IND", pitch_type: pitch }, narrative_intro: "", constraints: [] };
        const res = simulateCricketMatch(u, a, ch, k + 1);
        const inns: InningsScorecard[] = [res.userInnings, res.aiInnings, res.userSecondInnings, res.aiSecondInnings].filter((x): x is InningsScorecard => !!x);
        for (const inn of inns) {
          innTotal += inn.totalRuns; innCount++;
          for (const b of inn.batters) {
            if (!b.isOut) continue;
            const t = b.dismissal ?? "";
            if (t.startsWith("run out")) d.runout++;
            else if (t.startsWith("st ")) d.stumped++;
            else if (t.startsWith("lbw")) d.lbw++;
            else if (t.startsWith("b ")) d.bowled++;
            else d.caught++;
            if (b.bowlerId) { const c = cat.get(b.bowlerId); if (c === "PACE") pace++; else if (c === "SPIN") spin++; }
          }
        }
      }
      const wk = pace + spin, dis = d.caught + d.bowled + d.lbw + d.runout + d.stumped;
      const pct = (x: number, t: number) => (100 * x / Math.max(1, t));
      const avgInn = innTotal / Math.max(1, innCount);
      const flags: string[] = [];
      const [lo, hi] = RANGES[format].total;
      if (avgInn < lo || avgInn > hi) flags.push("total");
      const c = pct(d.caught, dis), bo = pct(d.bowled, dis), l = pct(d.lbw, dis), ro = pct(d.runout, dis), st = pct(d.stumped, dis);
      if (c < 52 || c > 72) flags.push("caught");
      if (bo < 10 || bo > 24) flags.push("bowled");
      if (l < 5 || l > 20) flags.push("lbw");
      if (ro > 7) flags.push("runout");
      const ps = pct(pace, wk);
      if (pitch === "GREEN_SEAMER" && ps < 60) flags.push("pace-share-low");
      if (pitch === "DUSTBOWL" && ps > 50) flags.push("spin-share-low");
      lines.push(`${format.padEnd(6)} ${pitch.padEnd(19)} ${avgInn.toFixed(0).padStart(6)}  ${ps.toFixed(0).padStart(8)} ${(100 - ps).toFixed(0).padStart(9)}  ${c.toFixed(0).padStart(7)} ${bo.toFixed(0).padStart(6)} ${l.toFixed(0).padStart(5)} ${ro.toFixed(1).padStart(6)} ${st.toFixed(1).padStart(8)}  ${flags.join(",") || "ok"}`);
    }
  }
  writeFileSync(out!, lines.join("\n") + "\n");
}, 600000);
