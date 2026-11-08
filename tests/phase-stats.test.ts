import { describe, it, expect } from "vitest";
import { d1, lcg } from "./support/db";
import { getPlayerPool, buildRandomDraft, FULL_MEMBERS } from "../src/worker/challenge-generator";
import { phaseNorm, phaseMixFactors, phaseShape, PHASE_KEYS } from "../src/core/phase-stats";
import { buildHeadToHead } from "../src/core/match-review";
import { eraAdjusted } from "../src/core/era";
import type { PlayerWithStats } from "../src/core/types";

const pool = await getPlayerPool(d1, "T20", 5000, 1);
const byName = (n: string) => pool.find((p) => p.name === n)!;

describe("T20 phase stats", () => {
  it("are loaded for most T20 and ODI players and none in Tests", async () => {
    const full = pool.filter((p) => FULL_MEMBERS.has(p.country) && p.stats.matches >= 15);
    expect(full.filter((p) => p.stats.phases).length / full.length).toBeGreaterThan(0.9);
    const odi = (await getPlayerPool(d1, "ODI", 300, 1)).filter((p) => FULL_MEMBERS.has(p.country) && p.stats.matches >= 30);
    expect(odi.filter((p) => p.stats.phases).length / odi.length).toBeGreaterThan(0.6); // ODI ball-by-ball starts around 2004
    expect((await getPlayerPool(d1, "TEST", 200, 1)).some((p) => p.stats.phases)).toBe(false);
  });

  it("norms match the data (Full Member players), so rebuilt data gets new norms", () => {
    const tot = { pp: [0, 0, 0, 0, 0, 0], mid: [0, 0, 0, 0, 0, 0], death: [0, 0, 0, 0, 0, 0] };
    for (const p of pool) if (FULL_MEMBERS.has(p.country) && p.stats.phases) for (const k of PHASE_KEYS) p.stats.phases[k].forEach((v, i) => (tot[k][i] += v));
    for (const k of PHASE_KEYS) {
      const [runs, balls, outs, bb, br, w] = tot[k];
      const n = phaseNorm("T20")[k];
      expect((runs / balls) * 100 / n.sr).toBeCloseTo(1, 1);
      expect(balls / outs / n.bpo).toBeCloseTo(1, 1);
      expect((br / bb) * 6 / n.econ).toBeCloseTo(1, 1);
      expect(bb / w / n.bpw).toBeCloseTo(1, 1);
    }
  });

  it("puts careers on an average phase mix: finishers' strike rates and death bowlers' economy come down, spinners' go up", () => {
    expect(phaseMixFactors(byName("Kieron Pollard"), "T20").sr).toBeLessThan(0.98);
    expect(phaseMixFactors(byName("Jasprit Bumrah"), "T20").econ).toBeLessThan(0.98);
    expect(phaseMixFactors(byName("Adil Rashid"), "T20").econ).toBeGreaterThan(1.02);
    expect(phaseMixFactors(byName("Jasprit Bumrah"), "TEST").econ).toBe(1);
  });

  it("knows who is good at the death, and stays near normal for small samples", () => {
    // Bumrah at the death: his level (on an average phase mix) times his death shape, well below normal.
    // His shape alone is about 1: he is just as good in every phase.
    const b = byName("Jasprit Bumrah");
    expect(eraAdjusted(b, "T20").stats.bowl_economy * phaseShape(b, "T20", "death").econ).toBeLessThan(0.85 * phaseNorm("T20").all.econ);
    for (const p of pool.filter((x) => x.stats.phases)) {
      for (const k of PHASE_KEYS) {
        const s = phaseShape(p, "T20", k);
        for (const v of [s.sr, s.out, s.econ, s.wkt]) expect(v).toBeGreaterThan(0.4), expect(v).toBeLessThan(2.2);
        if ((p.stats.phases![k][3] ?? 0) < 30) expect(Math.abs(s.econ - 1)).toBeLessThan(0.25);
      }
    }
  });

  it("compares death bowling and finishers in the T20 head-to-head", async () => {
    const { challenge, pool: p } = await buildRandomDraft(d1, "T20", lcg(3));
    const xi = (from: number) => p.slice(from, from + 11) as (PlayerWithStats | null)[];
    const rows = buildHeadToHead(xi(0), xi(11), challenge).rows;
    const death = rows.find((r) => r.key === "death")!;
    expect(death.cols).toMatch(/16-20/);
    expect(rows.find((r) => r.key === "finish")).toBeDefined();
    // The numbers shown are the player's own death overs
    for (const pl of death.user.players ?? []) expect(pl.stat).toMatch(/^[\d.—]+ · \d+$/);
  });

  it("leaves Tests alone", () => {
    const b = byName("Jasprit Bumrah");
    expect(eraAdjusted(b, "TEST").stats.bowl_economy).toBe(eraAdjusted({ ...b, stats: { ...b.stats, phases: undefined } }, "TEST").stats.bowl_economy);
  });
});
