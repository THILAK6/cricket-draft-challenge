import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { buildRandomDraft, getPlayerPool, IPL_MIN_MATCHES } from "../src/worker/challenge-generator";
import { chooseAiPick } from "../src/core/ai-draft";
import { arrangeSquad } from "../src/core/batting-order";
import { simulateCricketMatch } from "../src/core/simulator";
import { eraAdjusted } from "../src/core/era";
import { overseasLimit, validateSquad } from "../src/core/validator";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { IPL_GROUNDS } from "../src/core/ipl-grounds";
import { IPL_THEMES } from "../src/core/themes";
import { iplFranchisesOf } from "../src/core/splits";
import { snakeOrder, type Challenge, type DraftState, type PlayerWithStats } from "../src/core/types";

// The IPL mode needs the data job's output (data/ipl.sql); without it these are skipped
const ready = existsSync("data/ipl.sql");
type Squad = (PlayerWithStats | null)[];

function draft(pool: PlayerWithStats[], challenge: Challenge) {
  let rest = [...pool];
  const u: Squad = Array(11).fill(null), a: Squad = Array(11).fill(null);
  snakeOrder("USER").forEach((by, i) => {
    const mine = by === "USER" ? u : a;
    const p = chooseAiPick({ pool: rest, squad: mine, opponentSquad: by === "USER" ? a : u, challenge, difficulty: "normal", noiseSeed: i, round: i })!.player;
    mine[mine.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
  });
  return [arrangeSquad(u, "T20"), arrangeSquad(a, "T20")] as const;
}

/** An XI drafted alone from the pool, and one drafted from what it left. */
function strongAndWeak(pool: PlayerWithStats[], challenge: Challenge): [Squad, Squad] {
  const alone = (from: PlayerWithStats[]) => {
    let rest = [...from];
    const xi: Squad = Array(11).fill(null);
    for (let i = 0; i < 11; i++) {
      const p = chooseAiPick({ pool: rest, squad: xi, opponentSquad: Array(11).fill(null), challenge, difficulty: "normal", noiseSeed: 1, round: i })!.player;
      xi[xi.indexOf(null)] = p;
      rest = rest.filter((q) => q.id !== p.id);
    }
    return { xi: arrangeSquad(xi, "T20"), rest };
  };
  const strong = alone(pool);
  return [strong.xi, alone(strong.rest).xi];
}

describe.skipIf(!ready)("IPL mode", () => {
  it("loads the league's players with the league's own numbers, phases and positions", async () => {
    const pool = await getPlayerPool(d1, "T20", 1000, IPL_MIN_MATCHES, "IPL");
    expect(pool.length).toBeGreaterThan(200);
    for (const p of pool) {
      expect(p.stats.league).toBe("IPL");
      expect(p.stats.format).toBe("T20"); // the engine plays it as T20
      expect(p.stats.matches).toBeGreaterThanOrEqual(IPL_MIN_MATCHES);
    }
    // Most have phase and position records, and the league is mostly Indian
    expect(pool.filter((p) => p.stats.phases).length / pool.length).toBeGreaterThan(0.95);
    expect(pool.filter((p) => p.stats.splits?.pos).length / pool.length).toBeGreaterThan(0.95);
    expect(pool.filter((p) => p.country === "IND").length / pool.length).toBeGreaterThan(0.5);
    // International T20 players are not mixed in: the international pool has no league tag
    const intl = await getPlayerPool(d1, "T20", 200, 15);
    expect(intl.every((p) => !p.stats.league)).toBe(true);
  });

  it("knows the league's stars by role, bowling type and country", async () => {
    const pool = await getPlayerPool(d1, "T20", 1000, 20, "IPL");
    const by = (n: string) => pool.find((p) => p.name === n);
    const kohli = by("Virat Kohli") ?? by("V Kohli");
    expect(kohli?.primary_role).toBe("BAT");
    const rashid = by("Rashid Khan");
    expect(rashid?.country).toBe("AFG"); // overseas, so he counts against the limit
    const chahal = by("Yuzvendra Chahal") ?? by("YS Chahal");
    expect(chahal?.bowling_category).toBe("SPIN");
    const bumrah = by("Jasprit Bumrah") ?? by("JJ Bumrah");
    expect(bumrah?.bowling_category).toBe("PACE");
    // The IPL era adjustment uses the IPL's own seasons: a modern star's strike rate comes down, an early one's goes up
    const years = pool.map((p) => ({ p, a: eraAdjusted(p, "T20").stats.bat_strike_rate / Math.max(1, p.stats.bat_strike_rate) }));
    expect(Math.min(...years.map((y) => y.a))).toBeLessThan(1);
    expect(Math.max(...years.map((y) => y.a))).toBeGreaterThan(1);
  });

  it("builds IPL drafts at IPL grounds with the overseas limit, feasible for two XIs", async () => {
    for (let k = 0; k < 8; k++) {
      const { challenge, pool, theme } = await buildRandomDraft(d1, "T20", lcg(70 + k), "ipl-all", "IPL");
      expect(challenge.league).toBe("IPL");
      expect(challenge.format).toBe("T20");
      expect(IPL_GROUNDS.map((g) => g.name)).toContain(challenge.venue.name);
      expect(overseasLimit(challenge)).toEqual({ home: "IND", value: 4 });
      expect(theme).toBe("ipl-all");
      expect(pool).toHaveLength(44);
      expect(pool.filter((p) => p.country === "IND").length).toBeGreaterThanOrEqual(14);
    }
  });

  it("drafts two legal XIs (never more than four overseas) and plays a match with IPL-sized scores", async () => {
    const totals: number[] = [];
    for (let k = 0; k < 6; k++) {
      const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(200 + k), "ipl-all", "IPL");
      const [u, a] = draft(pool, challenge);
      for (const squad of [u, a]) {
        expect(squad.filter((p) => p && p.country !== "IND").length).toBeLessThanOrEqual(4);
        // Rules the pool ran dry of (the IPL has few genuine all-rounders) are waived, as in the real draft; the overseas limit never is
        expect(validateSquad(squad.filter((p): p is PlayerWithStats => !!p), challenge).violations.filter((v) => /overseas/i.test(v))).toEqual([]);
      }
      for (let s = 0; s < 4; s++) {
        const r = simulateCricketMatch(u, a, challenge, s + 1);
        totals.push(r.userInnings.totalRuns, r.aiInnings.totalRuns);
        expect(r.userInnings.totalBalls).toBeGreaterThan(0);
      }
    }
    const mean = totals.reduce((x, y) => x + y, 0) / totals.length;
    // The league's real first innings is about 169: a generous band here (calibration is checked by the scoring audit)
    expect(mean).toBeGreaterThan(130);
    expect(mean).toBeLessThan(230);
  }, 120_000);

  it("builds every franchise theme from that club's players, at its home ground, without falling back", async () => {
    const clubs = IPL_THEMES.filter((t) => t.franchises);
    expect(clubs.length).toBeGreaterThanOrEqual(8);
    for (const theme of clubs) {
      for (let k = 0; k < 3; k++) {
        const { challenge, pool, theme: used } = await buildRandomDraft(d1, "T20", lcg(500 + k), theme.key, "IPL");
        expect(used, theme.key).toBe(theme.key);
        expect(pool.every((p) => iplFranchisesOf(p.id).some((c) => theme.franchises!.includes(c))), theme.key).toBe(true);
        const home = IPL_GROUNDS.find((g) => g.name === challenge.venue.name)!;
        expect(theme.franchises!, `${theme.key} at ${home.name}`).toContain(home.home);
        expect(pool.filter((p) => p.country === "IND").length).toBeGreaterThanOrEqual(14);
      }
    }
  }, 120_000);

  it("rewards the better draft: the XI drafted first wins most of the replays", async () => {
    let wins = 0, played = 0;
    for (let k = 0; k < 8; k++) {
      const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(300 + k), "ipl-all", "IPL");
      const [strong, weak] = strongAndWeak(pool, challenge);
      for (let s = 0; s < 20; s++) {
        const r = simulateCricketMatch(strong, weak, challenge, 1000 * k + s);
        played++;
        if (r.winner === "USER") wins++;
      }
    }
    expect(wins / played).toBeGreaterThan(0.58);
  }, 180_000);

  it("runs a whole room: IPL draft, match, saved with its league", async () => {
    const store = new Map<string, unknown>();
    const state = { storage: { get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : undefined), put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)) } } as any;
    const room = new DraftRoom(state, { DB: d1 });
    const call = async (path: string, body?: unknown) =>
      (await (await room.fetch(new Request(`http://internal${path}`, { method: body === undefined && path.endsWith("/state") ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? (path.endsWith("/state") ? undefined : "{}") : JSON.stringify(body) }))).json()) as any;
    const made = await call("/create", { roomId: "ipl1", format: "T20", league: "IPL", theme: "ipl-all", difficulty: "normal" });
    expect(made.state.challenge.league).toBe("IPL");
    let s: DraftState = (await call("/state")).state;
    while (s.status === "DRAFTING") {
      const p = chooseAiPick({ pool: s.pool, squad: s.userPicks, opponentSquad: s.aiPicks, challenge: s.challenge, difficulty: "normal", noiseSeed: 1, round: s.round })!.player;
      const res = await call("/pick", { playerId: p.id });
      expect(res.success, res.error).toBe(true);
      s = res.state;
    }
    expect(s.userPicks.filter((p) => p && p.country !== "IND").length).toBeLessThanOrEqual(4);
    const done = (await call("/start-match")).state as DraftState;
    expect(done.status).toBe("COMPLETED");
    expect(done.challenge.league).toBe("IPL");
    expect(done.results.review.typical.played).toBe(200);
  }, 120_000);
});
