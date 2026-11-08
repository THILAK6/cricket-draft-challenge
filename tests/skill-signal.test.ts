import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { canPickPlayer } from "../src/core/validator";
import { playerQuality } from "../src/core/player-quality";
import { arrangeSquad } from "../src/core/batting-order";
import { simulateCricketMatch, BALL_MODEL } from "../src/core/simulator";
import { chooseAiPick } from "../src/core/ai-draft";
import type { Challenge, MatchFormat, PlayerWithStats } from "../src/core/types";

/**
 * How much does drafting decide the result? Run with:
 *   SKILL=<output file> [SKILL_POOLS=30] npx vitest run tests/skill-signal.test.ts
 * - strong v weak: a balanced XI drafted by the Captain AI from the full pool, against one it drafts
 *   from what is left (taking the top-rated player every time gives a lopsided, bowler-heavy side)
 * - even: two XIs drafted alternately (snake) by the Captain, which should be close to 50/50
 * Each pairing is played from both sides (home/away), with several seeds per pool.
 */
const out = process.env.SKILL;
const POOLS = Number(process.env.SKILL_POOLS ?? 30);
// Try other ball-model settings without editing the code: SKILL_MODEL='{"T20":{"BAT_RUNS":1.6}}'
if (process.env.SKILL_MODEL) {
  const m = JSON.parse(process.env.SKILL_MODEL);
  for (const f of Object.keys(m) as MatchFormat[]) Object.assign(BALL_MODEL[f], m[f]);
}
const FORMATS = (process.env.SKILL_FORMATS ?? "T20,ODI,TEST").split(",") as MatchFormat[];

type Squad = (PlayerWithStats | null)[];
const best = (pool: PlayerWithStats[], mine: Squad, ch: Challenge, f: MatchFormat) =>
  [...pool].sort((a, b) => playerQuality(b, f) - playerQuality(a, f)).find((p) => canPickPlayer(p, mine, ch, undefined, { pool }).allowed) ?? pool[0];

function draftAlone(pool: PlayerWithStats[], ch: Challenge, f: MatchFormat): { xi: Squad; rest: PlayerWithStats[] } {
  let rest = [...pool];
  const xi: Squad = Array(11).fill(null);
  for (let i = 0; i < 11; i++) {
    const r = chooseAiPick({ pool: rest, squad: xi, opponentSquad: Array(11).fill(null), challenge: ch, difficulty: "normal", noiseSeed: 1, round: i });
    const p = r ? r.player : best(rest, xi, ch, f);
    xi[xi.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
  }
  return { xi: arrangeSquad(xi, f), rest };
}

function draftSnake(pool: PlayerWithStats[], ch: Challenge, f: MatchFormat): [Squad, Squad] {
  let rest = [...pool];
  const a: Squad = Array(11).fill(null), b: Squad = Array(11).fill(null);
  const order = Array.from({ length: 22 }, (_, i) => ((Math.floor(i / 2) % 2 === 0) === (i % 2 === 0) ? a : b));
  order.forEach((side, i) => {
    const other = side === a ? b : a;
    const r = chooseAiPick({ pool: rest, squad: side, opponentSquad: other, challenge: ch, difficulty: "normal", noiseSeed: 1, round: i });
    const p = r ? r.player : best(rest, side, ch, f);
    side[side.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
  });
  return [arrangeSquad(a, f), arrangeSquad(b, f)];
}

/** Snake draft: the Captain AI (balanced) against a drafter who always takes the top-rated legal player. */
function draftBalancedVsTopRated(pool: PlayerWithStats[], ch: Challenge, f: MatchFormat, captainFirst: boolean): [Squad, Squad] {
  let rest = [...pool];
  const cap: Squad = Array(11).fill(null), top: Squad = Array(11).fill(null);
  const first = captainFirst ? cap : top, second = captainFirst ? top : cap;
  const order = Array.from({ length: 22 }, (_, i) => ((Math.floor(i / 2) % 2 === 0) === (i % 2 === 0) ? first : second));
  order.forEach((side, i) => {
    const p = side === cap
      ? chooseAiPick({ pool: rest, squad: cap, opponentSquad: top, challenge: ch, difficulty: "normal", noiseSeed: 1, round: i })!.player
      : best(rest, top, ch, f);
    side[side.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
  });
  return [arrangeSquad(cap, f), arrangeSquad(top, f)];
}

const avgQ = (xi: Squad, f: MatchFormat) => xi.reduce((s, p) => s + playerQuality(p!, f), 0) / 11;

it.skipIf(!out)("skill signal table", async () => {
  const lines: string[] = ["format | strong v weak: strong wins | rating gap | even drafts: side A wins | balanced v top-rated: balanced wins | avg innings | sims"];
  lines.unshift(`model ${JSON.stringify(BALL_MODEL)}`);
  for (const f of FORMATS) {
    const seeds = f === "TEST" ? 4 : 10;
    let sw = 0, sn = 0, ew = 0, en = 0, bw = 0, bn = 0, gap = 0, runs = 0, inns = 0;
    for (let d = 0; d < POOLS; d++) {
      const { challenge, pool } = await buildRandomDraft(d1, f, lcg(500 + d));
      const { xi: strong, rest } = draftAlone(pool, challenge, f);
      const { xi: weak } = draftAlone(rest, challenge, f);
      const [ea, eb] = draftSnake(pool, challenge, f);
      const [bal, top] = draftBalancedVsTopRated(pool, challenge, f, d % 2 === 0);
      gap += avgQ(strong, f) - avgQ(weak, f);
      for (let s = 1; s <= seeds; s++) {
        const seed = d * 1000 + s;
        // strong as "user" and as "AI", to cancel any side bias
        const m1 = simulateCricketMatch(strong, weak, challenge, seed);
        const m2 = simulateCricketMatch(weak, strong, challenge, seed + 500);
        sw += (m1.winner === "USER" ? 1 : m1.winner === "AI" ? 0 : 0.5) + (m2.winner === "AI" ? 1 : m2.winner === "USER" ? 0 : 0.5);
        sn += 2;
        const e = simulateCricketMatch(ea, eb, challenge, seed + 77);
        ew += e.winner === "USER" ? 1 : e.winner === "AI" ? 0 : 0.5;
        en++;
        const b = simulateCricketMatch(bal, top, challenge, seed + 131);
        bw += b.winner === "USER" ? 1 : b.winner === "AI" ? 0 : 0.5;
        bn++;
        for (const inn of [m1.userInnings, m1.aiInnings]) {
          runs += inn.totalRuns;
          inns++;
        }
      }
    }
    lines.push(`${f} | ${((sw / sn) * 100).toFixed(1)}% | ${(gap / POOLS).toFixed(1)} | ${((ew / en) * 100).toFixed(1)}% | ${((bw / bn) * 100).toFixed(1)}% | ${(runs / inns).toFixed(0)} | ${sn + en + bn}`);
  }
  writeFileSync(out!, lines.join("\n") + "\n");
}, 1_200_000);
