import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { canPickPlayer } from "../src/core/validator";
import { calculateDeterministicScore } from "../src/core/scoring";
import { calculateDeterministicScore as legacyJudge } from "./support/legacy-scoring";
import { legacyPlayerQuality } from "./support/legacy-quality";
import { simulateCricketMatch } from "../src/core/simulator";
import { chooseAiPick, slotEligible, type Difficulty } from "../src/core/ai-draft";
import { LegacyAi, LEGACY_STATS } from "./support/legacy-ai";
import type { Challenge, DraftState, MatchFormat, PlayerWithStats } from "../src/core/types";

// Run with: AI_SIM=<output path> [AI_SIM_N=1000] npx vitest run tests/ai-draft-sim.test.ts
const out = process.env.AI_SIM;
const N = Number(process.env.AI_SIM_N ?? 1000);
const WHICH = (process.env.AI_SIM_SET ?? "all").split(",");

type Squad = (PlayerWithStats | null)[];
type Engine = "legacy" | "new";
type Player = { kind: "ai"; engine: Engine; difficulty: Difficulty } | { kind: "greedy" };

const label = (p: Player) => (p.kind === "greedy" ? "greedy user" : `${p.engine}-${p.difficulty}`);

const CELLS: { format: MatchFormat; pitch: string }[] = [];
for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) for (const pitch of ["GREEN_SEAMER", "DUSTBOWL", "HIGH_SCORING_FLAT", "SLOW_LOW"]) CELLS.push({ format, pitch });

interface Tally {
  drafts: number;
  /** wins for side A (ties count half) */
  aWins: number;
  aScoreSum: number;
  bScoreSum: number;
  aOldJudgeSum: number;
  bOldJudgeSum: number;
  aParts: [number, number, number, number];
  bParts: [number, number, number, number];
  incomplete: number;
  picksA: number;
  picksB: number;
  fallbackA: number;
  fallbackB: number;
  msA: number;
  msB: number;
  spinFlat3: { a: number; b: number; n: number };
}
const newTally = (): Tally => ({
  drafts: 0, aWins: 0, aScoreSum: 0, bScoreSum: 0, aOldJudgeSum: 0, bOldJudgeSum: 0, aParts: [0, 0, 0, 0], bParts: [0, 0, 0, 0],
  incomplete: 0, picksA: 0, picksB: 0, fallbackA: 0, fallbackB: 0, msA: 0, msB: 0, spinFlat3: { a: 0, b: 0, n: 0 },
});

/** Greedy-by-quality human: best remaining player into the first sensible legal slot for his role. */
function greedyPick(pool: PlayerWithStats[], mine: Squad, theirs: Squad, challenge: Challenge, format: MatchFormat): { player: PlayerWithStats; slot: number } | null {
  const ranked = [...pool].sort((a, b) => legacyPlayerQuality(b, format) - legacyPlayerQuality(a, format));
  for (const p of ranked) {
    const order = p.primary_role === "BOWL" ? [8, 9, 10, 7, 6, 5] : p.primary_role === "AR" ? [5, 6, 7, 8, 9, 10, 4, 3, 2] : [0, 1, 2, 3, 4, 5, 6];
    for (const s of order) {
      if (mine[s]) continue;
      if (canPickPlayer(p, mine, challenge, s, { pool, opponentSquad: theirs }).allowed) return { player: p, slot: s };
    }
  }
  // Anything legal anywhere
  for (const p of ranked) for (let s = 0; s < 11; s++) if (!mine[s] && canPickPlayer(p, mine, challenge, s, { pool, opponentSquad: theirs }).allowed) return { player: p, slot: s };
  return null;
}

