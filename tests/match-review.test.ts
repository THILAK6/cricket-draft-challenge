import { describe, it, expect } from "vitest";
import { d1, lcg } from "./support/db";
import { buildRandomDraft, getPlayerPool } from "../src/worker/challenge-generator";
import { chooseAiPick } from "../src/core/ai-draft";
import { arrangeSquad } from "../src/core/batting-order";
import { simulateCricketMatch } from "../src/core/simulator";
import { buildHeadToHead, buildDraftAwards, estimateWinChance, buildMatchReview } from "../src/core/match-review";
import { snakeOrder, type Challenge, type MatchFormat, type PickLogEntry, type PlayerWithStats } from "../src/core/types";

type Squad = (PlayerWithStats | null)[];

/** A snake draft between two AI personalities, with the pick log the draft room keeps. */
function draft(pool: PlayerWithStats[], challenge: Challenge, f: MatchFormat, user: "easy" | "normal" | "hard" = "normal") {
  let rest = [...pool];
  const u: Squad = Array(11).fill(null), a: Squad = Array(11).fill(null);
  const log: PickLogEntry[] = [];
  snakeOrder("USER").forEach((by, i) => {
    const mine = by === "USER" ? u : a;
    const p = chooseAiPick({ pool: rest, squad: mine, opponentSquad: by === "USER" ? a : u, challenge, difficulty: by === "USER" ? user : "normal", noiseSeed: i, round: i })!.player;
    mine[mine.indexOf(null)] = p;
    rest = rest.filter((q) => q.id !== p.id);
    log.push({ n: i + 1, by, playerId: p.id, name: p.name, country: p.country, role: p.primary_role });
  });
  return { user: arrangeSquad(u, f), ai: arrangeSquad(a, f), log, rest };
}

/** An XI drafted alone from the pool, and one drafted from what it left. */
function strongAndWeak(pool: PlayerWithStats[], challenge: Challenge, f: MatchFormat): [Squad, Squad] {
  const alone = (from: PlayerWithStats[]) => {
    let rest = [...from];
    const xi: Squad = Array(11).fill(null);
    for (let i = 0; i < 11; i++) {
      const p = chooseAiPick({ pool: rest, squad: xi, opponentSquad: Array(11).fill(null), challenge, difficulty: "normal", noiseSeed: 1, round: i })!.player;
      xi[xi.indexOf(null)] = p;
      rest = rest.filter((q) => q.id !== p.id);
    }
    return { xi: arrangeSquad(xi, f), rest };
  };
  const strong = alone(pool);
  return [strong.xi, alone(strong.rest).xi];
}

describe("head to head", () => {
  it("compares every unit (death bowling and finishers in white-ball cricket), and identical XIs are level everywhere", async () => {
    const { challenge, pool } = await buildRandomDraft(d1, "ODI", lcg(3));
    const { user } = draft(pool, challenge, "ODI");
    const h = buildHeadToHead(user, user, challenge);
    expect(h.rows.map((r) => r.key)).toEqual(["openers", "middle", "keeper", "allrounders", "pace", "spin", "death", "finish", "depth", "pitch"]);
    expect(h.rows.find((r) => r.key === "death")!.cols).toMatch(/41-50/);
    const test = await buildRandomDraft(d1, "TEST", lcg(3));
    expect(buildHeadToHead(test.pool.slice(0, 11), test.pool.slice(11, 22), test.challenge).rows.map((r) => r.key)).not.toContain("death");
    expect(h.rows.every((r) => r.edge === "EVEN")).toBe(true);
    expect(h.won).toEqual({ USER: 0, AI: 0 });
  });

  it("shows career numbers, never a rating", async () => {
    const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(4));
    const { user, ai } = draft(pool, challenge, "T20");
    for (const r of buildHeadToHead(user, ai, challenge).rows) {
      for (const s of [r.user.stat, r.ai.stat]) expect(s).not.toMatch(/rating|points/i);
    }
  });

  it("gives the XI drafted first from the pool most of the match-ups", async () => {
    for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
      let strongWon = 0, weakWon = 0;
      for (let d = 0; d < 6; d++) {
        const { challenge, pool } = await buildRandomDraft(d1, f, lcg(900 + d));
        const [strong, weak] = strongAndWeak(pool, challenge, f);
        const h = buildHeadToHead(strong, weak, challenge);
        strongWon += h.won.USER;
        weakWon += h.won.AI;
      }
      expect(strongWon, f).toBeGreaterThan(weakWon * 1.5);
    }
  });
});

