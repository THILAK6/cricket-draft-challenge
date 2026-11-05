import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { buildRandomDraft, getPlayerPool, DRAFT_POOL_SIZE, POOL_MIN_MATCHES, POOL_SOURCE_SIZE, TOP_PLAYER_COUNT, TOP_PLAYER_SHARE } from "../src/worker/challenge-generator";
import { checkDraftFeasibility } from "../src/core/validator";
import type { MatchFormat } from "../src/core/types";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const db: DatabaseSyncType = new DatabaseSync(":memory:");
db.exec(readFileSync("src/db/schema.sql", "utf8"));
db.exec(readFileSync("data/seed.sql", "utf8"));
const d1 = {
  prepare(sql: string) {
    return { bind: (...args: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }) }) };
  },
} as unknown as D1Database;

describe("random drafts", () => {
  for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    it(`${format}: 30 unique players, playable scenario, and real variety`, async () => {
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
    it(`${format}: at least 60% of every pool is from the top 50 most-capped players`, async () => {
      const source = await getPlayerPool(d1, format, POOL_SOURCE_SIZE, POOL_MIN_MATCHES);
      const top = new Set([...source].sort((a, b) => b.stats.matches - a.stats.matches).slice(0, TOP_PLAYER_COUNT).map((p) => p.id));
      for (let i = 0; i < 25; i++) {
        const { pool } = await buildRandomDraft(d1, format);
        const n = pool.filter((p) => top.has(p.id)).length;
        expect(n).toBeGreaterThanOrEqual(Math.ceil(DRAFT_POOL_SIZE * TOP_PLAYER_SHARE));
      }
    });
  }
});
