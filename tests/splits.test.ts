import { describe, it, expect } from "vitest";
import { d1, lcg } from "./support/db";
import { getPlayerPool, buildRandomDraft, FULL_MEMBERS } from "../src/worker/challenge-generator";
import { chaseShape, positionShape, regionShape, venueParFactor, venuePar, positionRecord, formatNorms } from "../src/core/splits";
import { chooseAiPick } from "../src/core/ai-draft";
import { arrangeSquad } from "../src/core/batting-order";
import { simulateCricketMatch } from "../src/core/simulator";
import type { Challenge, MatchFormat, PlayerWithStats } from "../src/core/types";

const pools = new Map<MatchFormat, PlayerWithStats[]>();
const pool = async (f: MatchFormat) => {
  if (!pools.has(f)) pools.set(f, await getPlayerPool(d1, f, 5000, 1));
  return pools.get(f)!;
};
const byName = async (f: MatchFormat, n: string) => (await pool(f)).find((p) => p.name === n)!;

describe("player splits", () => {
  it("are loaded for most players in every format", async () => {
    for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
      const regular = (await pool(f)).filter((p) => FULL_MEMBERS.has(p.country) && p.stats.matches >= 30);
      expect(regular.filter((p) => p.stats.splits?.pos).length / regular.length, f).toBeGreaterThan(0.6);
    }
  });

  it("know where a player bats: an opener's record is opening", async () => {
    const warner = await byName("T20", "David Warner");
    expect(positionRecord(warner, 1).innings).toBeGreaterThan(50);
    expect(positionRecord(warner, 9).innings).toBe(0);
  });

  it("reward the situations a player is good in", async () => {
    // Kohli is the chaser: he is dismissed less often chasing than setting a total
    const kohli = await byName("ODI", "Virat Kohli");
    expect(chaseShape(kohli, "ODI", true).out).toBeLessThan(chaseShape(kohli, "ODI", false).out);
    // Ashwin takes wickets more often at home (Asia) than in England/Australia/NZ/South Africa
    const ashwin = await byName("TEST", "Ravichandran Ashwin");
    expect(regionShape(ashwin, "TEST", "IND").wkt).toBeGreaterThan(regionShape(ashwin, "TEST", "ENG").wkt);
  });

  it("stay near normal for small samples, and never run wild", async () => {
    for (const f of ["T20", "ODI", "TEST"] as MatchFormat[]) {
      for (const p of (await pool(f)).filter((x) => x.stats.splits).slice(0, 400)) {
        const shapes = [positionShape(p, f, 1), positionShape(p, f, 4), positionShape(p, f, 9), regionShape(p, f, "IND"), regionShape(p, f, "AUS"), regionShape(p, f, "WI")];
        if (f !== "TEST") shapes.push(chaseShape(p, f, true));
        for (const s of shapes) for (const v of [s.sr, s.out, s.econ, s.wkt]) expect(v).toBeGreaterThan(0.3), expect(v).toBeLessThan(2.5);
      }
    }
  });

  it("know the grounds: Wankhede is a high-scoring ODI ground, Mirpur a low one", () => {
    expect(venueParFactor("ODI", "Wankhede Stadium, Mumbai")).toBeGreaterThan(1.05);
    expect(venueParFactor("ODI", "Shere Bangla National Stadium, Dhaka")).toBeLessThan(0.97);
    expect(venueParFactor("T20", "Nowhere Park")).toBe(1);
    expect(venuePar("ODI", "Wankhede Stadium, Mumbai")!.avg).toBeGreaterThan(formatNorms("ODI").par.all);
  });

  it("make the same two XIs score more at a high-scoring ground", async () => {
    const { challenge, pool: p } = await buildRandomDraft(d1, "T20", lcg(5));
    let rest = [...p];
    const a: (PlayerWithStats | null)[] = Array(11).fill(null), b: (PlayerWithStats | null)[] = Array(11).fill(null);
    for (let i = 0; i < 22; i++) {
      const s = (Math.floor(i / 2) % 2 === 0) === (i % 2 === 0) ? a : b;
      const pick = chooseAiPick({ pool: rest, squad: s, opponentSquad: s === a ? b : a, challenge, difficulty: "normal", noiseSeed: 1, round: i })!.player;
      s[s.indexOf(null)] = pick;
      rest = rest.filter((q) => q.id !== pick.id);
    }
    const A = arrangeSquad(a, "T20"), B = arrangeSquad(b, "T20");
    const avg = (name: string, country: string) => {
      const ch: Challenge = { ...challenge, venue: { name, country, pitch_type: "HIGH_SCORING_FLAT" }, constraints: [] };
      let t = 0;
      for (let s = 1; s <= 80; s++) {
        const m = simulateCricketMatch(A, B, ch, s);
        t += m.userInnings.totalRuns + m.aiInnings.totalRuns;
      }
      return t / 160;
    };
    expect(avg("Wankhede Stadium, Mumbai", "IND")).toBeGreaterThan(avg("Sheikh Zayed Stadium, Abu Dhabi", "UAE") + 15);
  });
});
