import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { GROUNDS } from "../src/worker/scenario-generator";
import { chooseAiPick } from "../src/core/ai-draft";
import { arrangeSquad } from "../src/core/batting-order";
import { FORMAT_BASE, TUNE, simulateCricketMatch } from "../src/core/simulator";
import { venuePar } from "../src/core/splits";
import { playerQuality } from "../src/core/player-quality";
import { DATA_NORMS } from "../src/core/data-norms.generated";
import { snakeOrder, type Challenge, type MatchFormat, type PlayerWithStats } from "../src/core/types";

// Audit: does the engine score like the real ground? Run with: AUDIT=<file> AUDIT_POOLS=<n> AUDIT_FORMATS=T20,ODI npx vitest run tests/scoring-audit.test.ts
const out = process.env.AUDIT;
const POOLS = Number(process.env.AUDIT_POOLS ?? 4);
const FORMATS = (process.env.AUDIT_FORMATS ?? "T20,ODI,TEST").split(",") as MatchFormat[];

type Squad = (PlayerWithStats | null)[];
function draft(pool: PlayerWithStats[], challenge: Challenge, f: MatchFormat) {
  let rest = [...pool];
  const u: Squad = Array(11).fill(null), a: Squad = Array(11).fill(null);
  snakeOrder("USER").forEach((by, i) => {
    const mine = by === "USER" ? u : a;
    const p = chooseAiPick({ pool: rest, squad: mine, opponentSquad: by === "USER" ? a : u, challenge, difficulty: "normal", noiseSeed: i, round: i })!.player;
    mine[mine.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
  });
  return [arrangeSquad(u, f), arrangeSquad(a, f)] as const;
}

it.skipIf(!out)("scores like the real ground", async () => {
  // Sweeps: scale the Test base rates (TEST_RPB, TEST_WKT multipliers)
  if (process.env.TUNE_WEAR3) TUNE.wearThird = Number(process.env.TUNE_WEAR3);
  if (process.env.TUNE_WEAR4) TUNE.wearFourth = Number(process.env.TUNE_WEAR4);
  if (process.env.TUNE_CHASE_RUNS) TUNE.chaseRuns = Number(process.env.TUNE_CHASE_RUNS);
  if (process.env.TUNE_CHASE_ONE) TUNE.chaseBehindOnly = Number(process.env.TUNE_CHASE_ONE);
  if (process.env.TUNE_CHASE_WKT) TUNE.chaseWkt = Number(process.env.TUNE_CHASE_WKT);
  if (process.env.TEST_RPB) FORMAT_BASE.TEST.rpb *= Number(process.env.TEST_RPB);
  if (process.env.TEST_WKT) FORMAT_BASE.TEST.wkt *= Number(process.env.TEST_WKT);
  const lines: string[] = ["format | ground | pitch | real par (matches) | engine mean (innings) | ratio", "---|---|---|---|---|---"];
  const byPitch: Record<string, number[]> = {};
  const byFormat: Record<string, number[]> = {};
  const rows: string[] = [];
  // Every innings, in the order it was played, against the real Full Member numbers
  const inn: Record<string, { n: number; runs: number; balls: number; allOut: number; declared: number }[]> = {};
  const res: Record<string, { m: number; draws: number; ties: number; batFirstWins: number; decisive: number }> = {};
  for (const f of FORMATS) {
    const { challenge: base, pool: p0 } = await buildRandomDraft(d1, f, lcg(1));
    void p0;
    for (const g of GROUNDS.filter((g) => g.formats.includes(f))) {
      const real = venuePar(f, g.name);
      const perPitch: number[] = [];
      for (const pitch of g.pitches) {
        const runs: number[] = [];
        for (let k = 0; k < POOLS; k++) {
          let { pool, challenge } = await buildRandomDraft(d1, f, lcg(500 + k * 7));
          // AUDIT_MID: leave out the best 40% of the pool, so the XIs are ordinary international regulars
          if (process.env.AUDIT_MID) pool = [...pool].sort((a, b) => playerQuality(a, f) - playerQuality(b, f)).slice(0, Math.floor(pool.length * 0.6));
          const ch: Challenge = { ...base, ...challenge, venue: { name: g.name, country: g.country, pitch_type: pitch } };
          const [u, a] = draft(pool, ch, f);
          for (let s = 0; s < 2; s++) {
            const r = simulateCricketMatch(u, a, ch, 100 * k + s);
            const userFirst = (r.toss.decision === "BAT") === (r.toss.winner === "USER");
            const first = userFirst ? [r.userInnings, r.aiInnings, r.userSecondInnings, r.aiSecondInnings] : [r.aiInnings, r.userInnings, r.aiSecondInnings, r.userSecondInnings];
            first.filter((i) => i && i.totalBalls > 0).forEach((i, idx) => {
              const st = ((inn[f] ??= [])[idx] ??= { n: 0, runs: 0, balls: 0, allOut: 0, declared: 0 });
              st.n++;
              st.runs += i!.totalRuns;
              st.balls += i!.totalBalls;
              if (i!.totalWickets >= 10) st.allOut++;
              if (i!.declared) st.declared++;
            });
            const R = (res[f] ??= { m: 0, draws: 0, ties: 0, batFirstWins: 0, decisive: 0 });
            R.m++;
            if (r.winner === "DRAW") R.draws++;
            else if (r.winner === "TIE") R.ties++;
            else {
              R.decisive++;
              if ((r.winner === "USER") === userFirst) R.batFirstWins++;
            }
            runs.push((userFirst ? r.userInnings : r.aiInnings).totalRuns);
          }
        }
        const mean = runs.reduce((x, y) => x + y, 0) / runs.length;
        perPitch.push(mean);
        (byPitch[`${f} ${pitch}`] ??= []).push(real ? mean / real.avg : NaN);
        rows.push(`${f} | ${g.short} | ${pitch} | ${real ? `${real.avg} (${real.matches})` : "-"} | ${mean.toFixed(0)} | ${real ? (mean / real.avg).toFixed(2) : "-"}`);
      }
      if (real) (byFormat[f] ??= []).push(perPitch.reduce((x, y) => x + y, 0) / perPitch.length / real.avg);
    }
  }
  const avg = (xs: number[]) => xs.filter((x) => Number.isFinite(x)).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter((x) => Number.isFinite(x)).length);
  const norms = DATA_NORMS as any;
  const inningsLines: string[] = ["", "By innings (engine v real Full Member): runs | overs | all out % | declared %"];
  for (const f of FORMATS)
    (inn[f] ?? []).forEach((st, idx) => {
      const real = norms[f].innings[idx];
      if (!real) return;
      inningsLines.push(`  ${f} innings ${idx + 1}: engine ${(st.runs / st.n).toFixed(0)} | ${(st.balls / st.n / 6).toFixed(1)} | ${((st.allOut / st.n) * 100).toFixed(0)} | ${((st.declared / st.n) * 100).toFixed(0)}   real ${real.runs} | ${real.overs} | ${real.allOut} | ${real.declared}   (engine n=${st.n})`);
    });
  for (const f of FORMATS) {
    const R = res[f], real = norms[f].results;
    if (!R) continue;
    inningsLines.push(`  ${f} results: engine draws ${((R.draws / R.m) * 100).toFixed(1)}% ties ${((R.ties / R.m) * 100).toFixed(1)}% batting first wins ${((R.batFirstWins / Math.max(1, R.decisive)) * 100).toFixed(1)}%   real draws ${((real.draws / real.matches) * 100).toFixed(1)}% ties ${((real.ties / real.matches) * 100).toFixed(1)}% batting first wins ${((real.batFirstWins / Math.max(1, real.decisive)) * 100).toFixed(1)}%`);
  }
  lines.push(...rows, ...inningsLines, "", "Mean engine/real by format: " + Object.entries(byFormat).map(([k, v]) => `${k} ${avg(v).toFixed(2)}`).join(", "), "", "Mean engine/real by pitch:", ...Object.entries(byPitch).map(([k, v]) => `  ${k}: ${avg(v).toFixed(2)} (n=${v.filter(Number.isFinite).length})`));
  writeFileSync(out!, lines.join("\n"));
}, 3_000_000);

