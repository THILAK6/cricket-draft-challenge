import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { GROUNDS } from "../src/worker/scenario-generator";
import { chooseAiPick } from "../src/core/ai-draft";
import { arrangeSquad } from "../src/core/batting-order";
import { simulateCricketMatch } from "../src/core/simulator";
import { venuePar } from "../src/core/splits";
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
  const lines: string[] = ["format | ground | pitch | real par (matches) | engine mean (innings) | ratio", "---|---|---|---|---|---"];
  const byPitch: Record<string, number[]> = {};
  const byFormat: Record<string, number[]> = {};
  const rows: string[] = [];
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
  lines.push(...rows, "", "Mean engine/real by format: " + Object.entries(byFormat).map(([k, v]) => `${k} ${avg(v).toFixed(2)}`).join(", "), "", "Mean engine/real by pitch:", ...Object.entries(byPitch).map(([k, v]) => `  ${k}: ${avg(v).toFixed(2)} (n=${v.filter(Number.isFinite).length})`));
  writeFileSync(out!, lines.join("\n"));
}, 3_000_000);
