import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { chooseAiPick } from "../src/core/ai-draft";
import { arrangeSquad } from "../src/core/batting-order";
import { simulateCricketMatch } from "../src/core/simulator";
import { buildHeadToHead, unitDiffs } from "../src/core/match-review";
import { snakeOrder, type Challenge, type MatchFormat, type PlayerWithStats } from "../src/core/types";

// Fits ROW_WEIGHTS. Run with: H2H_CAL=<file> H2H_PAIRS=<n> npx vitest run tests/h2h-calibration.test.ts
const out = process.env.H2H_CAL;
const PAIRS = Number(process.env.H2H_PAIRS ?? 240);
const REPLAYS = Number(process.env.H2H_REPLAYS ?? 30);
type Squad = (PlayerWithStats | null)[];
type Diff = "easy" | "normal" | "hard";

function draft(pool: PlayerWithStats[], challenge: Challenge, f: MatchFormat, du: Diff, da: Diff) {
  let rest = [...pool];
  const u: Squad = Array(11).fill(null), a: Squad = Array(11).fill(null);
  snakeOrder("USER").forEach((by, i) => {
    const mine = by === "USER" ? u : a;
    const p = chooseAiPick({ pool: rest, squad: mine, opponentSquad: by === "USER" ? a : u, challenge, difficulty: by === "USER" ? du : da, noiseSeed: i, round: i })!.player;
    mine[mine.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
  });
  return [arrangeSquad(u, f), arrangeSquad(a, f)] as const;
}

/** Ridge regression, small enough for normal equations. */
function ridge(X: number[][], y: number[], lambda: number): number[] {
  const n = X[0].length;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? lambda : 0)));
  const b = Array.from({ length: n }, (_, i) => X.reduce((s, r, k) => s + r[i] * y[k], 0));
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) x[i] = (b[i] - A[i].slice(i + 1).reduce((s, v, k) => s + v * x[i + 1 + k], 0)) / A[i][i];
  return x;
}
const corr = (xs: number[], ys: number[]) => {
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => ((sxy += (x - mx) * (ys[i] - my)), (sxx += (x - mx) ** 2), (syy += (ys[i] - my) ** 2)));
  return sxy / Math.sqrt(sxx * syy);
};

it.skipIf(!out)("fits the head-to-head weights", async () => {
  const lines: string[] = [];
  const levels: Diff[] = ["easy", "normal", "hard"];
  for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    const keys: string[] = [];
    const X: number[][] = [], y: number[] = [], tally: number[] = [];
    for (let k = 0; k < PAIRS; k++) {
      const { pool, challenge } = await buildRandomDraft(d1, f, lcg(9000 + k * 13));
      const [u, a] = draft(pool, challenge, f, levels[k % 3], levels[Math.floor(k / 3) % 3]);
      const d = unitDiffs(u, a, challenge);
      if (!keys.length) keys.push(...Object.keys(d));
      let score = 0;
      for (let s = 0; s < REPLAYS; s++) {
        const r = simulateCricketMatch(u, a, challenge, 31 * k + s);
        score += r.winner === "USER" ? 1 : r.winner === "AI" ? 0 : 0.5;
      }
      X.push(keys.map((key) => (d as any)[key] ?? 0));
      y.push(score / REPLAYS - 0.5);
      const h = buildHeadToHead(u, a, challenge);
      tally.push(h.won.USER - h.won.AI);
    }
    const cut = Math.floor(PAIRS * 0.75);
    const testY = y.slice(cut), testTally = tally.slice(cut);
    const signAcc = (p: number[]) => {
      const idx = testY.map((v, i) => [v, i] as const).filter(([v]) => Math.abs(v) > 0.12);
      return idx.filter(([v, i]) => Math.sign(p[i]) === Math.sign(v)).length / Math.max(1, idx.length);
    };
    lines.push(`${f}: n=${PAIRS}, replays ${REPLAYS}; held-out tally: corr ${corr(testTally, testY).toFixed(2)}, sign agreement ${(signAcc(testTally) * 100).toFixed(0)}%`);
    let best = { c: -1, lam: 0, clip: false };
    for (const lam of [0.5, 2, 8, 32, 128])
      for (const clip of [true, false]) {
        const fit = (rows: number[][], ys: number[]) => ridge(rows, ys, lam).map((v) => (clip ? Math.max(0, v) : v));
        const w = fit(X.slice(0, cut), y.slice(0, cut));
        const p = X.slice(cut).map((r) => r.reduce((s, v, i) => s + v * w[i], 0));
        const c = corr(p, testY);
        lines.push(`  lambda ${lam}${clip ? " (non-negative)" : ""}: held-out corr ${c.toFixed(2)}, sign agreement ${(signAcc(p) * 100).toFixed(0)}%`);
        if (c > best.c) best = { c, lam, clip };
      }
    const wAll = ridge(X, y, best.lam).map((v) => (best.clip ? Math.max(0, v) : v));
    lines.push(`  chosen: lambda ${best.lam}${best.clip ? " non-negative" : ""}`);
    lines.push(`  ${f}: { ${keys.map((k, i) => `${k}: ${wAll[i].toFixed(3)}`).join(", ")} },`);
  }
  writeFileSync(out!, lines.join("\n"));
}, 1_500_000);
