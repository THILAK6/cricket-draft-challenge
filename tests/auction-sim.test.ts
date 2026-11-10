import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { d1 } from "./support/db";
import { AUCTION, fairPrice, nextBid } from "../src/core/auction";
import { DraftRoom } from "../src/durable-objects/DraftRoom";
import { chooseAiPick } from "../src/core/ai-draft";
import { playerQuality } from "../src/core/player-quality";
import { simulateCricketMatch } from "../src/core/simulator";
import type { DraftState, PlayerWithStats } from "../src/core/types";

// Compares the two AI bidders. AUCTION_SIM=<file> AUCTION_N=<auctions each> AUCTION_PURSE=<crore> npx vitest run tests/auction-sim.test.ts
const out = process.env.AUCTION_SIM;
const N = Number(process.env.AUCTION_N ?? 30);

function fakeState() {
  const store = new Map<string, unknown>();
  return { storage: { get: async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : undefined), put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)) } } as any;
}

/** One auction: a calculated "human" (bids to the same valuation the AI uses) against an AI of the given style. */
async function play(style: "calculated" | "impulsive", id: string, difficulty: "easy" | "normal" | "hard" = "normal") {
  const room = new DraftRoom(fakeState(), { DB: d1 });
  const call = async (path: string, body?: unknown) =>
    (await (await room.fetch(new Request(`http://internal${path}`, { method: body === undefined && path.endsWith("/state") ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? (path.endsWith("/state") ? undefined : "{}") : JSON.stringify(body) }))).json()) as any;
  const made = await call("/create", { roomId: id, format: "T20", league: "IPL", theme: "ipl-all", draftMode: "auction", auctionStyle: style, difficulty });
  let s: DraftState = made.state;
  const all = new Map<string, PlayerWithStats>(s.pool.map((p) => [p.id, p]));
  for (let guard = 0; s.status === "DRAFTING" && guard < 400; guard++) {
    const lot = s.auction!.lot!;
    const p = all.get(lot.playerId)!;
    const priced = chooseAiPick({ pool: s.pool, squad: s.userPicks, opponentSquad: s.aiPicks, challenge: s.challenge, difficulty: "normal", noiseSeed: 1, round: s.auction!.log.length, candidates: [p] });
    const value = priced ? fairPrice(Math.min(priced.total ?? 0, playerQuality(p, "T20") + 25)) : 0;
    const price = nextBid(lot);
    const res = await call("/bid", { action: lot.holder !== "USER" && price <= value ? "bid" : "pass" });
    s = res.error ? (await call("/bid", { action: "pass" })).state : res.state;
  }
  return { s, all };
}

it.skipIf(!out)("compares the calculated and impulsive bidders", async () => {
  if (process.env.AUCTION_PURSE) AUCTION.purse = Number(process.env.AUCTION_PURSE);
  const lines: string[] = [`purse ${AUCTION.purse} crore; ${N} auctions per style; a calculated bidder as "you"`, ""];
  const q = (p: PlayerWithStats) => playerQuality(p, "T20");
  for (const style of ["calculated", "impulsive"] as const) {
    const m = { youQ: 0, aiQ: 0, youLeft: 0, aiLeft: 0, win: 0, played: 0, aiRatio: 0, aiN: 0, youRatio: 0, youN: 0, aiBargain: 0, aiOverpay: 0, youBargain: 0, youOverpay: 0, starsYou: 0, starsAi: 0, accel: 0, aiSpend: [] as number[], youSpend: [] as number[] };
    for (let k = 0; k < N; k++) {
      const { s, all } = await play(style, `sim_${style}_${k}`);
      const squadQ = (sq: (PlayerWithStats | null)[]) => sq.reduce((n, p) => n + (p ? q(p) : 0), 0) / 11;
      m.youQ += squadQ(s.userPicks); m.aiQ += squadQ(s.aiPicks);
      m.youLeft += s.auction!.purse.USER; m.aiLeft += s.auction!.purse.AI;
      m.youSpend.push(AUCTION.purse - s.auction!.purse.USER); m.aiSpend.push(AUCTION.purse - s.auction!.purse.AI);
      if (s.auction!.accelerated) m.accel++;
      for (const e of s.pickLog!) {
        const fair = fairPrice(q(all.get(e.playerId)!));
        const r = (e.price ?? 0) / Math.max(0.2, fair);
        if (e.by === "AI") { m.aiRatio += r; m.aiN++; if (r <= 0.6) m.aiBargain++; if (r >= 1.3) m.aiOverpay++; if (q(all.get(e.playerId)!) >= 90) m.starsAi++; }
        else { m.youRatio += r; m.youN++; if (r <= 0.6) m.youBargain++; if (r >= 1.3) m.youOverpay++; if (q(all.get(e.playerId)!) >= 90) m.starsYou++; }
      }
      for (let r = 1; r <= 20; r++) {
        const sim = simulateCricketMatch(s.userPicks, s.aiPicks, s.challenge, 977 * k + r);
        m.played++;
        if (sim.winner === "USER") m.win++;
      }
    }
    const f = (x: number, d = 1) => x.toFixed(d);
    lines.push(`== AI bids ${style} ==`);
    lines.push(`XI quality: you ${f(m.youQ / N)} v AI ${f(m.aiQ / N)} | you win ${f((m.win / m.played) * 100, 0)}% of 20 replays each`);
    lines.push(`Left in the purse: you ${f(m.youLeft / N)} v AI ${f(m.aiLeft / N)}; spend range you ${f(Math.min(...m.youSpend))}-${f(Math.max(...m.youSpend))}, AI ${f(Math.min(...m.aiSpend))}-${f(Math.max(...m.aiSpend))}`);
    lines.push(`Price / fair value: AI ${f(m.aiRatio / m.aiN, 2)} (bargains ${f((m.aiBargain / m.aiN) * 100, 0)}%, overpays ${f((m.aiOverpay / m.aiN) * 100, 0)}%) | you ${f(m.youRatio / m.youN, 2)} (bargains ${f((m.youBargain / m.youN) * 100, 0)}%, overpays ${f((m.youOverpay / m.youN) * 100, 0)}%)`);
    lines.push(`Stars (rating 90+) bought per auction: you ${f(m.starsYou / N)} v AI ${f(m.starsAi / N)}; auctions needing the accelerated round: ${m.accel}/${N}`);
    lines.push("");
  }
  writeFileSync(out!, lines.join("\n"));
}, 3_000_000);