// The IPL: AUDIT_IPL=<file> AUDIT_POOLS=<n> npx vitest run tests/scoring-audit.test.ts
const outIpl = process.env.AUDIT_IPL;
it.skipIf(!outIpl)("the IPL scores like the real league", async () => {
  if (process.env.TUNE_IPL_RPB) TUNE.iplRpb = Number(process.env.TUNE_IPL_RPB);
  if (process.env.TUNE_IPL_WKT) TUNE.iplWkt = Number(process.env.TUNE_IPL_WKT);
  if (process.env.TUNE_IPL_CR) TUNE.iplChaseRuns = Number(process.env.TUNE_IPL_CR);
  if (process.env.TUNE_IPL_CW) TUNE.iplChaseWkt = Number(process.env.TUNE_IPL_CW);
  const { IPL_GROUNDS } = await import("../src/core/ipl-grounds");
  const { IPL_NORMS } = await import("../src/core/data-norms-ipl.generated");
  const norms = IPL_NORMS as any;
  const lines: string[] = ["ground | pitch | real par (matches) | engine mean | ratio", "---|---|---|---|---"];
  const first: number[] = [], second: number[] = [], allOut = [0, 0], n = [0, 0], balls = [0, 0];
  let bfWins = 0, decisive = 0;
  const byPitch: Record<string, number[]> = {};
  const ratios: number[] = [];
  for (const g of IPL_GROUNDS) {
    const real = venuePar("T20", g.name, "IPL");
    const per: number[] = [];
    for (const pitch of g.pitches) {
      const runs: number[] = [];
      for (let k = 0; k < POOLS; k++) {
        const { pool, challenge } = await buildRandomDraft(d1, "T20", lcg(900 + k * 11), "ipl-all", "IPL");
        const ch: Challenge = { ...challenge, venue: { name: g.name, country: g.country, pitch_type: pitch } };
        const [u, a] = draft(pool, ch, "T20");
        for (let s = 0; s < 2; s++) {
          const r = simulateCricketMatch(u, a, ch, 100 * k + s);
          const userFirst = (r.toss.decision === "BAT") === (r.toss.winner === "USER");
          const [f, c] = userFirst ? [r.userInnings, r.aiInnings] : [r.aiInnings, r.userInnings];
          runs.push(f.totalRuns);
          first.push(f.totalRuns); second.push(c.totalRuns);
          [f, c].forEach((i, idx) => { n[idx]++; balls[idx] += i.totalBalls; if (i.totalWickets >= 10) allOut[idx]++; });
          if (r.winner === "USER" || r.winner === "AI") { decisive++; if ((r.winner === "USER") === userFirst) bfWins++; }
        }
      }
      const mean = runs.reduce((x, y) => x + y, 0) / runs.length;
      per.push(mean);
      (byPitch[pitch] ??= []).push(real ? mean / real.avg : NaN);
      lines.push(`${g.short} | ${pitch} | ${real ? `${real.avg} (${real.matches})` : "-"} | ${mean.toFixed(0)} | ${real ? (mean / real.avg).toFixed(2) : "-"}`);
    }
    if (real) ratios.push(per.reduce((x, y) => x + y, 0) / per.length / real.avg);
  }
  const avg = (xs: number[]) => xs.filter(Number.isFinite).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter(Number.isFinite).length);
  const pct = (x: number, t: number) => ((x / Math.max(1, t)) * 100).toFixed(0);
  lines.push("", `Mean engine/real par over grounds: ${avg(ratios).toFixed(2)}`, "By pitch: " + Object.entries(byPitch).map(([k, v]) => `${k} ${avg(v).toFixed(2)}`).join(", "));
  lines.push(`First innings: engine ${(first.reduce((a, b) => a + b, 0) / first.length).toFixed(0)} in ${(balls[0] / n[0] / 6).toFixed(1)} ov, all out ${pct(allOut[0], n[0])}%  | real ${norms.innings[0].runs} in ${norms.innings[0].overs} ov, all out ${norms.innings[0].allOut.toFixed(0)}%`);
  lines.push(`Chasing: engine ${(second.reduce((a, b) => a + b, 0) / second.length).toFixed(0)} in ${(balls[1] / n[1] / 6).toFixed(1)} ov, all out ${pct(allOut[1], n[1])}%  | real ${norms.innings[1].runs} in ${norms.innings[1].overs} ov, all out ${norms.innings[1].allOut.toFixed(0)}%`);
  lines.push(`Batting first wins: engine ${pct(bfWins, decisive)}% | real ${((norms.results.batFirstWins / norms.results.decisive) * 100).toFixed(1)}%`);
  writeFileSync(outIpl!, lines.join("\n"));
}, 3_000_000);
