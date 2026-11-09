import { BOWLER_WICKETS } from "./rating-model";

/**
 * Reads a franchise T20 league (the IPL) from Cricsheet ball-by-ball matches: each player's stats in
 * the same columns as the international data, phase and position splits, and the league's own norms
 * (what a typical batter and bowler do in each phase and position, scoring by season, and par
 * scores at each ground). Pure: no files, so it can be tested on made-up matches.
 */

export type PhaseKey = "pp" | "mid" | "death";
export type PosKey = "open" | "three" | "four5" | "six7" | "tail";
const POS_KEYS: PosKey[] = ["open", "three", "four5", "six7", "tail"];
const PHASES: PhaseKey[] = ["pp", "mid", "death"];

/** [runs, balls, outs] for batting; [balls, runs, wickets] for bowling. */
type Bat = [number, number, number];
type Bowl = [number, number, number];
const z3 = (): [number, number, number] => [0, 0, 0];

export const phaseOf = (over: number): PhaseKey => (over < 6 ? "pp" : over < 15 ? "mid" : "death");
export const posOf = (n: number): PosKey => (n <= 2 ? "open" : n === 3 ? "three" : n <= 5 ? "four5" : n <= 7 ? "six7" : "tail");
/** Three-year season buckets, as core/era.ts uses for T20. */
export const eraBucket = (year: number) => Math.floor(year / 3) * 3;

export interface PlayerAgg {
  id: string;
  name: string;
  matches: number;
  years: number[];
  batInnings: number;
  batRuns: number;
  batBalls: number;
  batOuts: number;
  /** Batted at 1-2, 3-6, 7+ (as the international data counts them) */
  top: number;
  mid: number;
  fin: number;
  bowlInnings: number;
  bowlBalls: number;
  bowlRuns: number;
  bowlWkts: number;
  stumpings: number;
  /** Wickets he took by stumping: only spinners (and the odd medium-pacer to a standing-up keeper) */
  stumpedWkts: number;
  /** [bat runs, balls, outs, bowl balls, runs, wickets] per phase */
  phase: Record<PhaseKey, number[]>;
  /** [runs, balls, outs, innings] per batting position */
  pos: Record<PosKey, [number, number, number, number]>;
  /** [runs, balls, outs] batting first / chasing */
  chase: { first: Bat; second: Bat };
}

export interface Norms {
  all: { bat: Bat; bowl: Bowl };
  phase: Record<PhaseKey, { bat: Bat; bowl: Bowl }>;
  pos: Record<PosKey, Bat>;
  chase: { first: Bat; second: Bat };
  era: Record<string, { bat: Bat; bowl: Bowl }>;
}

export class LeagueAccumulator {
  players = new Map<string, PlayerAgg>();
  norms: Norms = {
    all: { bat: z3(), bowl: z3() },
    phase: { pp: { bat: z3(), bowl: z3() }, mid: { bat: z3(), bowl: z3() }, death: { bat: z3(), bowl: z3() } },
    pos: { open: z3(), three: z3(), four5: z3(), six7: z3(), tail: z3() },
    chase: { first: z3(), second: z3() },
    era: {},
  };
  /** First-innings totals, overall and at each ground */
  par = { all: [] as number[], ground: {} as Record<string, number[]> };
  /** By innings (batting first, chasing): count, runs, balls, all out */
  innings = [0, 1].map(() => ({ n: 0, runs: 0, balls: 0, allOut: 0 }));
  results = { matches: 0, ties: 0, decisive: 0, batFirstWins: 0 };
  matches = 0;

  private get(id: string, name: string): PlayerAgg {
    let p = this.players.get(id);
    if (!p) {
      p = {
        id, name, matches: 0, years: [], batInnings: 0, batRuns: 0, batBalls: 0, batOuts: 0, top: 0, mid: 0, fin: 0,
        bowlInnings: 0, bowlBalls: 0, bowlRuns: 0, bowlWkts: 0, stumpings: 0, stumpedWkts: 0,
        phase: { pp: Array(6).fill(0), mid: Array(6).fill(0), death: Array(6).fill(0) },
        pos: { open: [0, 0, 0, 0], three: [0, 0, 0, 0], four5: [0, 0, 0, 0], six7: [0, 0, 0, 0], tail: [0, 0, 0, 0] },
        chase: { first: z3(), second: z3() },
      };
      this.players.set(id, p);
    }
    return p;
  }