function pickFor(who: Player, pool: PlayerWithStats[], mine: Squad, theirs: Squad, challenge: Challenge, format: MatchFormat, round: number, seed: number): { player: PlayerWithStats; slot: number; fallback: boolean; ms: number } | null {
  const t0 = performance.now();
  if (who.kind === "greedy") {
    const g = greedyPick(pool, mine, theirs, challenge, format);
    return g ? { ...g, fallback: false, ms: performance.now() - t0 } : null;
  }
  if (who.engine === "new") {
    const r = chooseAiPick({ pool, squad: mine, opponentSquad: theirs, challenge, difficulty: who.difficulty, noiseSeed: seed, round });
    return r ? { player: r.player, slot: r.slotIndex, fallback: r.fallback, ms: performance.now() - t0 } : null;
  }
  // Legacy engine mutates a DraftState in place: build one with this side as "aiPicks"
  const before = LEGACY_STATS.fallback;
  const snapshot = new Set(mine.filter(Boolean).map((p) => (p as PlayerWithStats).id));
  const state = { pool, aiPicks: mine, userPicks: theirs, challenge, difficulty: who.difficulty, round, currentTurn: "AI", lastAiSnipe: undefined } as unknown as DraftState;
  new LegacyAi(state).executeAiPick();
  const slot = mine.findIndex((p, i) => p && !snapshot.has(p.id) && i >= 0);
  if (slot < 0) return null;
  // The legacy engine already applied the pick to the squad and removed it from the pool: report it and let the caller skip applying
  return { player: mine[slot] as PlayerWithStats, slot, fallback: LEGACY_STATS.fallback > before, ms: performance.now() - t0 };
}

async function runMatchup(A: Player, B: Player, n: number, seedBase: number): Promise<Map<string, Tally>> {
  const byCell = new Map<string, Tally>();
  const total = newTally();
  byCell.set("ALL", total);
  const rand = lcg(seedBase);
  for (let k = 0; k < n; k++) {
    const cell = CELLS[k % CELLS.length];
    const { challenge: c0, pool: pool0 } = await buildRandomDraftFor(cell, rand);
    const challenge = c0;
    const format = challenge.format as MatchFormat;
    const pool = pool0.slice();
    const sqA: Squad = Array(11).fill(null);
    const sqB: Squad = Array(11).fill(null);
    // A drafts first on even iterations, B on odd, so first-pick advantage cancels
    const aFirst = k % 2 === 0;
    const t = newTally();
    let round = 1;
    let stuck = false;
    for (let pick = 0; pick < 22 && !stuck; pick++) {
      const isA = (pick % 2 === 0) === aFirst;
      const who = isA ? A : B;
      const mine = isA ? sqA : sqB;
      const theirs = isA ? sqB : sqA;
      if (mine.every(Boolean)) continue;
      const choice = pickFor(who, pool, mine, theirs, challenge, format, round, seedBase + k);
      if (!choice) { stuck = true; break; }
      const isLegacy = who.kind === "ai" && who.engine === "legacy";
      if (!isLegacy) {
        mine[choice.slot] = choice.player;
        pool.splice(pool.findIndex((p) => p.id === choice.player.id), 1);
      }
      if (isA) { t.picksA++; t.msA += choice.ms; if (choice.fallback) t.fallbackA++; } else { t.picksB++; t.msB += choice.ms; if (choice.fallback) t.fallbackB++; }
      if (!isA === aFirst) round++;
    }
    if (stuck || sqA.some((p) => !p) || sqB.some((p) => !p)) {
      t.incomplete++;
      accumulate(byCell, cell, t, true);
      continue;
    }
    t.drafts = 1;
    // Judge both squads (current judge, and the judge as it was before the rewrite)
    const jA = calculateDeterministicScore(sqA, challenge, { precise: true });
    const jB = calculateDeterministicScore(sqB, challenge, { precise: true });
    t.aScoreSum = jA.deterministic_total;
    t.bScoreSum = jB.deterministic_total;
    t.aParts = [jA.role_balance_score, jA.pitch_suitability_score, jA.player_quality_score, jA.batting_depth_score];
    t.bParts = [jB.role_balance_score, jB.pitch_suitability_score, jB.player_quality_score, jB.batting_depth_score];
    t.aOldJudgeSum = legacyJudge(sqA, challenge).deterministic_total;
    t.bOldJudgeSum = legacyJudge(sqB, challenge).deterministic_total;
    // Alternate which side is "USER" in the simulator
    const aIsUser = k % 4 < 2;
    const res = simulateCricketMatch(aIsUser ? sqA : sqB, aIsUser ? sqB : sqA, challenge, seedBase * 31 + k);
    const w = res.winner;
    t.aWins = w === "TIE" || w === "DRAW" ? 0.5 : (w === "USER") === aIsUser ? 1 : 0;
    if (cell.pitch === "HIGH_SCORING_FLAT") {
      const spinners = (s: Squad) => s.filter((p) => p && p.bowling_category === "SPIN").length;
      t.spinFlat3.n = 1;
      t.spinFlat3.a = spinners(sqA) >= 3 ? 1 : 0;
      t.spinFlat3.b = spinners(sqB) >= 3 ? 1 : 0;
    }
    accumulate(byCell, cell, t, false);
  }
  return byCell;
}

