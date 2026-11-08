/**
 * Ball-by-ball rating model.
 *
 * Every delivery gives two outcomes: runs conceded, and whether the bowler took the striker's
 * wicket. Each is modelled as
 *
 *     expected = mean + situation effects + batter + bowler
 *
 * where the situation is phase x innings, ground, era and batting position. All effects are
 * estimated together by ridge regression (block coordinate descent), so a batter's number is
 * only high if he beat what the bowlers he actually faced, in those conditions, would concede.
 * The ridge penalty (lambda, in balls) pulls players with little data towards average: it is what
 * `n / (n + K)` did before, but chosen from held-out matches rather than by hand.
 *
 * Pure functions on typed arrays; reading Cricsheet is in ratings.ts.
 */

export const BOWLER_WICKETS = new Set(["bowled", "caught", "caught and bowled", "lbw", "stumped", "hit wicket"]);

/** One delivery, before ids are interned. */
export interface Row {
  bat: string;
  bowl: string;
  /** phase (0 powerplay, 1 middle, 2 death) * 2 + innings (0 first, 1 second) */
  ctx: number;
  /** batting position bucket, 0 (opener) to 4 (tail) */
  pos: number;
  /** 0-based over, and wickets already down */
  over: number;
  wb: number;
  /** Batting and bowling team (country) */
  bt: string;
  wt: string;
  /** Runs charged to the delivery (off the bat, wides and no-balls) */
  runs: number;
  /** 1 when the bowler took the striker's wicket */
  wkt: number;
  legal: boolean;
}

export interface ParsedMatch {
  date: string;
  ground: string;
  year: number;
  /** Both sides are Full Members (the reference group for "average") */
  fm: boolean;
  /** Innings in order, each its deliveries in order */
  innings: Row[][];
}

export interface Dataset {
  n: number;
  bat: Int32Array;
  bowl: Int32Array;
  bteam: Int32Array;
  wteam: Int32Array;
  ctx: Int32Array;
  ground: Int32Array;
  era: Int32Array;
  pos: Int32Array;
  runs: Float64Array;
  wkt: Float64Array;
  legal: Uint8Array;
  fm: Uint8Array;
  over: Int32Array;
  wb: Int32Array;
  /** Innings number across the dataset (rows of one innings are contiguous) */
  inn: Int32Array;
  /** Matches in date order: 0 .. matches-1 */
  match: Int32Array;
  matches: number;
  sizes: { bat: number; bowl: number; team: number; ctx: number; ground: number; era: number; pos: number };
  batIds: string[];
  bowlIds: string[];
  groundNames: string[];
  eraBuckets: number[];
  teamNames: string[];
}

/** Three-year era buckets, as core/era.ts. */
export const eraBucket = (year: number) => Math.floor(year / 3) * 3;

export function buildDataset(parsed: ParsedMatch[]): Dataset {
  const ms = [...parsed].sort((a, b) => a.date.localeCompare(b.date));
  const intern = <T,>(m: Map<T, number>, k: T) => {
    let v = m.get(k);
    if (v === undefined) m.set(k, (v = m.size));
    return v;
  };
  const teams = new Map<string, number>();
  const bats = new Map<string, number>(), bowls = new Map<string, number>(), grounds = new Map<string, number>(), eras = new Map<number, number>();
  let n = 0;
  for (const m of ms) for (const inn of m.innings) n += inn.length;
  const ds = {
    n,
    bat: new Int32Array(n), bowl: new Int32Array(n), bteam: new Int32Array(n), wteam: new Int32Array(n), ctx: new Int32Array(n), ground: new Int32Array(n), era: new Int32Array(n), pos: new Int32Array(n),
    runs: new Float64Array(n), wkt: new Float64Array(n), legal: new Uint8Array(n), fm: new Uint8Array(n),
    over: new Int32Array(n), wb: new Int32Array(n), inn: new Int32Array(n), match: new Int32Array(n),
  };
  let i = 0, innNo = 0;
  ms.forEach((m, mi) => {
    const g = intern(grounds, m.ground);
    const e = intern(eras, eraBucket(m.year));
    for (const inn of m.innings) {
      for (const r of inn) {
        ds.bat[i] = intern(bats, r.bat);
        ds.bowl[i] = intern(bowls, r.bowl);
        ds.bteam[i] = intern(teams, r.bt);
        ds.wteam[i] = intern(teams, r.wt);
        ds.ctx[i] = r.ctx;
        ds.ground[i] = g;
        ds.era[i] = e;
        ds.pos[i] = r.pos;
        ds.runs[i] = r.runs;
        ds.wkt[i] = r.wkt;
        ds.legal[i] = r.legal ? 1 : 0;
        ds.fm[i] = m.fm ? 1 : 0;
        ds.over[i] = r.over;
        ds.wb[i] = r.wb;
        ds.inn[i] = innNo;
        ds.match[i] = mi;
        i++;
      }
      innNo++;
    }
  });
  return {
    ...ds,
    matches: ms.length,
    sizes: { bat: bats.size, bowl: bowls.size, team: teams.size, ctx: 6, ground: grounds.size, era: eras.size, pos: 5 },
    batIds: [...bats.keys()],
    bowlIds: [...bowls.keys()],
    groundNames: [...grounds.keys()],
    eraBuckets: [...eras.keys()],
    teamNames: [...teams.keys()],
  };
}

