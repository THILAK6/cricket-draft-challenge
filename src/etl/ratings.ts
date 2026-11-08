import fs from "node:fs";
import path from "node:path";
import { parseT20 } from "./cricsheet-parse";
import {
  ballCounts, batterValue, bowlerValue, buildDataset, centre, fitFull, fitSituation, predictNaive, predictRows, rawSkills, rowsOfMatches, score, skillScore, wicketValue,
  type Fit, type ParsedMatch,
} from "./rating-model";

/**
 * T20 ball-by-ball ratings (see rating-model.ts), with the held-out test that decides whether they
 * are better than raw career numbers.
 *
 *   npx tsx src/etl/ratings.ts [data/raw]
 *
 * Reads data/raw/t20s_json (every men's T20I, Associates included) and writes
 *   data/rating-model-report.md   the test, the tuning, and who moves most
 *   data/player-ratings-t20.json  each player's skills per ball, for the engine to use if the test is won
 * Run by .github/workflows/ratings.yml.
 */

const RAW = path.resolve(process.argv[2] ?? "data/raw");
const dir = path.join(RAW, "t20s_json");
if (!fs.existsSync(dir)) {
  console.error(`[ratings] Missing ${dir}: download https://cricsheet.org/downloads/t20s_json.zip and unzip it there.`);
  process.exit(1);
}

const names = new Map<string, string>();
const parsed: ParsedMatch[] = [];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  let m: any;
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
  } catch {
    continue;
  }
  const p = parseT20(m, names);
  if (p) parsed.push(p);
}
const ds = buildDataset(parsed);
console.log(`[ratings] ${ds.matches} matches, ${ds.n} deliveries, ${ds.sizes.bat} batters, ${ds.sizes.bowl} bowlers`);

// Chronological split: fit on the first 70%, choose penalties on the next 15%, test on the last 15%
const c1 = Math.floor(ds.matches * 0.7), c2 = Math.floor(ds.matches * 0.85);
const train = rowsOfMatches(ds, 0, c1), val = rowsOfMatches(ds, c1, c2), test = rowsOfMatches(ds, c2, ds.matches);
const all = rowsOfMatches(ds, 0, ds.matches);
const byDate = [...parsed].sort((a, b) => a.date.localeCompare(b.date));
const dateOf = (match: number) => byDate[match]?.date ?? "";
const dates = { from: dateOf(0), c1: dateOf(c1), c2: dateOf(c2), to: dateOf(ds.matches - 1) };

type Outcome = { key: "runs" | "wkt"; y: Float64Array; lambdas: number[]; naiveK: number[] };
const outcomes: Outcome[] = [
  { key: "runs", y: ds.runs, lambdas: [150, 400, 1000, 2500], naiveK: [30, 100, 300, 1000, 3000] },
  { key: "wkt", y: ds.wkt, lambdas: [400, 1200, 3000, 8000], naiveK: [100, 300, 1000, 3000, 10000] },
];

interface Tuned {
  lam: { bat: number; bowl: number };
  naiveK: number;
  valSkill: number;
  test: { situation: ReturnType<typeof score>; naive: ReturnType<typeof score>; model: ReturnType<typeof score> };
  grid: { bat: number; bowl: number; skill: number }[];
}

function tune(o: Outcome): Tuned {
  const base = fitSituation(ds, o.y, train);
  const s0val = score(ds, o.y, val, predictRows(base, val));
  const grid: Tuned["grid"] = [];
  let best = { bat: o.lambdas[0], bowl: o.lambdas[0], mse: Infinity };
  for (const bat of o.lambdas)
    for (const bowl of o.lambdas) {
      const mse = score(ds, o.y, val, predictRows(fitFull(ds, o.y, train, { bat, bowl }), val)).mse;
      grid.push({ bat, bowl, skill: skillScore(s0val.mse, mse) });
      if (mse < best.mse) best = { bat, bowl, mse };
    }
  let bestK = { k: o.naiveK[0], mse: Infinity };
  for (const k of o.naiveK) {
    const mse = score(ds, o.y, val, predictNaive(ds, base, val, rawSkills(ds, o.y, train, base.mu, k))).mse;
    if (mse < bestK.mse) bestK = { k, mse };
  }
  // Test: the penalties were chosen without looking at it
  const trainVal = rowsOfMatches(ds, 0, c2);
  const baseTV = fitSituation(ds, o.y, trainVal);
  const model = fitFull(ds, o.y, trainVal, { bat: best.bat, bowl: best.bowl });
  return {
    lam: { bat: best.bat, bowl: best.bowl },
    naiveK: bestK.k,
    valSkill: skillScore(s0val.mse, best.mse),
    test: {
      situation: score(ds, o.y, test, predictRows(baseTV, test)),
      naive: score(ds, o.y, test, predictNaive(ds, baseTV, test, rawSkills(ds, o.y, trainVal, baseTV.mu, bestK.k))),
      model: score(ds, o.y, test, predictRows(model, test)),
    },
    grid,
  };
}

