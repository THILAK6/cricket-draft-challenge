import { describe, it, expect } from "vitest";
import { lcg } from "./support/db";
import {
  buildDataset, effOf, fitFull, fitSituation, predictRows, predictNaive, rawSkills, rowsOfMatches, score, skillScore, totalSkills, wicketValue,
  type ParsedMatch, type Row,
} from "../src/etl/rating-model";
import { parseT20 } from "../src/etl/cricsheet-parse";

/**
 * A made-up league with known skills, to check the model does what it says:
 * - finds who is good,
 * - does not credit a batter for scoring against weak bowlers,
 * - predicts matches it has not seen better than raw career numbers do.
 */
const TEAMS = 8;
const PER = 11;
const WEAK = new Set([6, 7]); // their bowlers concede 0.35 runs a ball more
const STRONG = new Set([2, 3]);

function league(seed: number, matches: number) {
  const r = lcg(seed);
  const batSkill = new Map<string, number>();
  const bowlSkill = new Map<string, number>();
  const id = (t: number, i: number) => `t${t}p${i}`;
  for (let t = 0; t < TEAMS; t++)
    for (let i = 0; i < PER; i++) {
      batSkill.set(id(t, i), (r() - 0.5) * 0.3);
      bowlSkill.set(id(t, i), (r() - 0.5) * 0.3 + (WEAK.has(t) ? 0.35 : 0)); // runs conceded above average
    }
  const out: ParsedMatch[] = [];
  const draw = (m: number) => {
    const p = Math.max(0.02, Math.min(0.95, m / 4));
    let s = 0;
    for (let k = 0; k < 4; k++) if (r() < p) s++;
    return s;
  };
  for (let m = 0; m < matches; m++) {
    // Team 0's batters mostly meet the weak teams, team 1's the strong ones; the rest mix
    let a = Math.floor(r() * TEAMS), b = Math.floor(r() * TEAMS);
    if (r() < 0.6) {
      a = r() < 0.5 ? 0 : 1;
      const pool = a === 0 ? [6, 7] : [2, 3];
      b = pool[Math.floor(r() * 2)];
    }
    if (a === b) b = (b + 1) % TEAMS;
    const innings: Row[][] = [];
    [[a, b], [b, a]].forEach(([bt, bw], inn) => {
      const rows: Row[] = [];
      let next = 2, down = 0;
      const crease = [id(bt, 0), id(bt, 1)];
      const arrived: string[] = [...crease];
      for (let ball = 0; ball < 120 && down < 10; ball++) {
        const striker = crease[ball % 2];
        const bowler = id(bw, 6 + Math.floor(ball / 24) + (ball % 24 < 12 ? 0 : 0));
        const over = Math.floor(ball / 6);
        const mean = 1.25 + 0.15 * (over >= 15 ? 1 : 0) - 0.1 * (over < 6 ? 1 : 0) + batSkill.get(striker)! + bowlSkill.get(bowler)!;
        const wp = 0.05 - (batSkill.get(striker)! + 0) * 0.1 - (bowlSkill.get(bowler)! - (WEAK.has(bw) ? 0.35 : 0)) * 0.1;
        const wkt = r() < wp ? 1 : 0;
        const pos = arrived.indexOf(striker) + 1;
        rows.push({ bat: striker, bowl: bowler, bt: `T${bt}`, wt: `T${bw}`, ctx: (over < 6 ? 0 : over < 15 ? 1 : 2) * 2 + inn, pos: pos <= 2 ? 0 : pos === 3 ? 1 : pos <= 5 ? 2 : pos <= 7 ? 3 : 4, over, wb: down, runs: wkt ? 0 : draw(mean), wkt, legal: true });
        if (wkt) {
          down++;
          if (next < PER) {
            crease[ball % 2] = id(bt, next);
            arrived.push(id(bt, next));
            next++;
          }
        }
      }
      innings.push(rows);
    });
    out.push({ date: `2020-01-${String(1 + (m % 28)).padStart(2, "0")}T${String(Math.floor(m / 28)).padStart(4, "0")}`, ground: "G", year: 2020, fm: true, innings });
  }
  return { parsed: out, batSkill, bowlSkill, id };
}

