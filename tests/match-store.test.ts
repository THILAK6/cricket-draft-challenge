import { describe, it, expect } from "vitest";
import { d1, lcg } from "./support/db";
import { buildRandomDraft } from "../src/worker/challenge-generator";
import { chooseAiPick } from "../src/core/ai-draft";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { getMatch, isDeviceId, isMatchId, listMatches, newMatchId } from "../src/worker/match-store";
import app from "../src/index";
import type { DraftState, PlayerWithStats } from "../src/core/types";

function fakeState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
    },
  } as any;
}

const call = async (room: DraftRoom, path: string, body?: unknown) =>
  (await (await room.fetch(new Request(`http://internal${path}`, { method: body === undefined && path.endsWith("/state") ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? (path.endsWith("/state") ? undefined : "{}") : JSON.stringify(body) }))).json()) as any;

/** A real draft room on the test database, played to the end, as a given phone. */
async function playRoom(deviceId: string, seed: number) {
  const room = new DraftRoom(fakeState(), { DB: d1 });
  const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(seed));
  await call(room, "/init", { roomId: `r${seed}`, challenge, pool, userPicks: Array(11).fill(null), aiPicks: Array(11).fill(null), currentTurn: "USER", round: 1, maxRounds: 11, status: "DRAFTING", lastActionTimestamp: 0, firstPick: "USER", deviceId } satisfies DraftState);
  let state: DraftState = (await call(room, "/state")).state;
  while (state.status === "DRAFTING") {
    const p = chooseAiPick({ pool: state.pool, squad: state.userPicks, opponentSquad: state.aiPicks, challenge, difficulty: "normal", noiseSeed: 1, round: state.round })!.player;
    state = (await call(room, "/pick", { playerId: p.id })).state;
  }
  return (await call(room, "/start-match")).state as DraftState;
}

describe("saved matches", () => {
  it("makes short share ids and checks the ids it is sent", () => {
    const id = newMatchId(lcg(1));
    expect(isMatchId(id)).toBe(true);
    expect(isMatchId("../x")).toBe(false);
    expect(isDeviceId("a".repeat(32))).toBe(true);
    expect(isDeviceId("x' OR 1=1")).toBe(false);
  });

  it("keeps a finished match exactly as it was shown, small enough for D1, and lists it for its phone only", async () => {
    const dev = "phone_" + "1".repeat(20);
    const other = "phone_" + "2".repeat(20);
    const a = await playRoom(dev, 11);
    const b = await playRoom(dev, 12);
    await playRoom(other, 13);
    expect(isMatchId(a.matchId)).toBe(true);

    const saved = (await getMatch(d1, a.matchId!))!;
    expect(saved.simulation.summary).toBe(a.simulation!.summary);
    expect(saved.results.review).toEqual(JSON.parse(JSON.stringify(a.results.review)));
    expect(saved.userXI.map((p) => p.name)).toEqual(a.userPicks.map((p) => (p as PlayerWithStats).name));
    // No pool, no career numbers, one copy of the simulation
    const raw = JSON.stringify(saved);
    expect(raw).not.toContain('"pool"');
    expect(saved.results.simulation).toBeUndefined();
    expect(raw.length).toBeLessThan(150_000);

    const mine = await listMatches(d1, dev);
    expect(mine.map((m) => m.id)).toEqual(expect.arrayContaining([a.matchId, b.matchId]));
    expect(mine.length).toBe(2);
    expect(mine[0].playedAt).toBeGreaterThanOrEqual(mine[1].playedAt);
    expect(mine.find((m) => m.id === a.matchId)!.winner).toBe(a.simulation!.winner);
  }, 60_000);

  it("serves the list and a match by its share id through the API", async () => {
    const dev = "phone_" + "3".repeat(20);
    const s = await playRoom(dev, 21);
    const env = { DB: d1 } as any;
    const list = (await (await app.fetch(new Request(`http://x/api/matches?device=${dev}`), env)).json()) as any;
    expect(list.matches.map((m: any) => m.id)).toEqual([s.matchId]);
    const one = await app.fetch(new Request(`http://x/api/match/${s.matchId}`), env);
    expect(((await one.json()) as any).match.id).toBe(s.matchId);
    expect((await app.fetch(new Request(`http://x/api/match/zzzzzzzzzz`), env)).status).toBe(404);
    expect((await app.fetch(new Request(`http://x/api/match/bad`), env)).status).toBe(404);
    expect(((await (await app.fetch(new Request(`http://x/api/matches?device=bad`), env)).json()) as any).matches).toEqual([]);
  }, 60_000);

  it("never fails the match when the save fails", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); }, batch: async () => { throw new Error("D1 down"); } } as any;
    const room = new DraftRoom(fakeState(), { DB: broken });
    const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(31));
    await call(room, "/init", { roomId: "r", challenge, pool, userPicks: Array(11).fill(null), aiPicks: Array(11).fill(null), currentTurn: "USER", round: 1, maxRounds: 11, status: "DRAFTING", lastActionTimestamp: 0, firstPick: "USER" } satisfies DraftState);
    let state: DraftState = (await call(room, "/state")).state;
    while (state.status === "DRAFTING") {
      const p = chooseAiPick({ pool: state.pool, squad: state.userPicks, opponentSquad: state.aiPicks, challenge, difficulty: "normal", noiseSeed: 1, round: state.round })!.player;
      state = (await call(room, "/pick", { playerId: p.id })).state;
    }
    const done = (await call(room, "/start-match")).state as DraftState;
    expect(done.status).toBe("COMPLETED");
    expect(done.matchId).toBeUndefined();
  }, 60_000);
});
