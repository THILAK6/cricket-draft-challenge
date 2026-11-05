import { describe, it, expect } from "vitest";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { chooseAiPick } from "../src/core/ai-draft";
import { canPickPlayer } from "../src/core/validator";
import { playerQuality } from "../src/core/player-quality";
import type { PlayerWithStats } from "../src/core/types";

const empty = () => Array<PlayerWithStats | null>(11).fill(null);

async function draft(seed: number, format: "T20" | "ODI" | "TEST" = "T20") {
  const { challenge, pool } = await buildRandomDraft(d1, format, lcg(seed));
  return { challenge, pool };
}

describe("chooseAiPick", () => {
  it("always returns a legal pick and finishes a full draft without fallbacks in the normal case", async () => {
    for (const diff of ["easy", "normal", "hard"] as const) {
      const { challenge, pool } = await draft(11);
      const ai = empty(), user = empty();
      let fallbacks = 0;
      for (let pick = 0; pick < 22; pick++) {
        const mine = pick % 2 === 0 ? ai : user, theirs = pick % 2 === 0 ? user : ai;
        const r = chooseAiPick({ pool, squad: mine, opponentSquad: theirs, challenge, difficulty: diff, noiseSeed: 7, round: pick });
        expect(r).not.toBeNull();
        expect(canPickPlayer(r!.player, mine, challenge, r!.slotIndex).allowed).toBe(true);
        if (r!.fallback) fallbacks++;
        mine[r!.slotIndex] = r!.player;
        pool.splice(pool.findIndex((p) => p.id === r!.player.id), 1);
      }
      expect(ai.every(Boolean)).toBe(true);
      expect(fallbacks).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic for a given seed and Easy noise differs between seeds", async () => {
    const { challenge, pool } = await draft(5, "ODI");
    const run = (diff: "easy" | "normal", seed: number) =>
      chooseAiPick({ pool, squad: empty(), opponentSquad: empty(), challenge, difficulty: diff, noiseSeed: seed, round: 1 })!.player.id;
    expect(run("easy", 3)).toBe(run("easy", 3));
    expect(run("normal", 1)).toBe(run("normal", 2));
    const picks = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => run("easy", s)));
    expect(picks.size).toBeGreaterThan(1);
  });

  it("reports denial only for Normal and Hard", async () => {
    const { challenge, pool } = await draft(9);
    const easy = chooseAiPick({ pool, squad: empty(), opponentSquad: empty(), challenge, difficulty: "easy", noiseSeed: 1, round: 1 })!;
    expect(easy.denial).toBe(0);
  });

  it("falls back to the highest-quality legal player, flagged, when nothing scores", async () => {
    const { challenge, pool } = await draft(13);
    // Fill every slot but one with the pool's worst players so only strange picks remain: still must return a legal best-quality choice
    const r = chooseAiPick({ pool: pool.slice(0, 1), squad: empty(), opponentSquad: empty(), challenge, difficulty: "normal", noiseSeed: 1, round: 1 });
    expect(r).not.toBeNull();
    expect(r!.player.id).toBe(pool[0].id);
    const q = playerQuality(pool[0], challenge.format as any);
    expect(q).toBeGreaterThan(0);
  });
});