  /**
   * Adds one Cricsheet match. `groundOf` names the game's ground for a venue (undefined for others).
   * Returns false when the match is left out (women's, shortened, no player ids).
   */
  addMatch(match: any, groundOf: (venue: string) => string | undefined = () => undefined): boolean {
    const info = match?.info ?? {};
    if (info.gender !== "male" || !info.registry?.people) return false;
    if (info.overs && info.overs !== 20) return false;
    // A shortened innings distorts phases, totals and strike rates: leave the whole match out
    if ((match.innings ?? []).some((i: any) => i.target?.overs && i.target.overs < 20)) return false;
    const year = Number(String(info.dates?.[0] ?? "").slice(0, 4));
    if (!(year > 2000)) return false;
    const people: Record<string, string> = info.registry.people;
    const ground = groundOf(String(info.venue ?? ""));
    const era = (this.norms.era[eraBucket(year)] ??= { bat: z3(), bowl: z3() });
    this.matches++;

    for (const names of Object.values(info.players ?? {}) as string[][])
      for (const n of names) {
        const id = people[n];
        if (!id) continue;
        const p = this.get(id, n);
        p.matches++;
        p.years.push(year);
      }

    const innings = (match.innings ?? []).filter((i: any) => !i.super_over).slice(0, 2);
    innings.forEach((inn: any, idx: number) => {
      const chase = idx === 0 ? "first" : "second";
      const order: string[] = [];
      const bowlers = new Set<string>();
      let total = 0, legal = 0, down = 0;
      for (const o of inn.overs ?? []) {
        const phase = phaseOf(o.over);
        for (const d of o.deliveries ?? []) {
          for (const n of [d.batter, d.non_striker]) if (!order.includes(n)) order.push(n);
          const ex = d.extras ?? {};
          const batRuns = d.runs?.batter ?? 0;
          const conceded = batRuns + (ex.wides ?? 0) + (ex.noballs ?? 0) + (ex.penalties ?? 0);
          const legalBat = !ex.wides, legalBowl = !ex.wides && !ex.noballs;
          const outs = (d.wickets ?? []) as any[];
          total += d.runs?.total ?? 0;
          if (legalBowl) legal++;
          down += outs.length;
          const batterId = people[d.batter], bowlerId = people[d.bowler];
          const pos = posOf(order.indexOf(d.batter) + 1);

          // League norms: every delivery
          const n = this.norms;
          for (const t of [n.all.bat, n.phase[phase].bat, n.pos[pos], n.chase[chase], era.bat]) {
            t[0] += batRuns;
            if (legalBat) t[1]++;
          }
          for (const t of [n.all.bowl, n.phase[phase].bowl, era.bowl]) {
            if (legalBowl) t[0]++;
            t[1] += conceded;
          }
          for (const w of outs) {
            const kind = w.kind ?? "";
            const credit = BOWLER_WICKETS.has(kind) ? 1 : 0;
            const outPos = posOf(order.indexOf(w.player_out) + 1);
            for (const t of [n.all.bat, n.phase[phase].bat, n.pos[outPos], n.chase[chase], era.bat]) t[2]++;
            for (const t of [n.all.bowl, n.phase[phase].bowl, era.bowl]) t[2] += credit;
            const outId = people[w.player_out];
            if (outId) {
              const op = this.get(outId, w.player_out);
              op.batOuts++;
              op.phase[phase][2]++;
              op.pos[outPos][2]++;
              op.chase[chase][2]++;
            }
            if (kind === "stumped") {
              for (const f of w.fielders ?? []) {
                const fid = people[f.name];
                if (fid) this.get(fid, f.name).stumpings++;
              }
              if (bowlerId) this.get(bowlerId, d.bowler).stumpedWkts++;
            }
          }

          if (batterId) {
            const p = this.get(batterId, d.batter);
            p.batRuns += batRuns;
            if (legalBat) p.batBalls++;
            p.phase[phase][0] += batRuns;
            if (legalBat) p.phase[phase][1]++;
            p.pos[pos][0] += batRuns;
            if (legalBat) p.pos[pos][1]++;
            p.chase[chase][0] += batRuns;
            if (legalBat) p.chase[chase][1]++;
          }
          if (bowlerId) {
            const p = this.get(bowlerId, d.bowler);
            bowlers.add(bowlerId);
            if (legalBowl) {
              p.bowlBalls++;
              p.phase[phase][3]++;
            }
            p.bowlRuns += conceded;
            p.phase[phase][4] += conceded;
            const wk = outs.filter((w) => BOWLER_WICKETS.has(w.kind ?? "")).length;
            p.bowlWkts += wk;
            p.phase[phase][5] += wk;
          }
        }
      }
      order.forEach((name, i) => {
        const id = people[name];
        if (!id) return;
        const p = this.get(id, name);
        p.batInnings++;
        const pos = posOf(i + 1);
        p.pos[pos][3]++;
        if (i < 2) p.top++;
        else if (i < 6) p.mid++;
        else p.fin++;
      });
      for (const id of bowlers) this.players.get(id)!.bowlInnings++;
      const s = this.innings[idx];
      s.n++;
      s.runs += total;
      s.balls += legal;
      if (down >= 10) s.allOut++;
      if (idx === 0 && total > 0) {
        this.par.all.push(total);
        if (ground) (this.par.ground[ground] ??= []).push(total);
      }
    });

    this.results.matches++;
    const o = info.outcome ?? {};
    if (o.result === "tie") this.results.ties++;
    else if (o.winner) {
      this.results.decisive++;
      if (o.winner === innings[0]?.team) this.results.batFirstWins++;
    }
    return true;
  }
}

