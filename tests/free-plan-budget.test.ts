import { describe, it, expect } from "vitest";
import app from "../src/index";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { canPickPlayer } from "../src/core/validator";
import type { DraftState } from "../src/core/types";

/**
 * Cloudflare Workers Free plan guard rails. Workers get 10 ms of CPU per request; Durable Objects
 * get 30 s. The Worker must only forward (the room builds the draft), and room requests must stay
 * small. Limits here are generous so slow CI machines pass; they catch big regressions, like the
 * old AI that spent 20-100 ms per pick.
 */
const cpu = async (fn: () => unknown) => {
  const t = process.cpuUsage();
  await fn();
  const d = process.cpuUsage(t);
  return (d.user + d.system) / 1000;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

describe("Workers Free plan budget", () => {
  it("keeps every Worker request a cheap forward (the room does the work)", async () => {
    const state = { challenge: { title: "x" }, pool: [], theme: "mixed" };
    const stub = { fetch: async () => Response.json({ success: true, state }) };
    const env = { DRAFT_ROOM: { idFromName: (n: string) => n, get: () => stub }, DB: {} } as any;
    const req = (path: string, body: unknown) => new Request(`http://x${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await app.fetch(req("/api/draft/start", {}), env); // warm-up
    const start: number[] = [];
    const proxy: number[] = [];
    for (let i = 0; i < 30; i++) {
      start.push(await cpu(() => app.fetch(req("/api/draft/start", { format: "ODI" }), env)));
      proxy.push(await cpu(() => app.fetch(req("/api/room/r1/pick", { playerId: "p" }), env)));
    }
    expect(median(start)).toBeLessThan(3);
    expect(median(proxy)).toBeLessThan(3);
  });

  it("keeps room requests small: picks (with the AI's replies) and the saved state", async () => {
    const store = new Map<string, unknown>();
    const state = { storage: { get: async (k: string) => structuredClone(store.get(k)), put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)) } } as any;
    const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(4));
    const room = new DraftRoom(state, {});
    const call = async (path: string, body?: unknown) =>
      (await room.fetch(new Request(`http://x${path}`, { method: path.endsWith("/state") ? "GET" : "POST", body: path.endsWith("/state") ? undefined : JSON.stringify(body ?? {}) }))).json() as any;
    await call("/init", { roomId: "r", challenge, pool, userPicks: Array(11).fill(null), aiPicks: Array(11).fill(null), currentTurn: "USER", round: 1, maxRounds: 11, status: "DRAFTING", lastActionTimestamp: 0, difficulty: "hard", firstPick: "USER" });
    let st: DraftState = (await call("/state")).state;
    const picks: number[] = [];
    while (st.status === "DRAFTING") {
      const p = st.pool.find((q) => canPickPlayer(q, st.userPicks, challenge, undefined, { pool: st.pool, opponentSquad: st.aiPicks }).allowed) ?? st.pool[0];
      let r: any;
      picks.push(await cpu(async () => (r = await call("/pick", { playerId: p.id }))));
      st = r.state;
    }
    expect(median(picks)).toBeLessThan(15);
    await call("/start-match");
    // Saved per room; rooms delete themselves after a week (alarm), so 5 GB holds tens of thousands
    expect(JSON.stringify((await call("/state")).state).length).toBeLessThan(200_000);
  });
});

describe("room cleanup", () => {
  it("schedules its own deletion a week out, and deletes everything when the alarm fires", async () => {
    const { ROOM_TTL_MS } = await import("../src/durable-objects/DraftRoom");
    const store = new Map<string, unknown>();
    let alarmAt = 0;
    const state = {
      storage: {
        get: async (k: string) => structuredClone(store.get(k)),
        put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
        setAlarm: async (t: number) => void (alarmAt = t),
        deleteAll: async () => store.clear(),
      },
    } as any;
    const { challenge, pool } = await buildRandomDraft(d1, "ODI", lcg(8));
    const room = new DraftRoom(state, {});
    const res = await room.fetch(new Request("http://x/init", { method: "POST", body: JSON.stringify({ roomId: "r", challenge, pool, userPicks: Array(11).fill(null), aiPicks: Array(11).fill(null), currentTurn: "USER", round: 1, maxRounds: 11, status: "DRAFTING", lastActionTimestamp: 0 }) }));
    expect(res.status).toBe(200);
    expect(alarmAt - Date.now()).toBeGreaterThan(ROOM_TTL_MS - 60_000);
    await room.alarm();
    expect(store.size).toBe(0);
    expect((await room.fetch(new Request("http://x/state"))).status).toBe(404);
  });
});