/** Rows whose match is in [from, to) (match numbers, date order). */
export function rowsOfMatches(ds: Dataset, from: number, to: number): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < ds.n; i++) if (ds.match[i] >= from && ds.match[i] < to) out.push(i);
  return Int32Array.from(out);
}

// ---- Ridge fit -------------------------------------------------------------------------------

export interface Factor {
  name: string;
  idx: Int32Array;
  size: number;
  /** Ridge penalty, in balls: the effect of a group with n balls is shrunk by n / (n + lambda) */
  lambda: number;
}

export interface Fit {
  mu: number;
  effs: Float64Array[];
  factors: Factor[];
  iterations: number;
}

/** Ridge regression of y on the factors' group effects, by block coordinate descent. */
export function fitAdditive(y: Float64Array, rows: Int32Array, factors: Factor[], maxIter = 80, tol = 1e-6): Fit {
  const m = rows.length;
  let mu = 0;
  for (let i = 0; i < m; i++) mu += y[rows[i]];
  mu = m ? mu / m : 0;
  const effs = factors.map((f) => new Float64Array(f.size));
  const counts = factors.map((f) => {
    const c = new Float64Array(f.size);
    for (let i = 0; i < m; i++) c[f.idx[rows[i]]]++;
    return c;
  });
  const pred = new Float64Array(m).fill(mu);
  let it = 0;
  for (; it < maxIter; it++) {
    let maxd = 0;
    for (let k = 0; k < factors.length; k++) {
      const f = factors[k], eff = effs[k], cnt = counts[k];
      const sum = new Float64Array(f.size);
      for (let i = 0; i < m; i++) {
        const r = rows[i], g = f.idx[r];
        sum[g] += y[r] - pred[i] + eff[g];
      }
      const next = new Float64Array(f.size);
      for (let g = 0; g < f.size; g++) {
        next[g] = sum[g] / (cnt[g] + f.lambda);
        const d = Math.abs(next[g] - eff[g]);
        if (d > maxd) maxd = d;
      }
      for (let i = 0; i < m; i++) {
        const g = f.idx[rows[i]];
        pred[i] += next[g] - eff[g];
      }
      effs[k] = next;
    }
    if (maxd < tol) {
      it++;
      break;
    }
  }
  return { mu, effs, factors, iterations: it };
}

/** Predictions for rows, from a fit (groups never seen in the fit have effect 0). */
export function predictRows(fit: Fit, rows: Int32Array): Float64Array {
  const out = new Float64Array(rows.length).fill(fit.mu);
  fit.factors.forEach((f, k) => {
    const eff = fit.effs[k];
    for (let i = 0; i < rows.length; i++) out[i] += eff[f.idx[rows[i]]];
  });
  return out;
}

export interface Lambdas {
  bat: number;
  bowl: number;
}
/** Situation penalties: mild, since every situation group has thousands of balls. */
const SITUATION_LAMBDA = { ctx: 20, ground: 1000, era: 1500, pos: 100, team: 300 };