// ---- Outputs ---------------------------------------------------------------------------------

const r2 = (x: number) => Math.round(x * 100) / 100;
const batNorm = (a: Bat) => ({ sr: r2((a[0] / Math.max(1, a[1])) * 100), bpo: r2(a[1] / Math.max(1, a[2])) });
const bowlNorm = (a: Bowl) => ({ econ: r2((a[1] / Math.max(1, a[0])) * 6), bpw: r2(a[0] / Math.max(1, a[2])) });
const both = (s: { bat: Bat; bowl: Bowl }) => ({ ...batNorm(s.bat), ...bowlNorm(s.bowl) });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

/** The league's norms in the shape core/splits.ts and core/era.ts read, plus par scores and who played when. */
export function normsOf(acc: LeagueAccumulator, minMatches = 10) {
  const n = acc.norms;
  const midYear: Record<string, number> = {};
  for (const p of acc.players.values()) if (p.matches >= minMatches) midYear[`crick_${p.id}`] = median(p.years);
  return {
    all: both(n.all),
    phase: Object.fromEntries(PHASES.map((k) => [k, both(n.phase[k])])),
    pos: Object.fromEntries(POS_KEYS.map((k) => [k, batNorm(n.pos[k])])),
    // The league's matches are not played across regions: one region, so no region norms
    region: {},
    chase: { first: batNorm(n.chase.first), second: batNorm(n.chase.second) },
    // League numbers by season bucket in the form core/era.ts uses
    era: Object.fromEntries(
      [...Object.entries(n.era).sort(), ["all", n.all] as const].map(([k, v]) => [
        k,
        { sr: r2((v.bat[0] / Math.max(1, v.bat[1])) * 100), avg: r2(v.bat[0] / Math.max(1, v.bat[2])), econ: r2((v.bowl[1] / Math.max(1, v.bowl[0])) * 6), bavg: r2(v.bowl[1] / Math.max(1, v.bowl[2])), balls: v.bat[1] },
      ])
    ),
    innings: acc.innings.map((s) => ({ n: s.n, runs: Math.round(s.runs / Math.max(1, s.n)), overs: r2(s.balls / Math.max(1, s.n) / 6), allOut: r2((s.allOut / Math.max(1, s.n)) * 100), declared: 0 })),
    results: { ...acc.results, draws: 0 },
    par: {
      all: Math.round(mean(acc.par.all)),
      ground: Object.fromEntries(Object.entries(acc.par.ground).sort().map(([g, xs]) => [g, { avg: Math.round(mean(xs)), n: xs.length }])),
    },
    midYear,
  };
}