const tuned = { runs: tune(outcomes[0]), wkt: tune(outcomes[1]) };
console.log("[ratings] tuned", JSON.stringify({ runs: tuned.runs.lam, wkt: tuned.wkt.lam }));

// ---- Final fit on everything -------------------------------------------------------------------
const W = wicketValue(ds);
const runFit = fitFull(ds, ds.runs, all, tuned.runs.lam);
const wktFit = fitFull(ds, ds.wkt, all, tuned.wkt.lam);
const counts = ballCounts(ds);

function centred(fit: Fit) {
  const c = centre(ds, fit);
  return { bat: (k: number) => fit.effs[4][k] - c.bat, bowl: (k: number) => fit.effs[5][k] - c.bowl };
}
const cr = centred(runFit), cw = centred(wktFit);

/** The same quantities from raw career numbers (shrunk), centred the same way, for comparison. */
function rawCentred(y: Float64Array, mu: number, k: number) {
  const raw = rawSkills(ds, y, all, mu, k);
  let mb = 0, mw = 0, n = 0;
  for (let i = 0; i < ds.n; i++) {
    if (!ds.fm[i]) continue;
    mb += raw.bat.skill[ds.bat[i]];
    mw += raw.bowl.skill[ds.bowl[i]];
    n++;
  }
  return { bat: (i: number) => raw.bat.skill[i] - mb / n, bowl: (i: number) => raw.bowl.skill[i] - mw / n };
}
const rr = rawCentred(ds.runs, runFit.mu, tuned.runs.naiveK), rw = rawCentred(ds.wkt, wktFit.mu, tuned.wkt.naiveK);

interface Row {
  id: string;
  name: string;
  batBalls: number;
  bowlBalls: number;
  batModel?: number;
  batRaw?: number;
  bowlModel?: number;
  bowlRaw?: number;
}
const batIdx = new Map(ds.batIds.map((id, k) => [id, k]));
const bowlIdx = new Map(ds.bowlIds.map((id, k) => [id, k]));
const ids = new Set([...ds.batIds, ...ds.bowlIds]);
const rows: Row[] = [];
for (const id of ids) {
  const b = batIdx.get(id), w = bowlIdx.get(id);
  const r: Row = { id, name: names.get(id) ?? id, batBalls: b === undefined ? 0 : counts.bat[b], bowlBalls: w === undefined ? 0 : counts.bowl[w] };
  if (b !== undefined && r.batBalls >= 30) {
    r.batModel = batterValue(cr.bat(b), cw.bat(b), W.all);
    r.batRaw = batterValue(rr.bat(b), rw.bat(b), W.all);
  }
  if (w !== undefined && r.bowlBalls >= 30) {
    r.bowlModel = bowlerValue(cr.bowl(w), cw.bowl(w), W.all);
    r.bowlRaw = bowlerValue(rr.bowl(w), rw.bowl(w), W.all);
  }
  rows.push(r);
}

