import type { Challenge, MatchFormat, PickLogEntry, PlayerWithStats } from "./types";
import type { MatchSimulationResult } from "./simulator";
import type { Contribution } from "./impact";
import { battingRaw, bowlingRaw, battingRating, bowlingRating } from "./player-quality";
import { isNaturalOpener } from "./batting-order";
import { isBowlingOption } from "./validator";
import { calculateDeterministicScore } from "./scoring";
import { ballsToOvers } from "./overs";

/**
 * The argument after the game, the way it went at school: your openers against theirs, your
 * attack against theirs, and so on, then who got the steal of the draft. Each match-up shows real
 * career numbers; which side gets the arrow is decided from the same stats-only values the match
 * engine and the AI use (average and strike rate together, wickets and economy together).
 */

type Side = "USER" | "AI";
type Squad = (PlayerWithStats | null)[];

export interface UnitLine {
  /** Players in the unit, in batting order. */
  names: string[];
  /** Their career numbers, e.g. "avg 41 · SR 138". Empty when the unit has nobody. */
  stat: string;
}

export interface Matchup {
  key: "openers" | "middle" | "keeper" | "allrounders" | "pace" | "spin" | "depth" | "pitch";
  label: string;
  user: UnitLine;
  ai: UnitLine;
  edge: Side | "EVEN";
}

export interface HeadToHead {
  rows: Matchup[];
  /** Match-ups each side won. */
  won: Record<Side, number>;
}

export interface DraftAward {
  kind: "steal" | "best" | "regret";
  title: string;
  name: string;
  team: Side;
  /** Pick number in the draft (1-22). */
  pick: number;
  text: string;
}

export interface WinChance {
  played: number;
  wins: number;
  losses: number;
  /** Draws and ties. */
  draws: number;
}

export interface MatchReview {
  headToHead: HeadToHead;
  awards: DraftAward[];
  winChance?: WinChance;
}

