import { isNaturalOpener } from "../src/core/batting-order";
import { describe, it, expect } from "vitest";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { chooseAiPick, PERSONAS, type Difficulty } from "../src/core/ai-draft";
import { canPickPlayer } from "../src/core/validator";
import { playerQuality } from "../src/core/player-quality";
import { snakeOrder } from "../src/core/types";
import type { Challenge, MatchFormat, PlayerWithStats } from "../src/core/types";

type Squad = (PlayerWithStats | null)[];
const empty = (): Squad => Array(11).fill(null);

/** A full snake draft: the AI against a human who takes the best-rated legal player. */
async function fullDraft(seed: number, format: MatchFormat, difficulty: Difficulty) {
  const { challenge, pool: p0 } = await buildRandomDraft(d1, format, lcg(seed));
  let pool = [...p0];
  const ai = empty(), user = empty();
  const reasons: string[] = [];
  let first: { pick: PlayerWithStats; best: number } | null = null;
  for (const who of snakeOrder(seed % 2 ? "AI" : "USER")) {
    if (who === "AI") {
      const r = chooseAiPick({ pool, squad: ai, opponentSquad: user, challenge, difficulty, noiseSeed: seed, round: 44 - pool.length })!;
      expect(canPickPlayer(r.player, ai, challenge, undefined, { pool, opponentSquad: user }).allowed).toBe(true);
      if (!first) first = { pick: r.player, best: Math.max(...pool.map((p) => playerQuality(p, format))) };
      reasons.push(r.reason);
      ai[ai.indexOf(null)] = r.player;
      pool = pool.filter((p) => p.id !== r.player.id);
    } else {
      const p = [...pool].sort((a, b) => playerQuality(b, format) - playerQuality(a, format)).find((q) => canPickPlayer(q, user, challenge, undefined, { pool, opponentSquad: ai }).allowed)!;
      user[user.indexOf(null)] = p;
      pool = pool.filter((q) => q.id !== p.id);
    }
  }
  return { challenge, ai: ai as PlayerWithStats[], user: user as PlayerWithStats[], reasons, first: first! };
}

describe("AI drafts like a friend", () => {
  it("opens with a star: its first pick is (nearly) the best player in the pool", async () => {
    for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) {
      for (let seed = 1; seed <= 6; seed++) {
        const { first } = await fullDraft(seed, format, "normal");
        expect(playerQuality(first.pick, format), `${format} seed ${seed}: ${first.pick.name}`).toBeGreaterThanOrEqual(first.best - 8);
      }
    }
  });

  it("builds a balanced XI instead of stacking all-rounders", async () => {
    for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) {
      for (let seed = 1; seed <= 5; seed++) {
        const { ai } = await fullDraft(seed, format, "hard");
        expect(ai.filter((p) => p.primary_role === "AR").length).toBeLessThanOrEqual(4);
        expect(ai.filter((p) => p.primary_role === "WK").length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("explains picks in cricket words, never in points or slots", async () => {
    for (const d of ["easy", "normal", "hard"] as Difficulty[]) {
      const { reasons } = await fullDraft(3, "T20", d);
      for (const r of reasons) expect(r).not.toMatch(/selection points|Slot #|undefined|NaN/);
    }
  });

  it("gives the three personalities different tastes", async () => {
    let differ = 0, fanHome = 0, capHome = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const fan = await fullDraft(seed, "ODI", "easy");
      const cap = await fullDraft(seed, "ODI", "normal");
      if (fan.ai.map((p) => p.id).join() !== cap.ai.map((p) => p.id).join()) differ++;
      const host = fan.challenge.venue.country;
      fanHome += fan.ai.filter((p) => p.country === host).length;
      capHome += cap.ai.filter((p) => p.country === host).length;
    }
    expect(differ).toBeGreaterThanOrEqual(5);
    expect(fanHome).toBeGreaterThan(capHome); // the Fanboy loves the home side
    expect(Object.values(PERSONAS).map((p) => p.name)).toEqual(["The Fanboy", "The Captain", "The Shark"]);
  });

  it("the Shark takes the last good spinner you still need; the Fanboy doesn't notice", async () => {
    const { challenge: base, pool } = await buildRandomDraft(d1, "T20", lcg(21));
    const challenge: Challenge = { ...base, venue: { ...base.venue, pitch_type: "HIGH_SCORING_FLAT" }, constraints: [{ type: "min_category", category: "SPIN", count: 1 }] };
    const q = (p: PlayerWithStats) => playerQuality(p, "T20");
    // A good (not great) spinner, and a batter rated a little higher
    const pairs = pool
      .filter((p) => p.bowling_category === "SPIN" && q(p) >= 60)
      .map((sp) => ({ sp, bat: pool.filter((b) => b.primary_role === "BAT" && q(b) > q(sp) + 2 && q(b) < q(sp) + 10).sort((a, b) => q(a) - q(b))[0] }))
      .filter((x) => x.bat);
    expect(pairs.length).toBeGreaterThan(0);
    const { sp: spinner, bat: batter } = pairs[0];
    // The human has no spinner yet; this is the only spinner left, and the batter is rated higher
    // The AI already has a keeper, a spinner, two pacers and two openers, so its own needs don't
    // decide the pick, and no keepers are left to snipe: only the spinner snipe can make him its choice
    const pacers = pool.filter((p) => p.primary_role === "BOWL" && p.bowling_category === "PACE").slice(0, 2);
    const openers = pool.filter((p) => p.primary_role === "BAT" && isNaturalOpener(p) && p.id !== batter.id).slice(0, 2);
    const taken = [...pacers, ...openers];
    const left = [spinner, batter, ...pool.filter((p) => p.bowling_category !== "SPIN" && p.id !== batter.id && !taken.includes(p) && p.primary_role !== "WK" && q(p) <= q(batter)).slice(0, 20)];
    const human = [...pool.filter((p) => p.primary_role === "BAT" && p.id !== batter.id && !taken.includes(p)).slice(0, 4), ...Array(7).fill(null)];
    const mine = [...pool.filter((p) => p.primary_role === "WK").slice(0, 1), ...pool.filter((p) => p.bowling_category === "SPIN" && p.id !== spinner.id).slice(0, 1), ...taken, ...Array(5).fill(null)];
    const pick = (difficulty: Difficulty) => chooseAiPick({ pool: left, squad: mine, opponentSquad: human, challenge, difficulty, noiseSeed: 1, round: 5 })!;
    const shark = pick("hard");
    expect(shark.player.id).toBe(spinner.id);
    expect(shark.reason).toMatch(/spinner/);
    expect(pick("easy").denial).toBe(0);
  });
});