// ---- Output ---------------------------------------------------------------------------------
const f1 = (x: number | undefined) => (x === undefined ? "-" : (x >= 0 ? "+" : "") + x.toFixed(1));
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
const md: string[] = [];
md.push("# T20 ball-by-ball rating model: report", "");
md.push(`Generated by \`src/etl/ratings.ts\` from Cricsheet men's T20Is (Associates included): ${ds.matches} matches, ${ds.n.toLocaleString()} deliveries, ${ds.sizes.bat} batters, ${ds.sizes.bowl} bowlers, ${dates.from} to ${dates.to}.`, "");
md.push("## The test: do the ratings predict matches they have not seen?", "");
md.push(`Fit on matches up to ${dates.c1}, penalties chosen on ${dates.c1} to ${dates.c2}, **tested on ${dates.c2} to ${dates.to}** (${test.length.toLocaleString()} deliveries). Each row is how much it cuts the prediction error of a model that knows only the situation (phase, innings, ground, era, batting position) but nothing about the players. Higher is better.`, "");
md.push("| Predicting | Raw career numbers (best shrinkage) | **Ball-by-ball model** | Innings total RMSE: raw | Innings total RMSE: model | Innings total RMSE: no player info |", "|---|---|---|---|---|---|");
for (const k of ["runs", "wkt"] as const) {
  const t = tuned[k].test;
  md.push(`| ${k === "runs" ? "Runs per ball" : "Wicket per ball"} | ${pct(skillScore(t.situation.mse, t.naive.mse))} | **${pct(skillScore(t.situation.mse, t.model.mse))}** | ${t.naive.inningsRmse.toFixed(2)} | ${t.model.inningsRmse.toFixed(2)} | ${t.situation.inningsRmse.toFixed(2)} |`);
}
md.push("", `Penalties chosen on the validation matches: runs: batters ${tuned.runs.lam.bat}, bowlers ${tuned.runs.lam.bowl} balls; wickets: batters ${tuned.wkt.lam.bat}, bowlers ${tuned.wkt.lam.bowl} balls. Raw career shrinkage: runs ${tuned.runs.naiveK}, wickets ${tuned.wkt.naiveK} balls.`, "");
md.push(`A wicket is worth **${W.all.toFixed(1)} runs** on average (powerplay ${W.byPhase[0].toFixed(1)}, middle ${W.byPhase[1].toFixed(1)}, death ${W.byPhase[2].toFixed(1)}), measured from the data.`, "");

md.push("## Situation effects (runs per 100 balls against the average)", "");
const sit = (name: string) => runFit.factors.findIndex((f) => f.name === name);
md.push("| Era | Effect |", "|---|---|");
ds.eraBuckets.forEach((y, k) => md.push(`| ${y}-${y + 2} | ${f1(runFit.effs[sit("era")][k] * 100)} |`));
const phaseName = ["Powerplay", "Middle", "Death"];
md.push("", "| Phase, innings | Effect |", "|---|---|");
for (let k = 0; k < 6; k++) md.push(`| ${phaseName[k >> 1]}, ${k % 2 ? "chasing" : "batting first"} | ${f1(runFit.effs[sit("phase x innings")][k] * 100)} |`);
md.push("", "| Batting position | Effect |", "|---|---|");
["Opener", "#3", "#4-5", "#6-7", "#8-11"].forEach((n, k) => md.push(`| ${n} | ${f1(runFit.effs[sit("batting position")][k] * 100)} |`));
const gBalls = new Float64Array(ds.sizes.ground);
for (let i = 0; i < ds.n; i++) gBalls[ds.ground[i]]++;
const grounds = ds.groundNames.map((g, k) => ({ g, e: runFit.effs[sit("ground")][k] * 100, n: gBalls[k] })).filter((x) => x.n >= 3000).sort((a, b) => b.e - a.e);
md.push("", "| Highest-scoring grounds (3000+ balls) | Effect |", "|---|---|");
for (const x of grounds.slice(0, 8)) md.push(`| ${x.g} | ${f1(x.e)} |`);
md.push("", "| Lowest-scoring grounds | Effect |", "|---|---|");
for (const x of grounds.slice(-8).reverse()) md.push(`| ${x.g} | ${f1(x.e)} |`);