const players = (s: Squad) => s.filter((p): p is PlayerWithStats => p !== null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** "avg 41 · SR 138" (Tests: the average alone, the strike rate matters little there). */
function batStat(ps: PlayerWithStats[], f: MatchFormat): string {
  if (!ps.length) return "";
  const avg = Math.round(mean(ps.map((p) => p.stats.bat_average || 0)));
  if (f === "TEST") return `avg ${avg}`;
  return `avg ${avg} · SR ${Math.round(mean(ps.map((p) => p.stats.bat_strike_rate || 0)))}`;
}

/** Balls per wicket, from career overs (overs are stored as a decimal count). */
const bowlSr = (p: PlayerWithStats) => (p.stats.bowl_wickets > 0 ? (p.stats.bowl_overs * 6) / p.stats.bowl_wickets : 0);

/** T20: economy and strike rate. ODI: average and economy. Test: average and strike rate. */
function bowlStat(ps: PlayerWithStats[], f: MatchFormat): string {
  const w = ps.filter((p) => p.stats.bowl_wickets > 0);
  if (!w.length) return ps.length ? "few wickets" : "";
  const avg = Math.round(mean(w.map((p) => p.stats.bowl_average)));
  const econ = mean(w.map((p) => p.stats.bowl_economy)).toFixed(1);
  const sr = Math.round(mean(w.map(bowlSr)));
  if (f === "T20") return `econ ${econ} · SR ${sr}`;
  if (f === "ODI") return `avg ${avg} · econ ${econ}`;
  return `avg ${avg} · SR ${sr}`;
}

/** EVEN unless one side is clearly ahead (relative gap, so it works for any scale). */
function edgeOf(u: number, a: number, rel = 0.06): Side | "EVEN" {
  const top = Math.max(Math.abs(u), Math.abs(a));
  if (top === 0 || Math.abs(u - a) / top < rel) return "EVEN";
  return u > a ? "USER" : "AI";
}

interface Unit {
  line: UnitLine;
  value: number;
}

const PITCH_NEED: Record<string, { what: "seamers" | "spinners" | "hitters"; label: string }> = {
  GREEN_SEAMER: { what: "seamers", label: "Suits the green seamer" },
  DUSTBOWL: { what: "spinners", label: "Suits the turning pitch" },
  SLOW_LOW: { what: "spinners", label: "Suits the slow pitch" },
  HIGH_SCORING_FLAT: { what: "hitters", label: "Suits the flat pitch" },
};

function units(squad: Squad, challenge: Challenge): Record<Matchup["key"], Unit> {
  const f = (challenge.format || "T20") as MatchFormat;
  const all = players(squad);
  const at = (from: number, to: number) => squad.slice(from, to).filter((p): p is PlayerWithStats => p !== null);
  const bat = (p: PlayerWithStats) => battingRaw(p, f);
  const bowl = (p: PlayerWithStats) => bowlingRaw(p, f);

  const openers = at(0, 2);
  // A makeshift opener struggles with the new ball in the match engine, so it counts here too
  const openerValue = mean(openers.map((p) => bat(p) * (isNaturalOpener(p) ? 1 : 0.85)));
  const makeshift = openers.filter((p) => !isNaturalOpener(p)).length;

  const middle = at(2, 6);
  const keeper = all.find((p) => p.primary_role === "WK");
  const ars = all.filter((p) => p.primary_role === "AR");
  const options = all.filter(isBowlingOption).sort((a, b) => bowl(b) - bowl(a));
  const pace = options.filter((p) => p.bowling_category === "PACE");
  const spin = options.filter((p) => p.bowling_category === "SPIN");
  const tail = at(6, 11);

  // Frontline, as the pitch-fit score counts them: a specialist, or an all-rounder with real wickets
  const frontline = (p: PlayerWithStats) => p.primary_role === "BOWL" || (p.primary_role === "AR" && p.stats.bowl_wickets >= (f === "TEST" ? 40 : 25));
  const hitSr = f === "T20" ? 135 : f === "ODI" ? 92 : 55;
  const need = PITCH_NEED[challenge.venue.pitch_type] ?? PITCH_NEED.HIGH_SCORING_FLAT;
  const fit =
    need.what === "seamers" ? all.filter((p) => p.bowling_category === "PACE" && frontline(p))
    : need.what === "spinners" ? all.filter((p) => p.bowling_category === "SPIN" && frontline(p))
    : all.filter((p) => p.stats.bat_strike_rate >= hitSr);
  const plural = (n: number, w: string) => `${n} ${n === 1 ? w.replace(/s$/, "") : w}`;
  // Slow and flat pitches also reward tight bowling (the pitch-fit score counts it, so show it)
  const pitch = challenge.venue.pitch_type;
  const tightEcon = pitch === "SLOW_LOW" ? (f === "T20" ? 7.2 : f === "ODI" ? 4.9 : 2.8) : f === "T20" ? 7.5 : f === "ODI" ? 5.0 : 3.0;
  const tight = all.filter((p) => p.stats.bowl_economy > 0 && p.stats.bowl_economy <= tightEcon && isBowlingOption(p)).length;
  const fitStat = plural(fit.length, need.what) + (pitch === "SLOW_LOW" || pitch === "HIGH_SCORING_FLAT" ? ` · ${tight} tight bowler${tight === 1 ? "" : "s"}` : "");

  const names = (ps: PlayerWithStats[]) => ps.map((p) => p.name);
  return {
    openers: {
      line: { names: names(openers), stat: batStat(openers, f) + (makeshift ? ` · ${makeshift === 2 ? "both" : "one"} makeshift` : "") },
      value: openerValue,
    },
    middle: { line: { names: names(middle), stat: batStat(middle, f) }, value: mean(middle.map(bat)) },
    keeper: {
      line: { names: keeper ? [keeper.name] : [], stat: keeper ? batStat([keeper], f) : "no keeper" },
      value: keeper ? bat(keeper) : 0,
    },
    allrounders: {
      line: { names: names(ars), stat: ars.length ? `${batStat(ars, f).replace(/ · SR \d+/, "")} · bowl ${bowlStat(ars, f)}` : "none" },
      // Both skills count: a genuine all-rounder lets the XI carry an extra batter or bowler
      value: sum(ars.map((p) => (battingRating(p, f) + bowlingRating(p, f)) / 2)),
    },
    // The attack is judged on the bowlers who will bowl most of the overs
    pace: { line: { names: names(pace), stat: pace.length ? bowlStat(pace.slice(0, 4), f) : "none" }, value: sum(pace.slice(0, 4).map(bowl)) },
    spin: { line: { names: names(spin), stat: spin.length ? bowlStat(spin.slice(0, 3), f) : "none" }, value: sum(spin.slice(0, 3).map(bowl)) },
    depth: { line: { names: names(tail), stat: tail.length ? `#7-#11 ${batStat(tail, f).replace(/ · SR \d+/, "")}` : "" }, value: mean(tail.map(bat)) },
    pitch: {
      line: { names: names(fit), stat: fitStat },
      value: calculateDeterministicScore(squad, challenge).pitch_suitability_score,
    },
  };
}

const LABELS: Record<Matchup["key"], string> = {
  openers: "Openers",
  middle: "Middle order",
  keeper: "Keeper",
  allrounders: "All-rounders",
  pace: "Pace attack",
  spin: "Spin attack",
  depth: "Batting depth",
  pitch: "Pitch fit",
};

/** Position by position: whose unit is better on career numbers. */
export function buildHeadToHead(userSquad: Squad, aiSquad: Squad, challenge: Challenge): HeadToHead {
  const u = units(userSquad, challenge);
  const a = units(aiSquad, challenge);
  const label = (k: Matchup["key"]) =>
    k === "pitch" ? PITCH_NEED[challenge.venue.pitch_type]?.label ?? LABELS.pitch : LABELS[k];
  const rows: Matchup[] = (Object.keys(LABELS) as Matchup["key"][]).map((k) => ({
    key: k,
    label: label(k),
    user: u[k].line,
    ai: a[k].line,
    // Pitch fit is a points score: a couple of points either way is level
    edge: k === "pitch" ? (Math.abs(u[k].value - a[k].value) < 2 ? "EVEN" : u[k].value > a[k].value ? "USER" : "AI") : edgeOf(u[k].value, a[k].value),
  }));
  const won = { USER: rows.filter((r) => r.edge === "USER").length, AI: rows.filter((r) => r.edge === "AI").length };
  return { rows, won };
}

/** "192 off 354 and 3/125 (51.0 ov)": the bigger part of the day first. */
function line(c: Contribution): string {
  const bat = c.batted ? `${c.runs}${c.notOut ? "*" : ""} off ${c.balls}` : "";
  const bowl = c.ballsBowled > 0 ? `${c.wickets}/${c.conceded} (${ballsToOvers(c.ballsBowled)} ov)` : "";
  if (!bat || !bowl) return bat || bowl || "a big day in the field";
  // Runs lead when they were the main event; a bowler's 4 off 6 is not worth mentioning
  if (c.runs >= 30 && !(c.wickets >= 3 && c.runs < 50)) return `${bat} and ${bowl}`;
  return c.runs >= 20 ? `${bowl} and ${bat}` : bowl;
}

/** Impact (runs above a typical player) needed before a performance is worth an award. */
const AWARD_MIN = 12;

/**
 * Steal of the draft (a pick from the second half that performed, either side), your best pick,
 * and your biggest regret (a player you could have had who hurt you, or an early pick of yours
 * who did nothing). Each award names a different player.
 */
export function buildDraftAwards(pickLog: PickLogEntry[] | undefined, contributions: Contribution[] | undefined): DraftAward[] {
  if (!pickLog?.length || !contributions?.length) return [];
  const impactOf = (e: PickLogEntry) => contributions.find((c) => c.team === e.by && c.playerId === e.playerId);
  const rows = pickLog.map((e) => ({ e, c: impactOf(e) })).filter((r): r is { e: PickLogEntry; c: Contribution } => !!r.c);
  const used = new Set<string>();
  const out: DraftAward[] = [];
  const take = (kind: DraftAward["kind"], title: string, r: { e: PickLogEntry; c: Contribution }, text: string) => {
    used.add(r.e.playerId);
    out.push({ kind, title, name: r.e.name, team: r.e.by, pick: r.e.n, text });
  };
  const half = Math.ceil(pickLog.length / 2);

  const steal = rows.filter((r) => r.e.n > half && r.c.impact >= AWARD_MIN).sort((a, b) => b.c.impact - a.c.impact)[0];
  if (steal) {
    const whose = steal.e.by === "USER" ? "Your" : "The AI's";
    take("steal", "Steal of the draft", steal, `${whose} pick ${steal.e.n}: ${line(steal.c)}.`);
  }

  const best = rows.filter((r) => r.e.by === "USER" && !used.has(r.e.playerId) && r.c.impact > 0).sort((a, b) => b.c.impact - a.c.impact)[0];
  if (best) take("best", "Your best pick", best, `Pick ${best.e.n}: ${line(best.c)}.`);

  // Regret: an AI player who hurt you and was still there at one of your picks
  const firstUserPick = Math.min(...pickLog.filter((e) => e.by === "USER").map((e) => e.n));
  const missed = rows
    .filter((r) => r.e.by === "AI" && r.e.n > firstUserPick && !used.has(r.e.playerId) && r.c.impact >= AWARD_MIN)
    .sort((a, b) => b.c.impact - a.c.impact)[0];
  if (missed) {
    const instead = [...pickLog].reverse().find((e) => e.by === "USER" && e.n < missed.e.n)!;
    take("regret", "Biggest regret", missed, `Still there when you took ${instead.name} at pick ${instead.n}. Went to the AI at pick ${missed.e.n}: ${line(missed.c)}.`);
  } else {
    // ...or one of your first three picks who did nothing
    const early = rows
      .filter((r) => r.e.by === "USER" && !used.has(r.e.playerId))
      .slice(0, 3)
      .sort((a, b) => a.c.impact - b.c.impact)[0];
    if (early && early.c.impact < -5) take("regret", "Biggest regret", early, `Pick ${early.e.n}, and on the day: ${line(early.c)}.`);
  }
  return out;
}

/** Replays per format: enough for a steady percentage, well inside the free plan's CPU limit. */
export const REPLAYS = 200;

/**
 * Replay the same two XIs at the same ground many times (fresh toss and luck each time), so a
 * lucky result reads as luck and a good draft gets its credit even after a loss.
 */
export function estimateWinChance(
  simulate: (seed: number) => Pick<MatchSimulationResult, "winner">,
  baseSeed: number,
  played = REPLAYS
): WinChance {
  let wins = 0, losses = 0, draws = 0;
  for (let i = 1; i <= played; i++) {
    const w = simulate((baseSeed + i * 7919) % 2147483646 || 1).winner;
    if (w === "USER") wins++;
    else if (w === "AI") losses++;
    else draws++;
  }
  return { played, wins, losses, draws };
}

export interface ReviewInput {
  userSquad: Squad;
  aiSquad: Squad;
  challenge: Challenge;
  simulation: MatchSimulationResult;
  pickLog?: PickLogEntry[];
  /** Replays the match with another seed (left out, no win chance is given). */
  replay?: (seed: number) => Pick<MatchSimulationResult, "winner">;
  seed?: number;
}

export function buildMatchReview(input: ReviewInput): MatchReview {
  return {
    headToHead: buildHeadToHead(input.userSquad, input.aiSquad, input.challenge),
    awards: buildDraftAwards(input.pickLog, input.simulation.matchFacts?.contributions),
    winChance: input.replay ? estimateWinChance(input.replay, input.seed ?? 1) : undefined,
  };
}
