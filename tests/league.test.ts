import { describe, it, expect } from "vitest";
import { LeagueAccumulator, categoryGuess, normsOf, roleOf, statsOf } from "../src/etl/league";

const people = { Bat1: "b1", Bat2: "b2", Bat3: "b3", Bowl1: "w1", Keep: "k1", Spin1: "s1" };
function match(extra: Partial<any> = {}, innings?: any[]) {
  return {
    info: { gender: "male", overs: 20, dates: ["2019-04-01"], venue: "Wankhede Stadium, Mumbai", teams: ["A", "B"], players: { A: ["Bat1", "Bat2", "Bat3"], B: ["Bowl1", "Keep", "Spin1"] }, registry: { people }, outcome: { winner: "A" }, ...extra },
    innings: innings ?? [
      {
        team: "A",
        overs: [
          { over: 0, deliveries: [
            { batter: "Bat1", non_striker: "Bat2", bowler: "Bowl1", runs: { batter: 4, total: 4 } },
            { batter: "Bat1", non_striker: "Bat2", bowler: "Bowl1", runs: { batter: 0, total: 1 }, extras: { wides: 1 } },
            { batter: "Bat1", non_striker: "Bat2", bowler: "Bowl1", runs: { batter: 0, total: 0 }, wickets: [{ player_out: "Bat1", kind: "bowled" }] },
          ] },
          { over: 7, deliveries: [
            { batter: "Bat2", non_striker: "Bat3", bowler: "Spin1", runs: { batter: 1, total: 1 } },
            { batter: "Bat3", non_striker: "Bat2", bowler: "Spin1", runs: { batter: 0, total: 0 }, wickets: [{ player_out: "Bat3", kind: "stumped", fielders: [{ name: "Keep" }] }] },
          ] },
          { over: 17, deliveries: [{ batter: "Bat2", non_striker: "Bat3", bowler: "Bowl1", runs: { batter: 6, total: 6 } }] },
        ],
      },
      { team: "B", overs: [{ over: 0, deliveries: [{ batter: "Keep", non_striker: "Bowl1", bowler: "Bat1", runs: { batter: 2, total: 2 } }] }] },
    ],
  };
}

describe("league accumulator", () => {
  it("reads batting, bowling, phases, positions and chase splits per player", () => {
    const acc = new LeagueAccumulator();
    expect(acc.addMatch(match(), (v) => (/Wankhede/.test(v) ? "Wankhede Stadium, Mumbai" : undefined))).toBe(true);
    const b1 = acc.players.get("b1")!;
    expect(b1.matches).toBe(1);
    expect(b1.batRuns).toBe(4);
    expect(b1.batBalls).toBe(2); // the wide is not a ball faced
    expect(b1.batOuts).toBe(1);
    expect(b1.phase.pp.slice(0, 3)).toEqual([4, 2, 1]);
    expect(b1.pos.open).toEqual([4, 2, 1, 1]);
    expect(b1.chase.first).toEqual([4, 2, 1]);
    const b2 = acc.players.get("b2")!;
    expect(b2.batRuns).toBe(7); // 1 in the middle, 6 at the death
    expect(b2.phase.mid[0]).toBe(1);
    expect(b2.phase.death[0]).toBe(6);
    const w1 = acc.players.get("w1")!;
    expect(w1.bowlBalls).toBe(3); // wide not counted; 2 legal + 1 at the death
    expect(w1.bowlRuns).toBe(11); // 4 + 1 (wide) + 6
    expect(w1.bowlWkts).toBe(1);
    expect(w1.phase.pp.slice(3)).toEqual([2, 5, 1]);
    // A stumping: the keeper gets it, the bowler is marked as a stumping bowler
    expect(acc.players.get("k1")!.stumpings).toBe(1);
    expect(acc.players.get("s1")!.stumpedWkts).toBe(1);
    // Par at the ground: the first innings total
    expect(acc.par.ground["Wankhede Stadium, Mumbai"]).toEqual([12]);
    expect(acc.results).toMatchObject({ matches: 1, decisive: 1, batFirstWins: 1 });
  });

  it("leaves out women's, shortened and unidentified matches", () => {
    const acc = new LeagueAccumulator();
    expect(acc.addMatch(match({ gender: "female" }))).toBe(false);
    expect(acc.addMatch(match({ overs: 10 }))).toBe(false);
    const cut = match();
    (cut.innings[1] as any).target = { overs: 12 };
    expect(acc.addMatch(cut)).toBe(false);
    expect(acc.players.size).toBe(0);
  });

  it("gives norms in the shape the engine reads, and a middle season for each regular", () => {
    const acc = new LeagueAccumulator();
    for (let i = 0; i < 12; i++) acc.addMatch(match({ dates: [`${2012 + (i % 6)}-04-01`] }));
    const n = normsOf(acc, 10);
    expect(n.phase.pp.sr).toBeGreaterThan(0);
    expect(Object.keys(n.era)).toContain("all");
    expect(n.midYear["crick_b1"]).toBeGreaterThanOrEqual(2012);
    expect(n.innings).toHaveLength(2);
  });
});