const corr = (xs: number[], ys: number[]) => {
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => ((sxy += (x - mx) * (ys[i] - my)), (sxx += (x - mx) ** 2), (syy += (ys[i] - my) ** 2)));
  return sxy / Math.sqrt(sxx * syy);
};

describe("ball-by-ball rating model", () => {
  const L = league(7, 1400);
  const ds = buildDataset(L.parsed);
  const all = rowsOfMatches(ds, 0, ds.matches);

  it("finds who is good, and ranks batters by what they did against who they faced", () => {
    const fit = fitFull(ds, ds.runs, all, { bat: 400, bowl: 400 });
    const tot = totalSkills(ds, fit);
    const ids = ds.batIds, trueB = ids.map((p) => L.batSkill.get(p)!);
    expect(corr(ids.map((_, k) => tot.bat[k]), trueB)).toBeGreaterThan(0.8);
    const bids = ds.bowlIds;
    expect(corr(bids.map((_, k) => tot.bowl[k]), bids.map((p) => L.bowlSkill.get(p)!))).toBeGreaterThan(0.8);
  });

  it("does not credit a batter for runs against weak bowlers (raw career numbers do)", () => {
    const fit = fitFull(ds, ds.runs, all, { bat: 400, bowl: 400 });
    const raw = rawSkills(ds, ds.runs, all, fit.mu, 1);
    const team = (t: number) => ds.batIds.map((p, k) => [p, k] as const).filter(([p]) => p.startsWith(`t${t}p`));
    const avg = (arr: readonly (readonly [string, number])[], f: (k: number) => number) => arr.reduce((s, [, k]) => s + f(k), 0) / arr.length;
    // Team 0 batters faced the weak attacks, team 1's the strong ones, and all are equally good
    const rawGap = avg(team(0), (k) => raw.bat.skill[k]) - avg(team(1), (k) => raw.bat.skill[k]);
    const tot = totalSkills(ds, fit);
    const fitGap = avg(team(0), (k) => tot.bat[k]) - avg(team(1), (k) => tot.bat[k]);
    const trueGap = avg(team(0), (k) => L.batSkill.get(ds.batIds[k])!) - avg(team(1), (k) => L.batSkill.get(ds.batIds[k])!);
    expect(rawGap).toBeGreaterThan(0.15); // raw numbers think team 0 is far better
    expect(Math.abs(fitGap - trueGap)).toBeLessThan(0.05); // the model is not fooled
  });

  it("predicts matches it has not seen better than raw career numbers, however they are shrunk", () => {
    const cut = Math.floor(ds.matches * 0.8);
    const train = rowsOfMatches(ds, 0, cut), test = rowsOfMatches(ds, cut, ds.matches);
    const base = fitSituation(ds, ds.runs, train);
    const s0 = score(ds, ds.runs, test, predictRows(base, test));
    const full = score(ds, ds.runs, test, predictRows(fitFull(ds, ds.runs, train, { bat: 400, bowl: 400 }), test));
    const naive = [30, 100, 300, 1000].map((k) => score(ds, ds.runs, test, predictNaive(ds, base, test, rawSkills(ds, ds.runs, train, base.mu, k))));
    const bestNaive = Math.min(...naive.map((s) => s.mse));
    expect(skillScore(s0.mse, full.mse)).toBeGreaterThan(skillScore(s0.mse, bestNaive));
    expect(full.mse).toBeLessThan(s0.mse);
  });

  it("pulls players with little data towards average, more than players with a lot", () => {
    const light = fitFull(ds, ds.runs, all, { bat: 50, bowl: 50 });
    const heavy = fitFull(ds, ds.runs, all, { bat: 5000, bowl: 5000 });
    const spread = (f: typeof light) => { const e = effOf(f, "batter"); return Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length); };
    expect(spread(heavy)).toBeLessThan(spread(light));
  });

  it("values a wicket in runs from the data: nothing when wickets cost nothing, more when each one slows the scoring", () => {
    // A league where losing a wicket changes nothing except an all-out
    expect(wicketValue(ds).all).toBeLessThan(4);
    // Each wicket down takes 0.12 runs a ball off the rate
    const r = lcg(3);
    const costly: ParsedMatch[] = [];
    for (let m = 0; m < 600; m++) {
      const rows: Row[] = [];
      let down = 0;
      for (let ball = 0; ball < 120 && down < 10; ball++) {
        const wkt = r() < 0.05 ? 1 : 0;
        const mean = 1.6 - 0.12 * down;
        rows.push({ bat: `b${down}`, bowl: "x", bt: "A", wt: "B", ctx: 0, pos: 0, over: Math.floor(ball / 6), wb: down, runs: wkt ? 0 : r() < mean / 4 ? 4 : 0, wkt, legal: true });
        down += wkt;
      }
      costly.push({ date: `2020-01-01T${String(m).padStart(4, "0")}`, ground: "G", year: 2020, fm: true, innings: [rows] });
    }
    const w = wicketValue(buildDataset(costly));
    expect(w.all).toBeGreaterThan(wicketValue(ds).all + 4);
    expect(w.all).toBeLessThan(60);
  });

  it("centres skills on average Full Member play", () => {
    const fit = fitFull(ds, ds.runs, all, { bat: 400, bowl: 400 });
    const t = totalSkills(ds, fit);
    let m = 0;
    for (let i = 0; i < ds.n; i++) m += t.bat[ds.bat[i]];
    expect(Math.abs(m / ds.n)).toBeLessThan(1e-9); // every synthetic match is Full Member v Full Member
  });
});

