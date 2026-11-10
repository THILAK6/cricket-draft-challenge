import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { d1, lcg } from "./support/db";
import { affordable, AUCTION, aiBids, aiCeiling, basePrice, bidOn, fairPrice, increment, lotOrder, MARQUEE, MIN_PRICE, nextBid, passOn, startLot } from "../src/core/auction";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { playerQuality } from "../src/core/player-quality";
import type { AuctionLot, DraftState, PlayerWithStats } from "../src/core/types";

const mk = (id: string, role: PlayerWithStats["primary_role"], cat: PlayerWithStats["bowling_category"] = "NONE"): PlayerWithStats => ({
  id, name: id, country: "IND", batting_hand: "RHB", bowling_category: cat, primary_role: role,
  stats: { player_id: id, format: "T20", matches: 80, bat_innings: 60, bat_runs: 1500, bat_average: 28, bat_strike_rate: 130, top_order_innings: 20, middle_order_innings: 30, finisher_innings: 10, bowl_innings: 0, bowl_overs: 0, bowl_wickets: 0, bowl_average: 0, bowl_economy: 0 },
});

describe("auction rules", () => {
  it("prices from rating points: about 15 crore for the best, a few for a good player, little for a squad player", () => {
    expect(fairPrice(110)).toBeGreaterThan(14);
    expect(fairPrice(70)).toBeGreaterThan(3);
    expect(fairPrice(70)).toBeLessThan(6);
    expect(fairPrice(40)).toBeLessThan(1);
    expect(fairPrice(30)).toBe(MIN_PRICE);
    const ps = [30, 45, 60, 75, 90, 105].map(fairPrice);
    expect([...ps].sort((a, b) => a - b)).toEqual(ps);
  });

  it("opens higher for stars and steps up by 25 lakh, 50 lakh, then a crore", () => {
    expect([95, 80, 60, 40].map(basePrice)).toEqual([2, 1, 0.5, 0.2]);
    expect([0.2, 1.75, 2, 4.5, 5, 9].map(increment)).toEqual([0.25, 0.25, 0.5, 0.5, 1, 1]);
    let lot = { bid: null as number | null, base: 1 };
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      const b = nextBid(lot);
      seen.push(b);
      lot = { ...lot, bid: b };
    }
    expect(seen).toEqual([1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
  });

  it("brings the marquee six first, then each set, every player once", () => {
    const pool = [
      ...Array.from({ length: 12 }, (_, i) => mk(`bat${i}`, "BAT")),
      mk("wk1", "WK"), mk("wk2", "WK"), mk("ar1", "AR", "PACE"), mk("ar2", "AR", "SPIN"),
      ...Array.from({ length: 5 }, (_, i) => mk(`pace${i}`, "BOWL", "PACE")),
      ...Array.from({ length: 4 }, (_, i) => mk(`spin${i}`, "BOWL", "SPIN")),
    ];
    const q = (p: PlayerWithStats) => ({ bat0: 100, bat1: 99, wk1: 98, pace0: 97, spin0: 96, ar1: 95 }[p.id] ?? 50);
    const order = lotOrder(pool, q, lcg(3));
    expect(order.map((o) => o.id).sort()).toEqual(pool.map((p) => p.id).sort());
    expect(order.slice(0, MARQUEE).map((o) => o.set)).toEqual(Array(MARQUEE).fill("Marquee"));
    expect(order.slice(0, MARQUEE).map((o) => o.id).sort()).toEqual(["ar1", "bat0", "bat1", "pace0", "spin0", "wk1"]);
    const sets = order.slice(MARQUEE).map((o) => o.set);
    expect([...new Set(sets)]).toEqual(["Batters", "Wicketkeepers", "All-rounders", "Fast bowlers", "Spinners"]);
    // Same seed, same order
    expect(lotOrder(pool, q, lcg(3))).toEqual(order);
  });

  it("sells to whoever holds the bid when the other passes; two passes at the start leave it unsold", () => {
    const p = mk("x", "BAT");
    let lot: AuctionLot = startLot({ log: [] }, p, "Batters", 80);
    expect(lot).toMatchObject({ base: 1, bid: null, holder: null, turn: "USER" });
    lot = bidOn(lot, "USER");
    expect(lot).toMatchObject({ bid: 1, holder: "USER", turn: "AI", raises: 1 });
    lot = bidOn(lot, "AI");
    expect(lot).toMatchObject({ bid: 1.25, holder: "AI", turn: "USER" });
    const sold = passOn(lot, "USER");
    expect(sold.outcome).toEqual({ sold: { to: "AI", price: 1.25 } });
    // Nobody bids
    const open = startLot({ log: [{} as any] }, p, "Batters", 80);
    expect(open.turn).toBe("AI"); // the sides open in turn
    const first = passOn(open, "AI");
    expect(first.outcome).toBeNull();
    expect(first.lot.turn).toBe("USER");
    expect(passOn(first.lot, "USER").outcome).toEqual({ unsold: true });
  });

  it("keeps back the minimum for every slot still to fill", () => {
    expect(affordable(AUCTION.purse, 11)).toBe(AUCTION.purse - 10 * MIN_PRICE);
    expect(affordable(5, 1)).toBe(5);
    expect(affordable(5, 0)).toBe(0);
  });

  it("a calculated bidder stops at its valuation; an impulsive one is carried away by a war, a famous name and its mood", () => {
    const base = { valuation: 6, seed: "room", playerId: "p", matches: 0, heat: 0 };
    expect(aiCeiling({ ...base, style: "calculated" })).toBe(6);
    expect(aiCeiling({ ...base, style: "calculated", heat: 4, matches: 200 })).toBe(6);
    // Impulsive: between 75% and 135% of the valuation (before fame and heat), and the same on a replay
    const ceilings = Array.from({ length: 60 }, (_, i) => aiCeiling({ ...base, style: "impulsive", playerId: `p${i}` }));
    expect(Math.min(...ceilings)).toBeGreaterThanOrEqual(6 * 0.75 - 0.01);
    expect(Math.max(...ceilings)).toBeLessThanOrEqual(6 * 1.35 + 0.01);
    expect(new Set(ceilings.map((c) => Math.round(c * 10))).size).toBeGreaterThan(10);
    expect(aiCeiling({ ...base, style: "impulsive" })).toBe(aiCeiling({ ...base, style: "impulsive" }));
    const warm = aiCeiling({ ...base, style: "impulsive", heat: 4, matches: 150 });
    expect(warm).toBeGreaterThan(aiCeiling({ ...base, style: "impulsive" }));
    // Never above what it can afford
    expect(aiBids({ ...base, style: "calculated" }, 5, 4)).toBe(false);
    expect(aiBids({ ...base, style: "calculated" }, 5, 10)).toBe(true);
    expect(aiBids({ ...base, style: "calculated" }, 6.5, 10)).toBe(false);
  });
});

const ready = existsSync("data/ipl.sql");
function fakeState() {
  const store = new Map<string, unknown>();
  return { storage: { get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : undefined), put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)) } } as any;
}