const table = (title: string, list: Row[], kind: "bat" | "bowl", unit: string) => {
  md.push("", `## ${title}`, "", `| Player | Balls | Model (${unit}) | Raw career (${unit}) | Model minus raw |`, "|---|---|---|---|---|");
  for (const r of list) {
    const m = kind === "bat" ? r.batModel : r.bowlModel, w = kind === "bat" ? r.batRaw : r.bowlRaw, n = kind === "bat" ? r.batBalls : r.bowlBalls;
    md.push(`| ${r.name} | ${n} | ${f1(m)} | ${f1(w)} | ${f1(m! - w!)} |`);
  }
};
const batters = rows.filter((r) => r.batModel !== undefined && r.batBalls >= 500);
const bowlers = rows.filter((r) => r.bowlModel !== undefined && r.bowlBalls >= 400);
table("Top 25 batters", [...batters].sort((a, b) => b.batModel! - a.batModel!).slice(0, 25), "bat", "runs above average per 100 balls");
table("Top 25 bowlers", [...bowlers].sort((a, b) => b.bowlModel! - a.bowlModel!).slice(0, 25), "bowl", "runs saved per 4-over spell");
table("Batters the model marks down most against raw career numbers", [...batters].sort((a, b) => a.batModel! - a.batRaw! - (b.batModel! - b.batRaw!)).slice(0, 12), "bat", "runs above average per 100 balls");
table("Batters the model marks up most", [...batters].sort((a, b) => b.batModel! - b.batRaw! - (a.batModel! - a.batRaw!)).slice(0, 12), "bat", "runs above average per 100 balls");
table("Bowlers the model marks down most", [...bowlers].sort((a, b) => a.bowlModel! - a.bowlRaw! - (b.bowlModel! - b.bowlRaw!)).slice(0, 12), "bowl", "runs saved per 4-over spell");
table("Bowlers the model marks up most", [...bowlers].sort((a, b) => b.bowlModel! - b.bowlRaw! - (a.bowlModel! - a.bowlRaw!)).slice(0, 12), "bowl", "runs saved per 4-over spell");

const WATCH = ["V Kohli", "JJ Bumrah", "Rashid Khan", "SP Narine", "Imran Tahir", "Al-Amin Hossain", "SA Yadav", "HC Brook", "Babar Azam", "RG Sharma", "Mustafizur Rahman", "Shakib Al Hasan", "TG Southee", "AD Russell", "Washington Sundar"];
md.push("", "## Watch list", "", "| Player | Bat balls | Bat model | Bat raw | Bowl balls | Bowl model | Bowl raw |", "|---|---|---|---|---|---|---|");
for (const n of WATCH) {
  const r = rows.find((x) => x.name === n);
  md.push(r ? `| ${r.name} | ${r.batBalls} | ${f1(r.batModel)} | ${f1(r.batRaw)} | ${r.bowlBalls} | ${f1(r.bowlModel)} | ${f1(r.bowlRaw)} |` : `| ${n} | not found | | | | | |`);
}
md.push("", "## Tuning grid (validation skill score, runs per ball)", "", "| Batter penalty | Bowler penalty | Skill |", "|---|---|---|");
for (const g of tuned.runs.grid) md.push(`| ${g.bat} | ${g.bowl} | ${pct(g.skill)} |`);
fs.writeFileSync(path.resolve("data/rating-model-report.md"), md.join("\n") + "\n");

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const players: Record<string, unknown> = {};
for (const id of ids) {
  const b = batIdx.get(id), w = bowlIdx.get(id);
  const bb = b === undefined ? 0 : counts.bat[b], wb = w === undefined ? 0 : counts.bowl[w];
  if (bb < 50 && wb < 50) continue;
  players[`crick_${id}`] = {
    n: names.get(id) ?? id,
    bb, wb,
    ...(b !== undefined && bb >= 50 ? { br: r5(cr.bat(b)), bo: r5(cw.bat(b)) } : {}),
    ...(w !== undefined && wb >= 50 ? { wr: r5(cr.bowl(w)), ww: r5(cw.bowl(w)) } : {}),
  };
}
fs.writeFileSync(
  path.resolve("data/player-ratings-t20.json"),
  JSON.stringify({ meta: { matches: ds.matches, deliveries: ds.n, wicketValue: r5(W.all), wicketValueByPhase: W.byPhase.map(r5), lambdas: { runs: tuned.runs.lam, wkt: tuned.wkt.lam }, mu: { runs: r5(runFit.mu), wkt: r5(wktFit.mu) }, through: dates.to }, players }) + "\n"
);
console.log(`[ratings] wrote data/rating-model-report.md and data/player-ratings-t20.json (${Object.keys(players).length} players)`);
