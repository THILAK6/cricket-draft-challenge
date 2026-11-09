import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { GROUNDS } from "../src/worker/scenario-generator";
import { chooseAiPick } from "../src/core/ai-draft";
import { arrangeSquad } from "../src/core/batting-order";
import { FORMAT_BASE, simulateCricketMatch } from "../src/core/simulator";
import { venuePar } from "../src/core/splits";
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
          const { pool, challenge } = await buildRandomDraft(d1, f, lcg(500 + k * 7));
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