function accumulate(map: Map<string, Tally>, cell: { format: string; pitch: string }, t: Tally, _inc: boolean) {
  for (const key of ["ALL", `${cell.format}`, `${cell.format}/${cell.pitch}`]) {
    let x = map.get(key);
    if (!x) map.set(key, (x = newTally()));
    x.drafts += t.drafts; x.aWins += t.aWins; x.aScoreSum += t.aScoreSum; x.bScoreSum += t.bScoreSum;
    x.aOldJudgeSum += t.aOldJudgeSum; x.bOldJudgeSum += t.bOldJudgeSum;
    for (let i = 0; i < 4; i++) { x.aParts[i] += t.aParts[i]; x.bParts[i] += t.bParts[i]; }
    x.incomplete += t.incomplete; x.picksA += t.picksA; x.picksB += t.picksB; x.fallbackA += t.fallbackA; x.fallbackB += t.fallbackB;
    x.msA += t.msA; x.msB += t.msB;
    x.spinFlat3.a += t.spinFlat3.a; x.spinFlat3.b += t.spinFlat3.b; x.spinFlat3.n += t.spinFlat3.n;
  }
}

/** A random draft pinned to a pitch type and format (the pool and rules still vary). */
async function buildRandomDraftFor(cell: { format: MatchFormat; pitch: string }, rand: () => number) {
  for (let i = 0; i < 400; i++) {
    const d = await buildRandomDraft(d1, cell.format, rand);
    if (d.challenge.venue.pitch_type === cell.pitch) return d;
  }
  throw new Error(`no ${cell.format} ${cell.pitch} scenario`);
}

const f1 = (x: number) => x.toFixed(1);
const pct = (x: number) => (x * 100).toFixed(1) + "%";

