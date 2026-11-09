import fs from "node:fs";
import path from "node:path";

/**
 * Player splits from Cricsheet ball-by-ball data (T20Is, ODIs, Tests), for the match engine:
 *  - phases (T20: overs 1-6 / 7-15 / 16-20, ODI: 1-10 / 11-40 / 41-50)
 *  - batting position (opening, #3, #4-5, #6-7, #8 and below)
 *  - region of the ground (Asia, SENA, elsewhere)
 *  - batting first or chasing (T20 and ODI)
 * plus the typical international's numbers for each split, and real first-innings par scores at
 * the game's grounds.
 *
 *   npx tsx src/etl/splits.ts [data/raw]
 *
 * Reads data/raw/{t20s,odis,tests}_json and writes data/phase-stats.sql, data/player-splits.sql and
 * src/core/data-norms.generated.ts. Run by .github/workflows/phase-stats.yml (cricsheet.org is not
 * reachable from every environment). Ids are the same `crick_<cricsheet id>` as data/seed.sql.
 */

type Fmt = "T20" | "ODI" | "TEST";
const RAW = path.resolve(process.argv[2] ?? "data/raw");
const SOURCES: { fmt: Fmt; dir: string; overs?: number; minMatches: number }[] = [
  { fmt: "T20", dir: "t20s_json", overs: 20, minMatches: 8 },
  { fmt: "ODI", dir: "odis_json", overs: 50, minMatches: 8 },
  { fmt: "TEST", dir: "tests_json", minMatches: 5 },
];

const FULL_MEMBERS = new Set(["India", "Australia", "England", "Pakistan", "South Africa", "New Zealand", "West Indies", "Sri Lanka", "Bangladesh", "Zimbabwe", "Ireland", "Afghanistan"]);

/** Phase of a 0-based over. */
function phaseOf(fmt: Fmt, over: number): "pp" | "mid" | "death" | null {
  if (fmt === "T20") return over < 6 ? "pp" : over < 15 ? "mid" : "death";
  if (fmt === "ODI") return over < 10 ? "pp" : over < 40 ? "mid" : "death";
  return null;
}

/** Batting position (1-based arrival order) to the buckets the engine uses. */
const POS = ["open", "three", "four5", "six7", "tail"] as const;
type Pos = (typeof POS)[number];
const posOf = (n: number): Pos => (n <= 2 ? "open" : n === 3 ? "three" : n <= 5 ? "four5" : n <= 7 ? "six7" : "tail");

/** Conditions by region: the subcontinent and the UAE; England, Australia, NZ, South Africa (and Ireland, Scotland, the Netherlands); the rest. */
type Region = "asia" | "sena" | "other";
const REGIONS: Region[] = ["asia", "sena", "other"];
const CITY_REGION: Record<string, Region> = {};
const add = (r: Region, cities: string) => cities.split(",").forEach((c) => (CITY_REGION[c.trim().toLowerCase()] = r));
add("asia", "Mumbai,Delhi,New Delhi,Kolkata,Chennai,Madras,Bangalore,Bengaluru,Hyderabad,Ahmedabad,Mohali,Chandigarh,Nagpur,Pune,Rajkot,Indore,Kanpur,Lucknow,Dharamsala,Dharmasala,Ranchi,Visakhapatnam,Vizag,Cuttack,Guwahati,Thiruvananthapuram,Jaipur,Vadodara,Baroda,Jamshedpur,Kochi,Gwalior,Raipur,Margao,Navi Mumbai,Greater Noida,Dehradun,Faridabad,Jodhpur,Amritsar,Jalandhar,Bhubaneswar,Mullanpur,New Chandigarh,Karachi,Lahore,Rawalpindi,Multan,Faisalabad,Peshawar,Sialkot,Gujranwala,Sheikhupura,Quetta,Bahawalpur,Colombo,Kandy,Galle,Dambulla,Hambantota,Pallekele,Moratuwa,Kurunegala,Dhaka,Mirpur,Chittagong,Chattogram,Fatullah,Khulna,Sylhet,Bogra,Narayanganj,Dubai,Abu Dhabi,Sharjah,Kabul,Kirtipur,Muscat,Al Amarat,Kathmandu");
add("sena", "London,Birmingham,Manchester,Leeds,Nottingham,Southampton,Cardiff,Bristol,Chester-le-Street,Durham,Taunton,Hove,Chelmsford,Northampton,Leicester,Derby,Canterbury,Worcester,Scarborough,Edinburgh,Aberdeen,Glasgow,Dublin,Belfast,Malahide,Bready,Clontarf,Amstelveen,Rotterdam,The Hague,Utrecht,Sydney,Melbourne,Adelaide,Brisbane,Perth,Hobart,Canberra,Darwin,Cairns,Townsville,Geelong,Gold Coast,Carrara,Mackay,Launceston,Auckland,Wellington,Christchurch,Hamilton,Napier,Dunedin,Nelson,Mount Maunganui,Tauranga,Queenstown,New Plymouth,Whangarei,Lincoln,Johannesburg,Cape Town,Durban,Centurion,Port Elizabeth,Gqeberha,East London,Bloemfontein,Paarl,Kimberley,Potchefstroom,Benoni,Pietermaritzburg,Pretoria");
// Two cities share a name with an Indian one: Hyderabad (Sindh) and the venue decides
const VENUE_REGION: [RegExp, Region][] = [[/Niaz Stadium/i, "asia"]];