export type Role = "BAT" | "WK" | "AR" | "BOWL";

/**
 * A player's role from what he does, by the same rules the international data uses: a keeper keeps
 * and bowls little; a bowler takes wickets or bowls most matches and bats little; an all-rounder does
 * both well; the rest are batters.
 */
export function roleOf(p: PlayerAgg): Role {
  const matches = Math.max(1, p.matches);
  const batAvg = p.batOuts > 0 ? p.batRuns / p.batOuts : p.batInnings > 0 ? p.batRuns : 0;
  const bowlAvg = p.bowlWkts > 0 ? p.bowlRuns / p.bowlWkts : 999;
  const bowlRate = p.bowlInnings / matches;
  const wpm = p.bowlWkts / matches;
  const avgOvers = p.bowlBalls / 6 / matches;
  if (p.stumpings > 0 && avgOvers < 2) return "WK";
  if ((p.bowlWkts >= 30 && batAvg < 20) || (bowlRate >= 0.7 && batAvg < 22) || (p.bowlBalls > 1500 && batAvg < 20)) return "BOWL";
  if ((p.batRuns > 800 && (bowlAvg > 42 || wpm < 0.5 || bowlRate < 0.32)) || p.bowlBalls < 300 || avgOvers < 1.5) return "BAT";
  if (batAvg >= 22 && bowlAvg <= 42 && p.bowlWkts >= 15 && wpm >= 0.55 && bowlRate >= 0.38) return "AR";
  if (bowlRate >= 0.6) return "BOWL";
  return "BAT";
}

/**
 * Pace or spin from how he is used, for players with no recorded style: spinners bowl most of their
 * overs in the middle (7-15) and take stumpings; pacers share the new ball and the death.
 * Enough balls bowled, or NONE.
 */
export function categoryGuess(p: PlayerAgg): "PACE" | "SPIN" | "NONE" {
  if (p.bowlBalls < 120) return "NONE";
  if (p.stumpedWkts >= 2) return "SPIN";
  const mid = p.phase.mid[3] / Math.max(1, p.bowlBalls);
  return mid >= 0.62 ? "SPIN" : "PACE";
}

/** One player's row in the stats table, in the international data's columns. */
export function statsOf(p: PlayerAgg) {
  const f = (x: number, d = 2) => Number(x.toFixed(d));
  return {
    matches: p.matches,
    bat_innings: p.batInnings,
    bat_runs: p.batRuns,
    bat_balls: p.batBalls,
    bat_average: p.batInnings > 0 ? f(p.batRuns / Math.max(1, p.batOuts || 1)) : 0,
    bat_strike_rate: p.batBalls > 0 ? f((p.batRuns / p.batBalls) * 100) : 0,
    top_order_innings: p.top,
    middle_order_innings: p.mid,
    finisher_innings: p.fin,
    bowl_innings: p.bowlInnings,
    bowl_overs: f(p.bowlBalls / 6, 1),
    bowl_wickets: p.bowlWkts,
    bowl_runs_conceded: p.bowlRuns,
    bowl_average: p.bowlWkts > 0 ? f(p.bowlRuns / p.bowlWkts) : 0,
    bowl_economy: p.bowlBalls > 0 ? f((p.bowlRuns / p.bowlBalls) * 6) : 0,
  };
}
