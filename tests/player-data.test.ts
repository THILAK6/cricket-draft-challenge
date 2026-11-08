import { describe, it, expect } from "vitest";
import { d1 } from "./support/db";
import { getPlayerPool, buildRandomDraft, FULL_MEMBERS } from "../src/worker/challenge-generator";
import { playerQuality, battingRating, bowlingRating } from "../src/core/player-quality";
import type { MatchFormat, PlayerWithStats } from "../src/core/types";

const pools = new Map<MatchFormat, PlayerWithStats[]>();
const pool = async (f: MatchFormat) => {
  if (!pools.has(f)) pools.set(f, await getPlayerPool(d1, f, 2000, 1));
  return pools.get(f)!;
};
const byId = async (f: MatchFormat, id: string) => (await pool(f)).find((p) => p.id === id)!;

describe("player data fixes", () => {
  it("files Indonesian and Austrian players under their own countries, not India and Australia", async () => {
    const t20 = await pool("T20");
    expect((await byId("T20", "crick_a62f55ba")).country).toBe("INA"); // Danilson Hawoe
    expect((await byId("T20", "crick_33b67317")).country).toBe("AUT"); // Mahammad Bilal Zalmai
    expect((await byId("T20", "crick_a4e37e47")).country).toBe("IND"); // Shivam Dube stays Indian
    expect((await byId("T20", "crick_7c7d63a2")).country).toBe("AUS"); // Andrew Tye stays Australian
    expect(t20.filter((p) => p.country === "INA").length).toBeGreaterThan(15);
  });

  it("keeps associates out of the default draft pool", async () => {
    for (let i = 0; i < 5; i++) {
      const { pool: p } = await buildRandomDraft(d1, "T20");
      expect(p.every((x) => FULL_MEMBERS.has(x.country))).toBe(true);
    }
  });

  it("gives players their role in each format", async () => {
    expect((await byId("ODI", "crick_0184dc35")).primary_role).toBe("WK"); // Dravid kept in ODIs
    expect((await byId("TEST", "crick_0184dc35")).primary_role).toBe("BAT"); // ...and batted in Tests
    expect((await byId("ODI", "crick_bf1d7d3e")).primary_role).toBe("AR"); // Mahmudullah bowls off-spin
    expect((await byId("ODI", "crick_d67d5f00")).primary_role).toBe("BAT"); // David Miller
    expect((await byId("ODI", "crick_c0790f82")).primary_role).toBe("AR"); // Klusener: an all-rounder, not a bowler
    expect((await byId("ODI", "crick_34ff9e07")).primary_role).toBe("BAT"); // Aravinda de Silva
    expect((await byId("TEST", "crick_ba5e1069")).primary_role).not.toBe("BOWL"); // Rachin Ravindra
  });
});

describe("player ratings", () => {
  it("puts the legends at the top and the journeymen well below", async () => {
    const q = async (f: MatchFormat, id: string) => playerQuality(await byId(f, id), f);
    // Test: Kallis, Steyn and Murali are all-time greats; de Grandhomme and Taijul are not
    for (const great of ["crick_86dc8f2e", "crick_8fd1a8f5", "crick_4ba44e19"]) {
      expect(await q("TEST", great)).toBeGreaterThan(90);
    }
    expect(await q("TEST", "crick_94d7f855")).toBeLessThan(await q("TEST", "crick_86dc8f2e") - 20);
    expect(await q("TEST", "crick_9d1d34bd")).toBeLessThan(70);
    // ODI: Kohli is near the top; a short, bright career (Corbin Bosch) is not
    expect(await q("ODI", "crick_ba607b88")).toBeGreaterThan(95);
    expect(await q("ODI", "crick_172dff15")).toBeLessThan(await q("ODI", "crick_ba607b88") - 20);
  });

  it("rates an all-rounder by the better skill plus part of the other, not both in full", async () => {
    for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
      for (const p of (await pool(f)).filter((x) => x.primary_role === "AR" && x.stats.matches >= 30).slice(0, 40)) {
        const bat = battingRating(p, f);
        const bowl = bowlingRating(p, f);
        expect(playerQuality(p, f)).toBeLessThanOrEqual(Math.max(bat, bowl) + 0.4 * Math.min(bat, bowl) + 1e-9);
      }
    }
  });

  it("sends no rating with the players: you judge them by their numbers", async () => {
    const { pool: p } = await buildRandomDraft(d1, "TEST");
    for (const x of p) expect(x).not.toHaveProperty("rating");
  });
});

describe("pool themes", () => {
  it("draws only the theme's players, and plays two-nation themes at home grounds", async () => {
    const { PLAYER_MID_YEAR } = await import("../src/core/era-data");
    for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
      const ashes = await buildRandomDraft(d1, f, Math.random, "ashes");
      expect(ashes.theme).toBe("ashes");
      expect(ashes.pool.every((p) => p.country === "ENG" || p.country === "AUS")).toBe(true);
      expect(["ENG", "AUS"]).toContain(ashes.challenge.venue.country);
      expect(ashes.challenge.constraints.some((c) => c.type === "max_per_country")).toBe(false);

      const modern = await buildRandomDraft(d1, f, Math.random, "modern");
      expect(modern.pool.every((p) => (PLAYER_MID_YEAR[f][p.id] ?? 0) >= 2016)).toBe(true);

      const legends = await buildRandomDraft(d1, f, Math.random, "legends");
      const mixed = await buildRandomDraft(d1, f, Math.random, "mixed");
      const avg = (xs: PlayerWithStats[]) => xs.reduce((s, p) => s + playerQuality(p, f), 0) / xs.length;
      expect(avg(legends.pool)).toBeGreaterThan(avg(mixed.pool));
    }
  });

  it("falls back to the mixed pool for an unknown theme", async () => {
    expect((await buildRandomDraft(d1, "T20", Math.random, "no-such-theme")).theme).toBe("mixed");
  });
});