/** The game's grounds (src/worker/scenario-generator.ts) and how Cricsheet names them. */
const GROUNDS: [string, RegExp][] = [
  ["Lord's Cricket Ground, London", /^Lord'?s/i],
  ["Edgbaston, Birmingham", /Edgbaston/i],
  ["Headingley, Leeds", /Headingley/i],
  ["The Oval, London", /Kennington Oval|^The Oval|^Oval/i],
  ["Melbourne Cricket Ground", /Melbourne Cricket Ground/i],
  ["The Gabba, Brisbane", /Brisbane Cricket Ground|Gabba/i],
  ["WACA Ground, Perth", /W\.?A\.?C\.?A/i],
  ["Sydney Cricket Ground", /Sydney Cricket Ground/i],
  ["Adelaide Oval", /Adelaide Oval/i],
  ["Eden Gardens, Kolkata", /Eden Gardens/i],
  ["Wankhede Stadium, Mumbai", /Wankhede/i],
  ["M. Chinnaswamy Stadium, Bengaluru", /Chinnaswamy/i],
  ["MA Chidambaram Stadium, Chennai", /Chidambaram/i],
  ["Narendra Modi Stadium, Ahmedabad", /Narendra Modi|Sardar Patel Stadium|Motera/i],
  ["Wanderers Stadium, Johannesburg", /Wanderers/i],
  ["Newlands, Cape Town", /Newlands/i],
  ["Kingsmead, Durban", /Kingsmead/i],
  ["SuperSport Park, Centurion", /SuperSport Park|Centurion Park/i],
  ["Galle International Stadium", /Galle International/i],
  ["R. Premadasa Stadium, Colombo", /Premadasa/i],
  ["Pallekele International Cricket Stadium", /Pallekele/i],
  ["Gaddafi Stadium, Lahore", /Gaddafi/i],
  ["National Stadium, Karachi", /National Stadium.*Karachi|^National Stadium$/i],
  ["Dubai International Stadium", /Dubai International|Dubai Sports City/i],
  ["Sheikh Zayed Stadium, Abu Dhabi", /Sheikh Zayed|Zayed Cricket Stadium/i],
  ["Eden Park, Auckland", /^Eden Park/i],
  ["Basin Reserve, Wellington", /Basin Reserve/i],
  ["Hagley Oval, Christchurch", /Hagley Oval/i],
  ["Sabina Park, Kingston", /Sabina Park/i],
  ["Kensington Oval, Bridgetown", /Kensington Oval/i],
  ["Shere Bangla National Stadium, Dhaka", /Shere Bangla|Sher-e-Bangla/i],
  ["Harare Sports Club", /Harare Sports Club/i],
];

function regionOf(info: any): Region | null {
  const venue = String(info.venue ?? "");
  for (const [re, r] of VENUE_REGION) if (re.test(venue)) return r;
  const city = String(info.city ?? "").toLowerCase();
  if (CITY_REGION[city]) return CITY_REGION[city];
  if (city) return "other";
  // No city: try a known city inside the venue name ("Eden Gardens, Kolkata")
  for (const [c, r] of Object.entries(CITY_REGION)) if (venue.toLowerCase().includes(c)) return r;
  return null;
}

// ---- Accumulators ---------------------------------------------------------------------------
/** [runs, balls, outs] for batting; [balls, runs, wkts] for bowling. */
type Bat = [number, number, number];
type Bowl = [number, number, number];
const z3 = (): [number, number, number] => [0, 0, 0];

interface PlayerSplits {
  matches: number;
  phase: Record<string, { bat: Bat; bowl: Bowl }>;
  pos: Record<string, [number, number, number, number]>; // runs, balls, outs, innings
  region: Record<string, { bat: Bat; bowl: Bowl }>;
  chase: Record<string, Bat>; // first, second
}
const players: Record<Fmt, Map<string, PlayerSplits>> = { T20: new Map(), ODI: new Map(), TEST: new Map() };
const get = (fmt: Fmt, id: string): PlayerSplits => {
  let p = players[fmt].get(id);
  if (!p) players[fmt].set(id, (p = { matches: 0, phase: {}, pos: {}, region: {}, chase: {} }));
  return p;
};
const slot = <T,>(rec: Record<string, T>, key: string, make: () => T): T => (rec[key] ??= make());

/** Norm accumulators: Full Member v Full Member deliveries only. */
const norms: Record<Fmt, { phase: Record<string, { bat: Bat; bowl: Bowl }>; pos: Record<string, Bat>; region: Record<string, { bat: Bat; bowl: Bowl }>; chase: Record<string, Bat>; all: { bat: Bat; bowl: Bowl } }> = {
  T20: { phase: {}, pos: {}, region: {}, chase: {}, all: { bat: z3(), bowl: z3() } },
  ODI: { phase: {}, pos: {}, region: {}, chase: {}, all: { bat: z3(), bowl: z3() } },
  TEST: { phase: {}, pos: {}, region: {}, chase: {}, all: { bat: z3(), bowl: z3() } },
};
/**
 * Era baselines: Full Member v Full Member deliveries by era bucket (as core/era.ts buckets them:
 * three years in T20, five otherwise). Associate matches are left out: since 2019 they are most
 * T20Is, and counting them made the 2020s look like a low-scoring era.
 */
const eraBucket = (fmt: Fmt, year: number) => String(fmt === "T20" ? Math.floor(year / 3) * 3 : Math.floor(year / 5) * 5);
const era: Record<Fmt, Record<string, { bat: Bat; bowl: Bowl }>> = { T20: {}, ODI: {}, TEST: {} };

/**
 * Real innings by position in the match (Full Member v Full Member, full-length): how many, mean runs,
 * mean overs, how often all out or declared. And how matches end. For checking the engine against reality.
 */
const innStats: Record<Fmt, { n: number; runs: number; balls: number; allOut: number; declared: number }[]> = { T20: [], ODI: [], TEST: [] };
const resStats: Record<Fmt, { matches: number; draws: number; ties: number; decisive: number; batFirstWins: number }> = {
  T20: { matches: 0, draws: 0, ties: 0, decisive: 0, batFirstWins: 0 },
  ODI: { matches: 0, draws: 0, ties: 0, decisive: 0, batFirstWins: 0 },
  TEST: { matches: 0, draws: 0, ties: 0, decisive: 0, batFirstWins: 0 },
};

/** First-innings totals: at each game ground (all internationals), and Full Member matches overall. */
const par: Record<Fmt, { ground: Record<string, number[]>; all: number[] }> = { T20: { ground: {}, all: [] }, ODI: { ground: {}, all: [] }, TEST: { ground: {}, all: [] } };

const BOWLER_WICKETS = new Set(["bowled", "caught", "caught and bowled", "lbw", "stumped", "hit wicket"]);

for (const src of SOURCES) {
  const dir = path.join(RAW, src.dir);
  if (!fs.existsSync(dir)) {
    console.error(`[splits] Missing ${dir}: download https://cricsheet.org/downloads/${src.dir}.zip and unzip it there.`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let used = 0;
  for (const file of files) {
    let match: any;
    try {
      match = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    } catch {
      continue;
    }
    const info = match.info ?? {};
    if (info.gender !== "male" || !info.registry?.people) continue;
    // Full-length limited-overs matches only: shortened ones distort phases and totals
    if (src.overs && info.overs && info.overs !== src.overs) continue;
    const people: Record<string, string> = info.registry.people;
    const teams: string[] = info.teams ?? Object.keys(info.players ?? {});
    const fullMembers = teams.length === 2 && teams.every((t) => FULL_MEMBERS.has(t));
    const region = regionOf(info);
    const ground = GROUNDS.find(([, re]) => re.test(String(info.venue ?? "")))?.[0];
    const year = Number(String(info.dates?.[0] ?? "").slice(0, 4));
    const eraSlot = fullMembers && year > 1900 ? slot(era[src.fmt], eraBucket(src.fmt, year), () => ({ bat: z3(), bowl: z3() })) : null;
    for (const names of Object.values(info.players ?? {}) as string[][]) for (const n of names) if (people[n]) get(src.fmt, people[n]).matches++;

    const innings = (match.innings ?? []).filter((i: any) => !i.super_over);
    innings.forEach((inn: any, idx: number) => {
      const order: string[] = [];
      let total = 0;
      let legalBalls = 0;
      let wicketsDown = 0;
      let reduced = false;
      // Limited overs: the side batting second is chasing
      const chase = src.fmt === "TEST" ? null : idx === 0 ? "first" : idx === 1 ? "second" : null;
      if (inn.target?.overs && src.overs && inn.target.overs < src.overs) reduced = true;
      for (const o of inn.overs ?? []) {
        const phase = phaseOf(src.fmt, o.over);
        for (const d of o.deliveries ?? []) {
          for (const n of [d.batter, d.non_striker]) if (!order.includes(n)) order.push(n);
          const ex = d.extras ?? {};
          total += d.runs?.total ?? 0;
          const batter = people[d.batter];
          const bowler = people[d.bowler];
          const pos = posOf(order.indexOf(d.batter) + 1);
          const legalForBatter = !ex.wides;
          const legalForBowler = !ex.wides && !ex.noballs;
          if (legalForBowler) legalBalls++;
          wicketsDown += ((d.wickets ?? []) as any[]).length;
          const batRuns = d.runs?.batter ?? 0;
          const conceded = batRuns + (ex.wides ?? 0) + (ex.noballs ?? 0);
          const outs = (d.wickets ?? []) as any[];
          const batterOut = outs.some((w) => w.player_out === d.batter) ? 1 : 0;
          const bowlerWkts = outs.filter((w) => BOWLER_WICKETS.has(w.kind)).length;

          const addBat = (a: Bat) => {
            a[0] += batRuns;
            if (legalForBatter) a[1] += 1;
            a[2] += batterOut;
          };
          const addBowl = (a: Bowl) => {
            if (legalForBowler) a[0] += 1;
            a[1] += conceded;
            a[2] += bowlerWkts;
          };
          if (batter) {
            const p = get(src.fmt, batter);
            if (phase) addBat(slot(p.phase, phase, () => ({ bat: z3(), bowl: z3() })).bat);
            const ps = slot(p.pos, pos, () => [0, 0, 0, 0] as [number, number, number, number]);
            ps[0] += batRuns;
            if (legalForBatter) ps[1] += 1;
            ps[2] += batterOut;
            if (region) addBat(slot(p.region, region, () => ({ bat: z3(), bowl: z3() })).bat);
            if (chase) addBat(slot(p.chase, chase, z3));
          }
          // A non-striker run out counts against the non-striker
          for (const w of outs) {
            if (w.player_out !== d.batter && people[w.player_out]) {
              const np = get(src.fmt, people[w.player_out]);
              const npos = posOf(order.indexOf(w.player_out) + 1);
              slot(np.pos, npos, () => [0, 0, 0, 0] as [number, number, number, number])[2] += 1;
              if (phase) slot(np.phase, phase, () => ({ bat: z3(), bowl: z3() })).bat[2] += 1;
              if (region) slot(np.region, region, () => ({ bat: z3(), bowl: z3() })).bat[2] += 1;
              if (chase) slot(np.chase, chase, z3)[2] += 1;
            }
          }
          if (bowler) {
            const p = get(src.fmt, bowler);
            if (phase) addBowl(slot(p.phase, phase, () => ({ bat: z3(), bowl: z3() })).bowl);
            if (region) addBowl(slot(p.region, region, () => ({ bat: z3(), bowl: z3() })).bowl);
          }
          if (fullMembers) {
            const n = norms[src.fmt];
            addBat(n.all.bat);
            addBowl(n.all.bowl);
            if (eraSlot) {
              addBat(eraSlot.bat);
              addBowl(eraSlot.bowl);
            }
            if (phase) {
              const s = slot(n.phase, phase, () => ({ bat: z3(), bowl: z3() }));
              addBat(s.bat);
              addBowl(s.bowl);
            }
            addBat(slot(n.pos, pos, z3));
            for (const w of outs) if (w.player_out !== d.batter) slot(n.pos, posOf(order.indexOf(w.player_out) + 1), z3)[2] += 1;
            if (region) {
              const s = slot(n.region, region, () => ({ bat: z3(), bowl: z3() }));
              addBat(s.bat);
              addBowl(s.bowl);
            }
            if (chase) addBat(slot(n.chase, chase, z3));
          }
        }
      }
      // Innings at each position, for the record "at #3: 40 innings"
      order.forEach((n, i) => {
        if (people[n]) slot(get(src.fmt, people[n]).pos, posOf(i + 1), () => [0, 0, 0, 0] as [number, number, number, number])[3] += 1;
      });
      if (fullMembers && !reduced && idx < 4 && legalBalls > 0) {
        const s = (innStats[src.fmt][idx] ??= { n: 0, runs: 0, balls: 0, allOut: 0, declared: 0 });
        s.n++;
        s.runs += total;
        s.balls += legalBalls;
        if (wicketsDown >= 10) s.allOut++;
        if (inn.declared) s.declared++;
      }
      if (idx === 0 && !reduced && total > 0) {
        if (ground) (par[src.fmt].ground[ground] ??= []).push(total);
        if (fullMembers) par[src.fmt].all.push(total);
      }
    });
    if (fullMembers && !(src.overs && info.overs && info.overs !== src.overs)) {
      const r = resStats[src.fmt], o = info.outcome ?? {};
      r.matches++;
      if (o.result === "draw") r.draws++;
      else if (o.result === "tie") r.ties++;
      else if (o.winner) {
        r.decisive++;
        if (src.fmt !== "TEST" && o.winner === innings[0]?.team) r.batFirstWins++;
      }
    }
    used++;
  }
  console.log(`[splits] ${src.fmt}: ${used} matches`);
}

// ---- Output ---------------------------------------------------------------------------------
const r1 = (x: number) => Math.round(x * 100) / 100;
const batNorm = (a: Bat) => ({ sr: r1((a[0] / Math.max(1, a[1])) * 100), bpo: r1(a[1] / Math.max(1, a[2])) });
const bowlNorm = (a: Bowl) => ({ econ: r1((a[1] / Math.max(1, a[0])) * 6), bpw: r1(a[0] / Math.max(1, a[2])) });
const both = (s: { bat: Bat; bowl: Bowl }) => ({ ...batNorm(s.bat), ...bowlNorm(s.bowl) });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const normsOut: Record<string, unknown> = {};
for (const fmt of ["T20", "ODI", "TEST"] as Fmt[]) {
  const n = norms[fmt];
  normsOut[fmt] = {
    all: both(n.all),
    phase: Object.fromEntries(Object.entries(n.phase).map(([k, v]) => [k, both(v)])),
    pos: Object.fromEntries(POS.filter((k) => n.pos[k]).map((k) => [k, batNorm(n.pos[k])])),
    region: Object.fromEntries(REGIONS.filter((k) => n.region[k]).map((k) => [k, both(n.region[k])])),
    chase: Object.fromEntries(Object.entries(n.chase).map(([k, v]) => [k, batNorm(v)])),
    // League numbers in the form core/era.ts uses: strike rate, batting average, economy, bowling average
    era: Object.fromEntries(
      [...Object.entries(era[fmt]).sort(), ["all", n.all] as const].map(([k, v]) => [
        k,
        { sr: r1((v.bat[0] / Math.max(1, v.bat[1])) * 100), avg: r1(v.bat[0] / Math.max(1, v.bat[2])), econ: r1((v.bowl[1] / Math.max(1, v.bowl[0])) * 6), bavg: r1(v.bowl[1] / Math.max(1, v.bowl[2])), balls: v.bat[1] },
      ])
    ),
    innings: innStats[fmt].map((s) => ({ n: s.n, runs: Math.round(s.runs / s.n), overs: r1(s.balls / s.n / 6), allOut: r1((s.allOut / s.n) * 100), declared: r1((s.declared / s.n) * 100) })),
    results: resStats[fmt],
    par: {
      all: Math.round(mean(par[fmt].all)),
      ground: Object.fromEntries(Object.entries(par[fmt].ground).sort().map(([g, xs]) => [g, { avg: Math.round(mean(xs)), n: xs.length }])),
    },
  };
}
const ts = `// Generated by src/etl/splits.ts from Cricsheet ball-by-ball data. Do not edit.
// Typical Full Member numbers for each split (sr = strike rate, bpo = balls per dismissal,
// econ = runs per over, bpw = balls per wicket) and real first-innings par scores at the game's grounds.
export const DATA_NORMS = ${JSON.stringify(normsOut, null, 2)} as const;
`;
fs.writeFileSync(path.resolve("src/core/data-norms.generated.ts"), ts);

const esc = (s: string) => s.replace(/'/g, "''");
const batches = (rows: string[], head: string) =>
  Array.from({ length: Math.ceil(rows.length / 200) }, (_, i) => `${head} VALUES\n${rows.slice(i * 200, i * 200 + 200).join(",\n")};`);

// Phase stats (T20 and ODI), same layout as before: [bat_runs, bat_balls, bat_outs, bowl_balls, bowl_runs, bowl_wkts]
const phaseRows: string[] = [];
for (const fmt of ["T20", "ODI"] as Fmt[]) {
  const min = SOURCES.find((s) => s.fmt === fmt)!.minMatches;
  for (const [id, p] of [...players[fmt]].sort(([a], [b]) => a.localeCompare(b))) {
    if (p.matches < min) continue;
    const line = (k: string) => {
      const s = p.phase[k] ?? { bat: z3(), bowl: z3() };
      return [...s.bat, ...s.bowl];
    };
    phaseRows.push(`('crick_${esc(id)}', '${fmt}', '${JSON.stringify({ pp: line("pp"), mid: line("mid"), death: line("death") })}')`);
  }
}
fs.writeFileSync(
  path.resolve("data/phase-stats.sql"),
  [
    "-- Generated by src/etl/splits.ts from Cricsheet ball-by-ball data. Do not edit. Safe to run more than once.",
    "-- Each phase: [bat_runs, bat_balls, bat_outs, bowl_balls, bowl_runs, bowl_wkts]. T20: pp 1-6, mid 7-15, death 16-20. ODI: pp 1-10, mid 11-40, death 41-50.",
    "CREATE TABLE IF NOT EXISTS player_phase_stats (",
    "    player_id TEXT NOT NULL,",
    "    format TEXT NOT NULL,",
    "    phases TEXT NOT NULL,",
    "    PRIMARY KEY (player_id, format)",
    ");",
    "DELETE FROM player_phase_stats WHERE format IN ('T20', 'ODI', 'TEST');",
    ...batches(phaseRows, "INSERT OR REPLACE INTO player_phase_stats (player_id, format, phases)"),
    "",
  ].join("\n")
);

// Other splits: position [runs, balls, outs, innings], region {bat:[r,b,o], bowl:[balls,runs,wkts]}, chase [r,b,o]
const splitRows: string[] = [];
for (const fmt of ["T20", "ODI", "TEST"] as Fmt[]) {
  const min = SOURCES.find((s) => s.fmt === fmt)!.minMatches;
  for (const [id, p] of [...players[fmt]].sort(([a], [b]) => a.localeCompare(b))) {
    if (p.matches < min) continue;
    const data = {
      pos: p.pos,
      region: Object.fromEntries(Object.entries(p.region).map(([k, v]) => [k, [...v.bat, ...v.bowl]])),
      ...(fmt === "TEST" ? {} : { chase: p.chase }),
    };
    splitRows.push(`('crick_${esc(id)}', '${fmt}', '${esc(JSON.stringify(data))}')`);
  }
}
fs.writeFileSync(
  path.resolve("data/player-splits.sql"),
  [
    "-- Generated by src/etl/splits.ts from Cricsheet ball-by-ball data. Do not edit. Safe to run more than once.",
    "-- pos: {open|three|four5|six7|tail: [runs, balls, outs, innings]}; region: {asia|sena|other: [bat runs, balls, outs, bowl balls, runs, wkts]};",
    "-- chase (T20, ODI): {first|second: [runs, balls, outs]}.",
    "CREATE TABLE IF NOT EXISTS player_splits (",
    "    player_id TEXT NOT NULL,",
    "    format TEXT NOT NULL,",
    "    data TEXT NOT NULL,",
    "    PRIMARY KEY (player_id, format)",
    ");",
    "DELETE FROM player_splits WHERE format IN ('T20', 'ODI', 'TEST');",
    ...batches(splitRows, "INSERT OR REPLACE INTO player_splits (player_id, format, data)"),
    "",
  ].join("\n")
);
console.log(`[splits] ${phaseRows.length} phase rows, ${splitRows.length} split rows, norms -> src/core/data-norms.generated.ts`);