describe.skipIf(!ready)("a whole auction through the draft room", () => {
  for (const style of ["calculated", "impulsive"] as const) {
    it(`${style}: both XIs fill within budget and the overseas limit, then the match plays`, async () => {
      const room = new DraftRoom(fakeState(), { DB: d1 });
      const call = async (path: string, body?: unknown) =>
        (await (await room.fetch(new Request(`http://internal${path}`, { method: body === undefined && path.endsWith("/state") ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? (path.endsWith("/state") ? undefined : "{}") : JSON.stringify(body) }))).json()) as any;
      const made = await call("/create", { roomId: `auc_${style}`, format: "T20", league: "IPL", theme: "ipl-all", draftMode: "auction", auctionStyle: style, difficulty: "normal" });
      expect(made.state.draftMode).toBe("auction");
      expect(made.state.auction.style).toBe(style);
      let s: DraftState = (await call("/state")).state;
      // Picks are not made one by one in an auction
      expect((await call("/pick", { playerId: s.pool[0].id })).error).toMatch(/auction/i);
      const q = (id: string) => playerQuality(s.pool.find((p) => p.id === id)!, "T20");
      let guard = 0;
      while (s.status === "DRAFTING" && guard++ < 400) {
        const lot = s.auction!.lot!;
        expect(lot.turn).toBe("USER"); // the room only stops when it is the user's call
        // A simple bidder: goes to the fair price for a good player, never for the rest
        const price = lot.bid === null ? lot.base : lot.bid + (lot.bid < 2 ? 0.25 : lot.bid < 5 ? 0.5 : 1);
        const willing = lot.holder !== "USER" && price <= fairPrice(q(lot.playerId)) * 0.9;
        const res = await call("/bid", { action: willing ? "bid" : "pass" });
        if (res.error) {
          const again = await call("/bid", { action: "pass" });
          expect(again.error, again.error).toBeUndefined();
          s = again.state;
        } else s = res.state;
      }
      expect(s.status).toBe("READY_TO_PLAY");
      for (const [sq, side] of [[s.userPicks, "USER"], [s.aiPicks, "AI"]] as const) {
        expect(sq.every(Boolean), side).toBe(true);
        expect(sq.filter((p) => p && p.country !== "IND").length, side).toBeLessThanOrEqual(4);
        const spent = s.pickLog!.filter((e) => e.by === side).reduce((n, e) => n + (e.price ?? 0), 0);
        expect(s.auction!.purse[side], side).toBeGreaterThanOrEqual(-0.001);
        expect(Math.round((AUCTION.purse - spent) * 100) / 100, side).toBeCloseTo(s.auction!.purse[side], 1);
      }
      expect(s.pickLog!).toHaveLength(22);
      expect(s.pickLog!.every((e, i) => e.n === i + 1 && (e.price ?? 0) >= MIN_PRICE)).toBe(true);
      const done = (await call("/start-match")).state as DraftState;
      expect(done.status).toBe("COMPLETED");
      expect(done.results.review.decisions).toBeUndefined(); // "who was still on the board" does not apply
      expect(done.results.review.winChance.played).toBe(200);
    }, 180_000);
  }
});
