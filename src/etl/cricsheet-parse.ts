import { BOWLER_WICKETS, type ParsedMatch, type Row } from "./rating-model";

/** Teams whose matches define "average": the game's Full Member nations. */
export const FULL_MEMBERS = new Set(["India", "Australia", "England", "Pakistan", "South Africa", "New Zealand", "West Indies", "Sri Lanka", "Bangladesh", "Zimbabwe", "Ireland", "Afghanistan"]);

/** Batting position (1-based arrival order) to 0 opener, 1 #3, 2 #4-5, 3 #6-7, 4 tail. */
const posBucket = (n: number) => (n <= 2 ? 0 : n === 3 ? 1 : n <= 5 ? 2 : n <= 7 ? 3 : 4);
const phaseOf = (over: number) => (over < 6 ? 0 : over < 15 ? 1 : 2);

/**
 * One Cricsheet T20 match as deliveries, or null when it should not count (women's, no player
 * ids, shortened, no date). Associate matches are kept: they are how the model learns who is weak.
 */
export function parseT20(match: any, names?: Map<string, string>): ParsedMatch | null {
  const info = match?.info ?? {};
  if (info.gender !== "male" || !info.registry?.people) return null;
  if (info.overs && info.overs !== 20) return null;
  const date = String(info.dates?.[0] ?? "");
  const year = Number(date.slice(0, 4));
  if (!(year > 1999)) return null;
  const people: Record<string, string> = info.registry.people;
  if (names) for (const [n, id] of Object.entries(people)) names.set(id, n);
  const teams: string[] = info.teams ?? Object.keys(info.players ?? {});
  const fm = teams.length === 2 && teams.every((t) => FULL_MEMBERS.has(t));

  const innings: Row[][] = [];
  const all = (match.innings ?? []).filter((i: any) => !i.super_over);
  all.slice(0, 2).forEach((inn: any, idx: number) => {
    if (inn.target?.overs && inn.target.overs < 20) return;
    const order: string[] = [];
    let down = 0;
    const rows: Row[] = [];
    for (const o of inn.overs ?? []) {
      for (const d of o.deliveries ?? []) {
        for (const n of [d.batter, d.non_striker]) if (!order.includes(n)) order.push(n);
        const batter = people[d.batter], bowler = people[d.bowler];
        const outs = (d.wickets ?? []) as any[];
        if (batter && bowler) {
          const ex = d.extras ?? {};
          rows.push({
            bat: batter,
            bowl: bowler,
            ctx: phaseOf(o.over) * 2 + (idx === 0 ? 0 : 1),
            pos: posBucket(order.indexOf(d.batter) + 1),
            over: o.over,
            wb: down,
            runs: (d.runs?.batter ?? 0) + (ex.wides ?? 0) + (ex.noballs ?? 0),
            wkt: outs.some((w) => w.player_out === d.batter && BOWLER_WICKETS.has(w.kind)) ? 1 : 0,
            legal: !ex.wides,
          });
        }
        down += outs.length;
      }
    }
    if (rows.length) innings.push(rows);
  });
  if (!innings.length) return null;
  return { date, ground: String(info.venue ?? "unknown"), year, fm, innings };
}