describe("franchises", () => {
  it("counts each player's matches for a club, folding renamed clubs into one franchise", () => {
    const acc = new LeagueAccumulator();
    const m = (team: string, year: number) => match({ dates: [`${year}-04-01`], teams: [team, "Mumbai Indians"], players: { [team]: ["Bat1", "Bat2"], "Mumbai Indians": ["Bat3", "Bowl1"] } });
    for (let i = 0; i < 6; i++) acc.addMatch(m("Delhi Daredevils", 2012));
    for (let i = 0; i < 7; i++) acc.addMatch(m("Delhi Capitals", 2020));
    acc.addMatch(m("Deccan Chargers", 2009)); // a defunct club is not a franchise
    const b1 = acc.players.get("b1")!;
    expect(b1.clubs).toEqual({ DC: 13 });
    expect(acc.players.get("b3")!.clubs).toEqual({ MI: 14 });
    const n = normsOf(acc, 10, 5);
    expect(n.franchises["crick_b1"]).toEqual(["DC"]);
    expect(n.franchises["crick_b3"]).toEqual(["MI"]);
  });
  it("leaves out a club he only turned out for a few times", () => {
    const acc = new LeagueAccumulator();
    for (let i = 0; i < 12; i++) acc.addMatch(match({ teams: ["Chennai Super Kings", "Mumbai Indians"], players: { "Chennai Super Kings": ["Bat1"], "Mumbai Indians": ["Bat2"] } }));
    for (let i = 0; i < 3; i++) acc.addMatch(match({ teams: ["Rajasthan Royals", "Mumbai Indians"], players: { "Rajasthan Royals": ["Bat1"], "Mumbai Indians": ["Bat2"] } }));
    expect(normsOf(acc, 10, 5).franchises["crick_b1"]).toEqual(["CSK"]);
  });
});

describe("roles and bowling type from usage", () => {
  const base = { id: "x", name: "X", matches: 100, years: [], clubs: {}, batInnings: 80, batRuns: 1500, batBalls: 1100, batOuts: 60, top: 0, mid: 0, fin: 0, bowlInnings: 0, bowlBalls: 0, bowlRuns: 0, bowlWkts: 0, stumpings: 0, stumpedWkts: 0,
    phase: { pp: Array(6).fill(0), mid: Array(6).fill(0), death: Array(6).fill(0) }, pos: {} as any, chase: {} as any };
  it("a keeper keeps and bowls little; a regular batter is a batter", () => {
    expect(roleOf({ ...base, stumpings: 12 })).toBe("WK");
    expect(roleOf({ ...base })).toBe("BAT");
  });
  it("a bowler takes wickets and bats little; an all-rounder does both", () => {
    const bowl = { ...base, batRuns: 200, batOuts: 40, bowlInnings: 95, bowlBalls: 2000, bowlRuns: 2600, bowlWkts: 110 };
    expect(roleOf(bowl)).toBe("BOWL");
    expect(roleOf({ ...bowl, batRuns: 1400, batOuts: 55 })).toBe("AR");
  });
  it("spin from the middle overs and stumpings, pace from the new ball and the death", () => {
    const mk = (pp: number, mid: number, death: number, stumped = 0) => ({ ...base, bowlBalls: pp + mid + death, stumpedWkts: stumped, phase: { pp: [0, 0, 0, pp, 0, 0], mid: [0, 0, 0, mid, 0, 0], death: [0, 0, 0, death, 0, 0] } });
    expect(categoryGuess(mk(200, 240, 160))).toBe("PACE");
    expect(categoryGuess(mk(50, 420, 60))).toBe("SPIN");
    expect(categoryGuess(mk(200, 240, 160, 3))).toBe("SPIN");
    expect(categoryGuess(mk(40, 40, 20))).toBe("NONE"); // too few balls to say
  });
  it("writes the stats in the international data's columns", () => {
    const s = statsOf({ ...base, bowlInnings: 10, bowlBalls: 120, bowlRuns: 150, bowlWkts: 5 });
    expect(s.bat_average).toBe(25);
    expect(s.bat_strike_rate).toBeCloseTo(136.36, 1);
    expect(s.bowl_economy).toBe(7.5);
    expect(s.bowl_overs).toBe(20);
  });
});
