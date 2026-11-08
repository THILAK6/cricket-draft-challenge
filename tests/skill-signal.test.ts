import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { canPickPlayer } from "../src/core/validator";
import { playerQuality } from "../src/core/player-quality";
import { arrangeSquad } from "../src/core/batting-order";
import { simulateCricketMatch } from "../src/core/simulator";
import type { Challenge, MatchFormat, PlayerWithStats } from "../src/core/types";

/**
 * How much does drafting decide the result? Run with:
 *   SKILL=<output file> [SKILL_POOLS=30] npx vitest run tests/skill-signal.test.ts
 * - strong v weak: the best legal XI from a pool against an XI picked from what is left
 * - even: two XIs drafted alternately (snake) from the same pool, which should be close to 50/50
 * Each pairing is played from both sides (home/away), with several seeds per pool.
 */
const out = process.env.SKILL;
const POOLS = Number(process.env.SKILL_POOLS ?? 30);

type Squad = (PlayerWithStats | null)[];
const best = (pool: PlayerWithStats[], mine: Squad, ch: Challenge, f: MatchFormat) =>
  [...pool].sort((a, b) => playerQuality(b, f) - playerQuality(a, f)).find((p) => canPickPlayer(p, mine, ch, undefined, { pool }).allowed) ?? pool[0];

function draftAlone(pool: PlayerWithStats[], ch: Challenge, f: MatchFormat): { xi: Squad; rest: PlayerWithStats[] } {
  let rest = [...pool];
  const xi: Squad = Array(11).fill(null);
  for (let i = 0; i < 11; i++) {
    const p = best(rest, xi, ch, f);
    xi[xi.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
  }
  return { xi: arrangeSquad(xi, f), rest };
}

function draftSnake(pool: PlayerWithStats[], ch: Challenge, f: MatchFormat): [Squad, Squad] {
  let rest = [...pool];
  const a: Squad = Array(11).fill(null), b: Squad = Array(11).fill(null);
  const order = Array.from({ length: 22 }, (_, i) => ((Math.floor(i / 2) % 2 === 0) === (i % 2 === 0) ? a : b));
  for (const side of order) {
    const p = best(rest, side, ch, f);
    side[side.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
  }
  return [arrangeSquad(a, f), arrangeSquad(b, f)];
}

const avgQ = (xi: Squad, f: MatchFormat) => xi.reduce((s, p) => s + playerQuality(p!, f), 0) / 11;

it.skipIf(!out)("skill signal table", async () => {
  const lines: string[] = ["format | strong v weak: strong wins | rating gap | even drafts: side A wins | avg innings | sims"];
  for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    const seeds = f === "TEST" ? 4 : 10;
    let sw = 0, sn = 0, ew = 0, en = 0, gap = 0, runs = 0, inns = 0;
    for (let d = 0; d < POOLS; d++) {
      const { challenge, pool } = await buildRandomDraft(d1, f, lcg(500 + d));
      const { xi: strong, rest } = draftAlone(pool, challenge, f);
      const { xi: weak } = draftAlone(rest, challenge, f);
      const [ea, eb] = draftSnake(pool, challenge, f);
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
        for (const inn of [m1.userInnings, m1.aiInnings]) {
          runs += inn.totalRuns;
          inns++;
        }
      }
    }
    lines.push(`${f} | ${((sw / sn) * 100).toFixed(1)}% | ${(gap / POOLS).toFixed(1)} | ${((ew / en) * 100).toFixed(1)}% | ${(runs / inns).toFixed(0)} | ${sn + en}`);
  }
  writeFileSync(out!, lines.join("\n") + "\n");
}, 1_200_000);