export function situationFactors(ds: Dataset): Factor[] {
  return [
    { name: "phase x innings", idx: ds.ctx, size: ds.sizes.ctx, lambda: SITUATION_LAMBDA.ctx },
    { name: "ground", idx: ds.ground, size: ds.sizes.ground, lambda: SITUATION_LAMBDA.ground },
    { name: "era", idx: ds.era, size: ds.sizes.era, lambda: SITUATION_LAMBDA.era },
    { name: "batting position", idx: ds.pos, size: ds.sizes.pos, lambda: SITUATION_LAMBDA.pos },
  ];
}
/**
 * Team levels: how much a side's batters score, and its bowlers concede, beyond the situation.
 * Players then carry only their difference from their team, so a player of a weak side starts from
 * a weak side's level (and a new cap does not start from "average"). Without this, sides that
 * mostly play each other, such as Associates, cannot be placed against the Full Members.
 */
export function teamFactors(ds: Dataset): Factor[] {
  return [
    { name: "batting team", idx: ds.bteam, size: ds.sizes.team, lambda: SITUATION_LAMBDA.team },
    { name: "bowling team", idx: ds.wteam, size: ds.sizes.team, lambda: SITUATION_LAMBDA.team },
  ];
}
export function playerFactors(ds: Dataset, lam: Lambdas): Factor[] {
  return [
    { name: "batter", idx: ds.bat, size: ds.sizes.bat, lambda: lam.bat },
    { name: "bowler", idx: ds.bowl, size: ds.sizes.bowl, lambda: lam.bowl },
  ];
}

export const fitSituation = (ds: Dataset, y: Float64Array, rows: Int32Array) => fitAdditive(y, rows, situationFactors(ds));
export const fitFull = (ds: Dataset, y: Float64Array, rows: Int32Array, lam: Lambdas) =>
  fitAdditive(y, rows, [...situationFactors(ds), ...teamFactors(ds), ...playerFactors(ds, lam)]);

/** A fit's effects for one factor, by name. */
export const effOf = (fit: Fit, name: string) => fit.effs[fit.factors.findIndex((f) => f.name === name)];

/**
 * What a typical career record would say, with no adjustment: a player's raw mean outcome against
 * the overall mean, pulled towards zero by n / (n + k) (the shape the game uses today). Predictions
 * add it to the situation-only fit.
 */
export function rawSkills(ds: Dataset, y: Float64Array, rows: Int32Array, mu: number, k: number) {
  const mk = (idx: Int32Array, size: number) => {
    const sum = new Float64Array(size), cnt = new Float64Array(size);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      sum[idx[r]] += y[r] - mu;
      cnt[idx[r]]++;
    }
    return { skill: sum.map((s, g) => (cnt[g] ? (s / cnt[g]) * (cnt[g] / (cnt[g] + k)) : 0)), balls: cnt };
  };
  return { bat: mk(ds.bat, ds.sizes.bat), bowl: mk(ds.bowl, ds.sizes.bowl) };
}

export function predictNaive(ds: Dataset, base: Fit, rows: Int32Array, raw: ReturnType<typeof rawSkills>): Float64Array {
  const p = predictRows(base, rows);
  for (let i = 0; i < rows.length; i++) p[i] += raw.bat.skill[ds.bat[rows[i]]] + raw.bowl.skill[ds.bowl[rows[i]]];
  return p;
}

// ---- Evaluation ------------------------------------------------------------------------------

export interface Score {
  /** Mean squared error per delivery */
  mse: number;
  /** RMSE of predicted against actual innings totals (summing the same deliveries) */
  inningsRmse: number;
}

export function score(ds: Dataset, y: Float64Array, rows: Int32Array, pred: Float64Array): Score {
  let se = 0;
  const tot = new Map<number, [number, number]>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const e = y[r] - pred[i];
    se += e * e;
    const t = tot.get(ds.inn[r]) ?? [0, 0];
    t[0] += y[r];
    t[1] += pred[i];
    tot.set(ds.inn[r], t);
  }
  let ie = 0;
  for (const [a, p] of tot.values()) ie += (a - p) ** 2;
  return { mse: se / rows.length, inningsRmse: Math.sqrt(ie / Math.max(1, tot.size)) };
}

/** Improvement on the situation-only prediction, in percent of its error. */
export const skillScore = (base: number, s: number) => ((base - s) / base) * 100;

// ---- What a wicket is worth -------------------------------------------------------------------

/**
 * Runs lost when a wicket falls: the average remaining runs in an innings with w wickets down at
 * this over, less those with one more down, averaged over the wickets that actually fell (and by
 * phase). From the data itself, so no Duckworth-Lewis table is needed.
 */
