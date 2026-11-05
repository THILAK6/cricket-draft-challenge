import fs from "node:fs";
import path from "node:path";

/**
 * Cricsheet ball-by-ball data only starts in 2001-2002, so players whose careers began earlier
 * (Tendulkar, Ponting, ...) have truncated totals. This script reads full-career numbers from the
 * Wikipedia cricketer infobox (matches, runs, average, balls bowled, wickets, bowling average),
 * finds each player's article through the ESPNcricinfo id on Wikidata, and writes
 * data/career-overrides.sql. Strike rate, phase splits and batting-order shares stay as measured
 * by Cricsheet, so the match engine keeps its ball-by-ball flavour.
 *
 * Usage: npm run etl:career   (needs network; caches to data/cache/career-stats.json)
 */

const UA = "cricket-draft-challenge/1.0 (personal project; career stats enrichment)";
const dataDir = path.resolve(process.cwd(), "data");
const seedPath = path.join(dataDir, "seed.sql");
const cachePath = path.join(dataDir, "cache/career-stats.json");
const outPath = path.join(dataDir, "career-overrides.sql");

type Fmt = "TEST" | "ODI" | "T20";
interface CareerLine {
  matches: number;
  runs: number;
  batAvg: number;
  deliveries: number;
  wickets: number;
  bowlAvg: number;
}
type Career = Partial<Record<Fmt, CareerLine>>;
interface Entry {
  /** Wikipedia article title, e.g. "Thisara Perera"; used as the display name. */
  title?: string;
  career: Career;
}

/** "Sachin Tendulkar (cricketer)" -> "Sachin Tendulkar"; null if it does not look like a person's name. */
export function displayName(title: string | undefined): string | null {
  if (!title) return null;
  const t = title.replace(/\s*\(.*?\)\s*$/, "").trim();
  return /^[\p{L}.'’ -]{3,40}$/u.test(t) && t.includes(" ") ? t : null;
}

const num = (v: string | undefined): number => {
  if (!v) return NaN;
  const m = v.replace(/<!--.*?-->/g, "").replace(/\{\{.*?\}\}/g, "").replace(/\[\[.*?\]\]/g, "").replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};

/** Parses the Test/ODI/T20I columns of `{{Infobox cricketer}}`. Exported for tests. */
export function parseInfobox(wikitext: string): Career {
  const start = wikitext.indexOf("{{Infobox cricketer");
  if (start < 0) return {};
  const body = wikitext.slice(start);
  const fields = new Map<string, string>();
  for (const line of body.split("\n")) {
    const m = line.match(/^\|\s*([^=]+?)\s*=\s*(.*)$/);
    if (m) fields.set(m[1].trim(), m[2].trim());
    if (line.startsWith("}}") && fields.size > 5) break;
  }
  const career: Career = {};
  for (let i = 1; i <= 8; i++) {
    const colName = (fields.get(i === 1 ? "column1" : `column${i}`) ?? "").toLowerCase();
    const label = colName.includes("t20i") || colName.includes("twenty20 international")
      ? "T20"
      : colName.includes("odi") || colName.includes("one day international")
      ? "ODI"
      : colName.includes("|test]]") || /\btest\b/.test(colName)
      ? "TEST"
      : null;
    if (!label) continue;
    const matches = num(fields.get(`matches${i}`));
    const runs = num(fields.get(`runs${i}`));
    const batAvg = num(fields.get(`bat avg${i}`));
    if (!(matches > 0) || !(runs >= 0) || !(batAvg > 0)) continue;
    career[label] = {
      matches,
      runs,
      batAvg,
      deliveries: num(fields.get(`deliveries${i}`)),
      wickets: num(fields.get(`wickets${i}`)),
      bowlAvg: num(fields.get(`bowl avg${i}`)),
    };
  }
  return career;
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init?.headers ?? {}) } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error(`Request failed: ${url.slice(0, 120)}`);
}

async function wikiTitles(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const query = `SELECT ?id ?title WHERE { VALUES ?id { ${batch.map((x) => `"${x}"`).join(" ")} } ?p wdt:P2697 ?id . ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title . }`;
    const json = await getJson(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`);
    for (const b of json.results.bindings) out.set(b.id.value, b.title.value);
    process.stdout.write(`\rWikidata ${Math.min(i + 200, ids.length)}/${ids.length}`);
  }
  process.stdout.write("\n");
  return out;
}

async function fetchCareers(titles: string[]): Promise<Map<string, Career>> {
  const out = new Map<string, Career>();
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(batch.join("|"))}`;
    let json: any;
    try {
      json = await getJson(url);
    } catch {
      console.warn(`\nskipping a batch of ${batch.length} titles after repeated failures`);
      continue;
    }
    const redirected = new Map<string, string>((json.query?.redirects ?? []).map((r: any) => [r.to, r.from]));
    for (const page of json.query?.pages ?? []) {
      const text = page.revisions?.[0]?.slots?.main?.content;
      if (!text) continue;
      const career = parseInfobox(text);
      out.set(page.title, career);
      const from = redirected.get(page.title);
      if (from) out.set(from, career);
    }
    process.stdout.write(`\rWikipedia ${Math.min(i + 20, titles.length)}/${titles.length}`);
    await new Promise((r) => setTimeout(r, 800));
  }
  process.stdout.write("\n");
  return out;
}

interface SeedRow {
  matches: number;
  batInnings: number;
  top: number;
  middle: number;
  finisher: number;
  bowlInnings: number;
  sr: number;
  /** Cricsheet bowling columns, restored when the infobox has too little bowling to trust. */
  bowl: number[];
}