describe("draft awards", () => {
  it("names three different players: a late steal, your best pick, and one you could have had", async () => {
    let regrets = 0;
    for (let d = 0; d < 8; d++) {
      const f: MatchFormat = d % 2 ? "ODI" : "T20";
      const { challenge, pool } = await buildRandomDraft(d1, f, lcg(40 + d));
      const { user, ai, log } = draft(pool, challenge, f, "easy");
      const sim = simulateCricketMatch(user, ai, challenge, 100 + d);
      const awards = buildDraftAwards(log, sim.matchFacts?.contributions);
      expect(new Set(awards.map((a) => a.name)).size).toBe(awards.length);
      for (const a of awards) {
        if (a.kind === "steal") expect(a.pick).toBeGreaterThan(11);
        if (a.kind === "best") expect(a.team).toBe("USER");
        if (a.kind === "regret" && a.team === "AI") {
          regrets++;
          // ...and it was still on the board at one of your picks
          expect(log.some((e) => e.by === "USER" && e.n < a.pick)).toBe(true);
        }
      }
    }
    expect(regrets).toBeGreaterThan(0);
  });

  it("gives no awards without a pick log", () => {
    expect(buildDraftAwards(undefined, [])).toEqual([]);
  });
});

describe("win chance", () => {
  it("replays the same two XIs: repeatable, and the stronger XI wins most of them", async () => {
    const { challenge, pool } = await buildRandomDraft(d1, "T20", lcg(77));
    const [strong, weak] = strongAndWeak(pool, challenge, "T20");
    const replay = (s: number) => simulateCricketMatch(strong, weak, challenge, s);
    const a = estimateWinChance(replay, 1234, 80);
    expect(a).toEqual(estimateWinChance(replay, 1234, 80));
    expect(a.wins + a.losses + a.draws).toBe(80);
    expect(a.wins).toBeGreaterThan(a.losses);
  });

  it("is part of the review only when the match can be replayed", async () => {
    const { challenge, pool } = await buildRandomDraft(d1, "ODI", lcg(5));
    const { user, ai, log } = draft(pool, challenge, "ODI");
    const sim = simulateCricketMatch(user, ai, challenge, 9);
    expect(buildMatchReview({ userSquad: user, aiSquad: ai, challenge, simulation: sim, pickLog: log }).winChance).toBeUndefined();
    const r = buildMatchReview({ userSquad: user, aiSquad: ai, challenge, simulation: sim, pickLog: log, seed: 9, replay: (s) => simulateCricketMatch(user, ai, challenge, s) });
    expect(r.winChance!.played).toBe(200);
  });
});

describe("Test match endings", () => {
  it("never declares behind, and never leaves a token over for the last innings", async () => {
    for (let d = 0; d < 12; d++) {
      const { challenge, pool } = await buildRandomDraft(d1, "TEST", lcg(300 + d));
      // A lopsided pair, so follow-ons happen: a proper XI against eleven batters who can't bowl,
      // who follow on and try to bat out the time
      const [strong] = strongAndWeak(pool, challenge, "TEST");
      const batters = [...pool].filter((p) => !strong.includes(p) && (p.primary_role === "BAT" || p.primary_role === "WK"));
      const weak: Squad = arrangeSquad(batters.slice(0, 11), "TEST");
      for (let s = 1; s <= 4; s++) {
        const m = simulateCricketMatch(d % 2 ? strong : weak, d % 2 ? weak : strong, challenge, d * 100 + s);
        const inns = [m.userInnings, m.aiInnings, m.userSecondInnings, m.aiSecondInnings].filter((x) => x && x.totalBalls > 0);
        const both = (side: "USER" | "AI") => (side === "USER" ? m.userInnings.totalRuns + (m.userSecondInnings?.totalRuns ?? 0) : m.aiInnings.totalRuns + (m.aiSecondInnings?.totalRuns ?? 0));
        const first = (side: "USER" | "AI") => (side === "USER" ? m.userInnings : m.aiInnings).totalRuns;
        // A declared second innings (always the third of the match) leaves the other side something to chase
        for (const [inn, side] of [[m.userSecondInnings, "USER"], [m.aiSecondInnings, "AI"]] as const) {
          if (inn?.declared) expect(both(side), m.summary).toBeGreaterThan(first(side === "USER" ? "AI" : "USER"));
        }
        // A chase gets proper time (not a single over) unless it was won quickly
        const last = inns[inns.length - 1]!;
        if (inns.length === 4 && m.winner === "DRAW") expect(last.totalBalls, m.summary).toBeGreaterThan(6);
        expect(m.summary).not.toMatch(/Day 5 \(0\/0/);
      }
    }
  });
});

describe("bowling styles", () => {
  it("files the great spinners as spinners in every format", async () => {
    // Warne, Kumble, Lyon, MacGill, Kaneria, Panesar (the source data had them as medium pacers)
    const ids = ["crick_bb18be76", "crick_0c2730df", "crick_96a6a7ad", "crick_60dac349", "crick_0be1b885", "crick_5a37ec26"];
    for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
      const all = await getPlayerPool(d1, f, 5000, 1);
      for (const id of ids) {
        const p = all.find((x) => x.id === id);
        if (p) expect(p.bowling_category, `${p.name} ${f}`).toBe("SPIN");
      }
    }
  });
});