export function wicketValue(ds: Dataset): { all: number; byPhase: [number, number, number] } {
  const OVERS = 20, W = 11;
  const sum = new Float64Array(OVERS * W), cnt = new Float64Array(OVERS * W);
  // Remaining runs from each delivery to the end of its innings
  let i = ds.n - 1;
  while (i >= 0) {
    const inn = ds.inn[i];
    let rem = 0;
    for (; i >= 0 && ds.inn[i] === inn; i--) {
      rem += ds.runs[i];
      const o = Math.min(OVERS - 1, ds.over[i]);
      sum[o * W + Math.min(W - 1, ds.wb[i])] += rem;
      cnt[o * W + Math.min(W - 1, ds.wb[i])]++;
    }
  }
  const cell = (o: number, w: number) => (cnt[o * W + w] >= 30 ? sum[o * W + w] / cnt[o * W + w] : NaN);
  const by = [0, 0, 0], nby = [0, 0, 0];
  for (let r = 0; r < ds.n; r++) {
    if (!ds.wkt[r]) continue;
    const o = Math.min(OVERS - 1, ds.over[r]), w = Math.min(W - 2, ds.wb[r]);
    const v = cell(o, w) - cell(o, w + 1);
    if (!Number.isFinite(v)) continue;
    const ph = o < 6 ? 0 : o < 15 ? 1 : 2;
    by[ph] += v;
    nby[ph]++;
  }
  const byPhase = by.map((s, k) => (nby[k] ? s / nby[k] : 12)) as [number, number, number];
  const all = by.reduce((a, b) => a + b, 0) / Math.max(1, nby.reduce((a, b) => a + b, 0));
  return { all: Number.isFinite(all) ? all : 12, byPhase };
}

// ---- Putting players on one scale ---------------------------------------------------------------

export interface PlayerRating {
  id: string;
  batBalls: number;
  bowlBalls: number;
  /** Per ball, against an average Full Member in the same situations (before shrinkage is undone) */
  batRuns: number;
  batOut: number;
  bowlRuns: number;
  bowlWkt: number;
}

/**
 * Each player's whole level: his own effect plus his team's (ball-weighted over the sides he
 * played for), centred so that an average player in Full Member v Full Member cricket is zero.
 * The fit's own zero is the average of everyone, Associates included.
 */
export function totalSkills(ds: Dataset, fit: Fit): { bat: Float64Array; bowl: Float64Array } {
  const eb = effOf(fit, "batter"), ew = effOf(fit, "bowler"), tb = effOf(fit, "batting team"), tw = effOf(fit, "bowling team");
  const bat = new Float64Array(ds.sizes.bat), bowl = new Float64Array(ds.sizes.bowl);
  const nb = new Float64Array(ds.sizes.bat), nw = new Float64Array(ds.sizes.bowl);
  let mb = 0, mw = 0, n = 0;
  for (let i = 0; i < ds.n; i++) {
    bat[ds.bat[i]] += tb[ds.bteam[i]];
    nb[ds.bat[i]]++;
    bowl[ds.bowl[i]] += tw[ds.wteam[i]];
    nw[ds.bowl[i]]++;
  }
  for (let k = 0; k < bat.length; k++) bat[k] = eb[k] + (nb[k] ? bat[k] / nb[k] : 0);
  for (let k = 0; k < bowl.length; k++) bowl[k] = ew[k] + (nw[k] ? bowl[k] / nw[k] : 0);
  for (let i = 0; i < ds.n; i++) {
    if (!ds.fm[i]) continue;
    mb += bat[ds.bat[i]];
    mw += bowl[ds.bowl[i]];
    n++;
  }
  mb = n ? mb / n : 0;
  mw = n ? mw / n : 0;
  return { bat: bat.map((v) => v - mb), bowl: bowl.map((v) => v - mw) };
}

export function ballCounts(ds: Dataset) {
  const bat = new Float64Array(ds.sizes.bat), bowl = new Float64Array(ds.sizes.bowl);
  for (let i = 0; i < ds.n; i++) {
    bat[ds.bat[i]]++;
    bowl[ds.bowl[i]]++;
  }
  return { bat, bowl };
}

/** Runs above an average Full Member per 100 balls faced (batter) or below per 24 balls bowled (bowler): the common scale. */
export const batterValue = (runs: number, out: number, W: number) => 100 * (runs - W * out);
export const bowlerValue = (runs: number, wkt: number, W: number) => 24 * (-runs + W * wkt);
