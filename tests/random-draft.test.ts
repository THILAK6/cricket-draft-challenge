import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { buildRandomDraft, getPlayerPool, topPlayerIds, FULL_MEMBERS, DRAFT_POOL_SIZE, POOL_MIN_MATCHES, POOL_SOURCE_SIZE, TOP_PLAYER_SHARE } from "../src/worker/challenge-generator";
import { checkDraftFeasibility } from "../src/core/validator";
import type { MatchFormat } from "../src/core/types";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const db: DatabaseSyncType = new DatabaseSync(":memory:");
db.exec(readFileSync("src/db/schema.sql", "utf8"));
db.exec(readFileSync("data/seed.sql", "utf8"));
// Same order as `npm run db:seed:local`, so tests see what the game sees
db.exec(readFileSync("data/career-overrides.sql", "utf8"));
db.exec(readFileSync("data/data-fixes.sql", "utf8"));
const d1 = {
  prepare(sql: string) {
    return { bind: (...args: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }) }) };
  },
} as unknown as D1Database;

describe("random drafts", () => {
  for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    it(`${format}: ${DRAFT_POOL_SIZE} unique players, playable scenario, and real variety`, async () => {
      const titles = new Set<string>();
      const pools = new Set<string>();
      for (let i = 0; i < 25; i++) {
        const { challenge, pool } = await buildRandomDraft(d1, format);
        expect(pool.length).toBe(DRAFT_POOL_SIZE);
        expect(new Set(pool.map((p) => p.id)).size).toBe(DRAFT_POOL_SIZE);
        expect(challenge.format).toBe(format);
        expect(checkDraftFeasibility(pool, challenge, 1).isFeasible).toBe(true);
        titles.add(challenge.title);
        pools.add(pool.map((p) => p.id).sort().join());
      }
      expect(titles.size).toBeGreaterThan(1);
      expect(pools.size).toBeGreaterThan(20);
    });
  }

  for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    it(`${format}: at least 60% of every pool is from the format's top players by stature, and no associates`, async () => {
      const source = (await getPlayerPool(d1, format, POOL_SOURCE_SIZE, POOL_MIN_MATCHES)).filter((p) => FULL_MEMBERS.has(p.country));
      const top = topPlayerIds(source, format);
      for (let i = 0; i < 25; i++) {
        const { pool } = await buildRandomDraft(d1, format);
        const n = pool.filter((p) => top.has(p.id)).length;
        expect(pool.every((p) => FULL_MEMBERS.has(p.country))).toBe(true);
        expect(n).toBeGreaterThanOrEqual(Math.ceil(DRAFT_POOL_SIZE * TOP_PLAYER_SHARE));
      }
    });
  }

  for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    it(`${format}: grounds, conditions and rules differ from draft to draft, and stay cheap`, async () => {
      const venues = new Set<string>();
      const pitches = new Set<string>();
      const rules = new Set<string>();
      const titles = new Set<string>();
      let worst = 0;
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        const { challenge } = await buildRandomDraft(d1, format);
        worst = Math.max(worst, performance.now() - t0);
        venues.add(challenge.venue.name);
        pitches.add(challenge.venue.pitch_type);
        titles.add(challenge.title);
        rules.add(JSON.stringify(challenge.constraints));
        // One house rule per match
        expect(challenge.constraints).toHaveLength(1);
      }
      expect(venues.size).toBeGreaterThanOrEqual(8);
      expect(pitches.size).toBeGreaterThanOrEqual(3);
      expect(titles.size).toBeGreaterThanOrEqual(15);
      // Exactly one rule per match, so fewer distinct rule sets than before (pace/spin/all-rounder counts, country caps)
      expect(rules.size).toBeGreaterThanOrEqual(5);
      // generous bound for CI noise; the Worker budget is 10 ms CPU and the DB read is separate
      expect(worst).toBeLessThan(150);
    });
  }
});
