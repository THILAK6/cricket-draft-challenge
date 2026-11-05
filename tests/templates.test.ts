import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { FALLBACK_SCENARIOS, fetchPlayerPool, VERIFIED_POOL_SIZE } from "../src/worker/challenge-generator";
import { checkDraftFeasibility, DEFAULT_SEARCH_NODE_BUDGET } from "../src/core/validator";
import { ChallengeSchema } from "../src/core/types";
import type { MatchFormat } from "../src/core/types";

/**
 * Built-in challenge templates are served at runtime WITHOUT a feasibility search (the Workers
 * free plan allows only 10 ms of CPU per request). This test is what guarantees they are
 * playable: each one must support two disjoint XIs from the real seeded pool, within the budget.
 */
// Vite does not treat node:sqlite as a builtin, so load it via require
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const db: DatabaseSyncType = new DatabaseSync(":memory:");
db.exec(readFileSync("src/db/schema.sql", "utf8"));
db.exec(readFileSync("data/seed.sql", "utf8"));

// Minimal D1 shim over node:sqlite so we exercise the production query unchanged
const d1 = {
  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
      }),
    };
  },
} as unknown as D1Database;

describe("built-in challenge templates", () => {
  for (const format of ["T20", "ODI", "TEST"] as MatchFormat[]) {
    describe(format, () => {
      const templates = FALLBACK_SCENARIOS.filter((s) => s.format === format);

      it("has at least one template", () => {
        expect(templates.length).toBeGreaterThan(0);
      });

      for (const template of templates) {
        it(`"${template.title}" is schema-valid and playable head-to-head`, async () => {
          ChallengeSchema.parse({ id: "t", ...template });
          const pool = await fetchPlayerPool(d1, format, VERIFIED_POOL_SIZE);
          expect(pool.length).toBe(VERIFIED_POOL_SIZE);

          const result = checkDraftFeasibility(pool, { id: "t", ...template }, 50);
          expect(result.reasons).toEqual([]);
          expect(result.isFeasible).toBe(true);
          expect(result.nodesVisited).toBeLessThan(DEFAULT_SEARCH_NODE_BUDGET);
        });
      }
    });
  }
});
