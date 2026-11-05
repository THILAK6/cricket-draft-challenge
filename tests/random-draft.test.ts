import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { buildRandomDraft, DRAFT_POOL_SIZE } from "../src/worker/challenge-generator";
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
});