describe("Cricsheet reader", () => {
  const match = {
    info: { gender: "male", overs: 20, dates: ["2023-03-01"], venue: "Some Ground", teams: ["India", "Nepal"], registry: { people: { A: "a1", B: "b1", C: "c1", D: "d1" } } },
    innings: [
      {
        team: "India",
        overs: [
          { over: 0, deliveries: [
            { batter: "A", bowler: "C", non_striker: "B", runs: { batter: 4, total: 4 } },
            { batter: "A", bowler: "C", non_striker: "B", runs: { batter: 0, total: 1 }, extras: { wides: 1 } },
            { batter: "A", bowler: "C", non_striker: "B", runs: { batter: 0, total: 0 }, wickets: [{ player_out: "A", kind: "bowled" }] },
            { batter: "B", bowler: "C", non_striker: "D", runs: { batter: 1, total: 1 }, wickets: [{ player_out: "D", kind: "run out" }] },
          ] },
        ],
      },
      { team: "Nepal", super_over: true, overs: [] },
    ],
  };
  it("turns deliveries into rows: runs charged, bowler's wickets only, position, wickets down, Full Member flag", () => {
    const m = parseT20(match)!;
    expect(m.fm).toBe(false); // Nepal is an Associate
    const rows = m.innings[0];
    expect(rows.map((r) => r.runs)).toEqual([4, 1, 0, 1]);
    expect(rows.map((r) => r.legal)).toEqual([true, false, true, true]);
    expect(rows.map((r) => r.wkt)).toEqual([0, 0, 1, 0]); // the run out is not the bowler's
    expect(rows.map((r) => r.wb)).toEqual([0, 0, 0, 1]);
    expect(rows[0].pos).toBe(0);
    expect(m.innings.length).toBe(1); // the super over is left out
  });
  it("leaves out women's matches and shortened matches", () => {
    expect(parseT20({ ...match, info: { ...match.info, gender: "female" } })).toBeNull();
    expect(parseT20({ ...match, info: { ...match.info, overs: 10 } })).toBeNull();
  });
});
