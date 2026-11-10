import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { chooseAiPick } from "../src/core/ai-draft";
import type { DraftState } from "../src/core/types";

// data/analysis.sql: the queries for looking at saved matches later. Every one must run, and say something sensible.
const queries = readFileSync("data/analysis.sql", "utf8")
  .split(/^-- name: /m)
  .slice(1)
  .map((q) => ({ name: q.split("\n")[0], sql: q.split("\n").slice(1).filter((l) => !l.startsWith("--")).join("\n").trim().replace(/;\s*$/, "") }));

const call = async (room: DraftRoom, path: string, body?: unknown) =>
  (await (await room.fetch(new Request(`http://internal${path}`, { method: body === undefined && path.endsWith("/state") ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? (path.endsWith("/state") ? undefined : "{}") : JSON.stringify(body) }))).json()) as any;
const fakeState = () => {
  const store = new Map<string, unknown>();
  return { storage: { get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : undefined), put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)) } } as any;
};

describe("analysis queries", () => {
  it("runs every query on saved snake and auction matches", async () => {
    // A snake match
    const snake = new DraftRoom(fakeState(), { DB: d1 });
    const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(41));
    await call(snake, "/init", { roomId: "an1", challenge, pool, userPicks: Array(11).fill(null), aiPicks: Array(11).fill(null), currentTurn: "USER", round: 1, maxRounds: 11, status: "DRAFTING", lastActionTimestamp: 0, firstPick: "USER", deviceId: "analysis-device-0001" } satisfies DraftState);
    let s: DraftState = (await call(snake, "/state")).state;
    while (s.status === "DRAFTING") {
      const p = chooseAiPick({ pool: s.pool, squad: s.userPicks, opponentSquad: s.aiPicks, challenge, difficulty: "normal", noiseSeed: 1, round: s.round })!.player;
      s = (await call(snake, "/pick", { playerId: p.id })).state;
    }
    await call(snake, "/start-match");
    // An auction match (the user passes on everything he is asked about)
    const auction = new DraftRoom(fakeState(), { DB: d1 });
    const made = await call(auction, "/create", { roomId: "an2", format: "T20", league: "IPL", theme: "ipl-all", draftMode: "auction", auctionStyle: "impulsive", difficulty: "normal", deviceId: "analysis-device-0001" });
    if (made.state) {
      let a: DraftState = made.state;
      for (let g = 0; a.status === "DRAFTING" && g < 400; g++) {
        const lot = a.auction!.lot!;
        const res = await call(auction, "/bid", { action: lot.holder !== "USER" && (lot.bid ?? 0) < 1 ? "bid" : "pass" });
        a = res.error ? (await call(auction, "/bid", { action: "pass" })).state : res.state;
      }
      await call(auction, "/start-match");
    }
    for (const q of queries) {
      const { results } = await (d1 as any).prepare(q.sql).bind().all();
      expect(Array.isArray(results), q.name).toBe(true);
    }
    // The headline query separates the two ways of drafting
    const rec = (await (d1 as any).prepare(queries[0].sql).bind().all()).results as any[];
    expect(rec.some((r) => r.mode === "snake")).toBe(true);
    if (made.state) expect(rec.some((r) => r.mode === "auction" && r.bidder === "impulsive")).toBe(true);
    const prices = (await (d1 as any).prepare(queries[1].sql).bind().all()).results as any[];
    if (made.state) expect(prices.length).toBeGreaterThan(0);
  }, 180_000);
});