function readSeed() {
  const sql = fs.readFileSync(seedPath, "utf8");
  const players = new Map<string, { cricinfo: string; name: string }>();
  for (const m of sql.matchAll(/INSERT OR REPLACE INTO players \(id, cricinfo_id, name[^)]*\) VALUES \('([^']+)', '([^']+)', '((?:[^']|'')*)'/g)) {
    players.set(m[1], { cricinfo: m[2], name: m[3].replace(/''/g, "'") });
  }
  const stats = new Map<string, SeedRow>();
  for (const m of sql.matchAll(/INSERT OR REPLACE INTO player_format_stats \([^)]*\) VALUES \('([^']+)', '([^']+)', ([^;]*)\);/g)) {
    const v = m[3].split(",").map((x) => parseFloat(x.trim()));
    // matches, bat_innings, bat_runs, bat_balls, bat_average, bat_strike_rate, top, middle, finisher, bowl_innings, ...
    stats.set(`${m[1]}|${m[2]}`, { matches: v[0], batInnings: v[1], top: v[6], middle: v[7], finisher: v[8], bowlInnings: v[9], sr: v[5], bowl: v.slice(10, 15) });
  }
  return { players, stats };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const { players, stats } = readSeed();
  const ids = [...new Set([...players.values()].map((p) => p.cricinfo))];
  console.log(`${players.size} players, ${stats.size} format rows`);

  let cache: Record<string, Entry> = {};
  if (fs.existsSync(cachePath) && !process.argv.includes("--refresh")) cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  // Older caches stored the career object directly; refetch those.
  for (const [k, v] of Object.entries(cache)) if (!v || typeof v !== "object" || !("career" in v)) delete cache[k];
  const missing = ids.filter((id) => !(id in cache));
  if (missing.length) {
    const titles = await wikiTitles(missing);
    const careers = await fetchCareers([...new Set(titles.values())]);
    for (const id of missing) {
      const t = titles.get(id);
      cache[id] = { title: t, career: (t && careers.get(t)) || {} };
    }
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  }

  const lines: string[] = ["-- Full-career totals from Wikipedia infoboxes; see src/etl/career-overrides.ts", ""];
  let applied = 0;
  const report: string[] = [];
  for (const [pid, p] of players) {
    const entry = cache[p.cricinfo];
    if (!entry) continue;
    const career = entry.career;
    const nice = displayName(entry.title);
    if (nice && nice !== p.name) lines.push(`UPDATE players SET name = '${nice.replace(/'/g, "''")}' WHERE id = '${pid}';`);
    for (const fmt of ["TEST", "ODI", "T20"] as Fmt[]) {
      const c = career[fmt];
      const s = stats.get(`${pid}|${fmt}`);
      if (!c || !s) continue;
      // Only replace when Cricsheet is clearly missing part of the career.
      if (c.matches < s.matches * 1.15 + 2) continue;
      const ratio = c.matches / s.matches;
      const sr = s.sr > 0 ? s.sr : fmt === "TEST" ? 50 : fmt === "ODI" ? 80 : 125;
      const batInnings = Math.max(1, Math.round(s.batInnings * ratio));
      const set: string[] = [
        `matches = ${c.matches}`,
        `bat_innings = ${batInnings}`,
        `bat_runs = ${c.runs}`,
        `bat_balls = ${Math.round((c.runs * 100) / sr)}`,
        `bat_average = ${r2(c.batAvg)}`,
        `top_order_innings = ${Math.round(s.top * ratio)}`,
        `middle_order_innings = ${Math.round(s.middle * ratio)}`,
        `finisher_innings = ${Math.round(s.finisher * ratio)}`,
        `bowl_innings = ${Math.round(s.bowlInnings * ratio)}`,
      ];
      // Part-timers bowl too little for the infobox figures to mean anything (e.g. 20 overs in 300 matches).
      if (c.deliveries >= 300 && c.wickets >= 5 && c.bowlAvg > 0) {
        const overs = c.deliveries / 6;
        const conceded = Math.round(c.wickets * c.bowlAvg);
        set.push(`bowl_overs = ${r2(overs)}`, `bowl_wickets = ${c.wickets}`, `bowl_runs_conceded = ${conceded}`, `bowl_average = ${r2(c.bowlAvg)}`, `bowl_economy = ${r2(conceded / overs)}`);
      } else if (s.bowl.length === 5 && s.bowl.every((x) => Number.isFinite(x))) {
        const [bo, bw, br, ba, be] = s.bowl;
        set.push(`bowl_overs = ${bo}`, `bowl_wickets = ${bw}`, `bowl_runs_conceded = ${br}`, `bowl_average = ${ba}`, `bowl_economy = ${be}`);
      }
      lines.push(`UPDATE player_format_stats SET ${set.join(", ")} WHERE player_id = '${pid}' AND format = '${fmt}';`);
      applied++;
      if (report.length < 12) report.push(`${p.name} ${fmt}: ${s.matches} -> ${c.matches} matches, ${c.runs} runs @ ${c.batAvg}`);
    }
  }
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  const covered = Object.values(cache).filter((c) => Object.keys(c.career).length > 0).length;
  console.log(`Wikipedia career data found for ${covered}/${ids.length} players; ${applied} format rows overridden`);
  console.log(report.join("\n"));
}

if (process.argv[1] && process.argv[1].endsWith("career-overrides.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
