import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const db: DatabaseSyncType = new DatabaseSync(":memory:");
db.exec(readFileSync("src/db/schema.sql", "utf8"));
db.exec(readFileSync("data/seed.sql", "utf8"));
// Same order as `npm run db:seed:local`, so tests see what the game sees
db.exec(readFileSync("data/career-overrides.sql", "utf8"));
db.exec(readFileSync("data/data-fixes.sql", "utf8"));
db.exec(readFileSync("data/phase-stats.sql", "utf8"));
db.exec(readFileSync("data/player-splits.sql", "utf8"));

/** In-memory D1 stand-in over the seed data, for scripts and tests. */
export const d1 = {
  prepare(sql: string) {
    return { bind: (...args: unknown[]) => ({ all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }) }) };
  },
} as unknown as D1Database;

export function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