(out ? it : it.skip)("AI draft simulations", async () => {
  const lines: string[] = [];
  const log = (s = "") => lines.push(s);
  log(`AI draft simulations: ${N} seeded drafts per matchup, spread evenly over ${CELLS.length} format x pitch cells`);
  log(`Judge = calculateDeterministicScore (current) and the pre-rewrite judge ("old judge") for reference. Win rate: ball-by-ball simulator, ties count half.`);
  log();

  const matchups: { name: string; set: string; A: Player; B: Player }[] = [
    { name: "legacy Easy vs legacy Normal", set: "before", A: { kind: "ai", engine: "legacy", difficulty: "easy" }, B: { kind: "ai", engine: "legacy", difficulty: "normal" } },
    { name: "legacy Normal vs legacy Hard", set: "before", A: { kind: "ai", engine: "legacy", difficulty: "normal" }, B: { kind: "ai", engine: "legacy", difficulty: "hard" } },
    { name: "legacy Easy vs greedy user", set: "before", A: { kind: "ai", engine: "legacy", difficulty: "easy" }, B: { kind: "greedy" } },
    { name: "legacy Normal vs greedy user", set: "before", A: { kind: "ai", engine: "legacy", difficulty: "normal" }, B: { kind: "greedy" } },
    { name: "legacy Hard vs greedy user", set: "before", A: { kind: "ai", engine: "legacy", difficulty: "hard" }, B: { kind: "greedy" } },
    { name: "new Easy vs new Normal", set: "after", A: { kind: "ai", engine: "new", difficulty: "easy" }, B: { kind: "ai", engine: "new", difficulty: "normal" } },
    { name: "new Normal vs new Hard", set: "after", A: { kind: "ai", engine: "new", difficulty: "normal" }, B: { kind: "ai", engine: "new", difficulty: "hard" } },
    { name: "new Easy vs greedy user", set: "after", A: { kind: "ai", engine: "new", difficulty: "easy" }, B: { kind: "greedy" } },
    { name: "new Normal vs greedy user", set: "after", A: { kind: "ai", engine: "new", difficulty: "normal" }, B: { kind: "greedy" } },
    { name: "new Hard vs greedy user", set: "after", A: { kind: "ai", engine: "new", difficulty: "hard" }, B: { kind: "greedy" } },
    { name: "new Normal vs legacy Normal", set: "cross", A: { kind: "ai", engine: "new", difficulty: "normal" }, B: { kind: "ai", engine: "legacy", difficulty: "normal" } },
  ];

  const header = "matchup                              drafts  A win%   A sel   B sel  A old-judge B old-judge   A parts (role/pitch/qual/depth)   fb% A  fb% B  ms/pick A  ms/pick B  incomplete";
  log(header);
  const detail: string[] = [];
  let idx = 0;
  for (const m of matchups) {
    if (!WHICH.includes("all") && !WHICH.includes(m.set)) continue;
    LEGACY_STATS.fallback = 0; LEGACY_STATS.spinnerPenaltyEvals = 0; LEGACY_STATS.spinnerPenaltyOnAR = 0;
    const t0 = performance.now();
    const res = await runMatchup(m.A, m.B, N, 1000 + idx++ * 7919);
    const x = res.get("ALL")!;
    const d = Math.max(1, x.drafts);
    log(
      `${m.name.padEnd(36)} ${String(x.drafts).padStart(6)}  ${pct(x.aWins / d).padStart(6)}  ${f1(x.aScoreSum / d).padStart(6)}  ${f1(x.bScoreSum / d).padStart(6)}  ${f1(x.aOldJudgeSum / d).padStart(10)}  ${f1(x.bOldJudgeSum / d).padStart(10)}   ${x.aParts.map((v) => f1(v / d)).join("/").padEnd(30)}  ${pct(x.fallbackA / Math.max(1, x.picksA)).padStart(6)} ${pct(x.fallbackB / Math.max(1, x.picksB)).padStart(6)}  ${f1(x.msA / Math.max(1, x.picksA)).padStart(8)}  ${f1(x.msB / Math.max(1, x.picksB)).padStart(8)}  ${x.incomplete}`
    );
    detail.push(`\n${m.name}  (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
    detail.push("  cell                          drafts  A win%   A sel   B sel");
    for (const [key, v] of [...res.entries()].sort()) {
      if (key === "ALL") continue;
      const dd = Math.max(1, v.drafts);
      detail.push(`  ${key.padEnd(28)} ${String(v.drafts).padStart(6)}  ${pct(v.aWins / dd).padStart(6)}  ${f1(v.aScoreSum / dd).padStart(6)}  ${f1(v.bScoreSum / dd).padStart(6)}`);
    }
    const flat = res.get("ALL")!.spinFlat3;
    detail.push(`  flat-pitch XIs with 3+ spinners: A ${pct(flat.a / Math.max(1, flat.n))}, B ${pct(flat.b / Math.max(1, flat.n))} (n=${flat.n})`);
    if (m.A.kind === "ai" && m.A.engine === "legacy") {
      detail.push(`  legacy spinner penalty: evaluated ${LEGACY_STATS.spinnerPenaltyEvals} times, of which ${LEGACY_STATS.spinnerPenaltyOnAR} on all-rounders; fallbacks fired ${LEGACY_STATS.fallback}`);
    }
    writeFileSync(out!, lines.join("\n") + "\n" + detail.join("\n") + "\n");
  }
  writeFileSync(out!, lines.join("\n") + "\n" + detail.join("\n") + "\n");
}, 6 * 60 * 60 * 1000);
