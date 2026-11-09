import type { Challenge, MatchFormat, PickLogEntry, PlayerWithStats } from "./types";
import type { MatchSimulationResult } from "./simulator";
import type { Contribution } from "./impact";
import { battingRaw, bowlingRaw, battingRating, bowlingRating, playerQuality } from "./player-quality";
import { isNaturalOpener } from "./batting-order";
import { isBowlingOption } from "./validator";
import { calculateDeterministicScore } from "./scoring";
import { ballsToOvers } from "./overs";
import { eraAdjusted } from "./era";
import { hasBattingPhases, hasBowlingPhases, phaseLine, phaseShape, phaseTrust } from "./phase-stats";

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
  /** The unit as a whole, e.g. "#7-#11 avg 15" or "3 spinners"; "none" when it has nobody. */
  stat: string;
  /** Each player's own career numbers in the row's columns, e.g. "35 · 164 · 40". */
  players?: { name: string; stat: string }[];
}

export interface Matchup {
  key: "openers" | "middle" | "keeper" | "allrounders" | "pace" | "spin" | "death" | "finish" | "depth" | "pitch";
  label: string;
  /** What the per-player numbers are, e.g. "avg · SR · inns". */
  cols?: string;
  user: UnitLine;
  ai: UnitLine;
  edge: Side | "EVEN";
}

export interface HeadToHead {
  rows: Matchup[];
  /** Match-ups each side won. */
  won: Record<Side, number>;
  /**
   * The rows that move the result most in this format, from the match engine. Counting rows won says
   * nothing about who is stronger (on replayed pairs it picked the stronger side 40-49% of the time),
   * so the card shows who leads where it counts instead.
   */
  matters?: Matchup["key"][];
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

/** A pick of yours looked at in the light of what was on the board and what happened next. */
export interface DraftDecision {
  kind: "smart" | "costly";
  title: string;
  /** Pick number in the draft (1-22). */
  pick: number;
  picked: string;
  passed: string;
  text: string;
}

/** One batter across the replays: his average innings when he batted. */
export interface TypicalBatter {
  name: string;
  /** Games he batted in, out of the replays */
  bats: number;
  /** Per innings: runs and balls, how often he was out, and his best */
  runs: number;
  balls: number;
  outPct: number;
  best: number;
}
/** One bowler across the replays: his average game when he bowled. */
export interface TypicalBowler {
  name: string;
  bowls: number;
  overs: number;
  runs: number;
  wickets: number;
}
export interface TypicalSide {
  /** The side's first innings: average, and the middle 80% of games */
  avgRuns: number;
  low: number;
  high: number;
  batters: TypicalBatter[];
  bowlers: TypicalBowler[];
}
/** What a side typically does: every player's card averaged over the replays, not any one game. */
export interface TypicalScorecard {
  played: number;
  user: TypicalSide;
  ai: TypicalSide;
}

export interface MatchReview {
  headToHead: HeadToHead;
  awards: DraftAward[];
  /** Your smartest and costliest choices between players, with the reasons. */
  decisions?: DraftDecision[];
  winChance?: WinChance;
  /** The scorecard of the typical game, from the same replays as the win chance. */
  typical?: TypicalScorecard;
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


const int = (x: number) => `${Math.round(x)}`;

/** One batter's line, in COLS.bat order. */
function batLine(p: PlayerWithStats, f: MatchFormat): string {
  const s = p.stats;
  return f === "TEST" ? `${int(s.bat_average)} · ${s.bat_innings}` : `${int(s.bat_average)} · ${int(s.bat_strike_rate)} · ${s.bat_innings}`;
}

/** One bowler's line, in COLS.bowl order. */
function bowlLine(p: PlayerWithStats, f: MatchFormat): string {
  const s = p.stats;
  if (s.bowl_wickets <= 0) return `— · ${s.bowl_wickets}`;
  if (f === "T20") return `${s.bowl_economy.toFixed(1)} · ${int(bowlSr(p))} · ${s.bowl_wickets}`;
  if (f === "ODI") return `${int(s.bowl_average)} · ${s.bowl_economy.toFixed(1)} · ${s.bowl_wickets}`;
  return `${int(s.bowl_average)} · ${int(bowlSr(p))} · ${s.bowl_wickets}`;
}

/** An all-rounder: batting average, then the bowling number that matters most in the format. */
function arLine(p: PlayerWithStats, f: MatchFormat): string {
  const s = p.stats;
  const bowl = s.bowl_wickets <= 0 ? "—" : f === "T20" ? s.bowl_economy.toFixed(1) : int(s.bowl_average);
  return `${int(s.bat_average)} · ${bowl} · ${s.bowl_wickets}`;
}

const COLS: Record<MatchFormat, { bat: string; bowl: string; ar: string }> = {
  T20: { bat: "avg · SR · inns", bowl: "econ · SR · wkts", ar: "bat avg · econ · wkts" },
  ODI: { bat: "avg · SR · inns", bowl: "avg · econ · wkts", ar: "bat avg · bowl avg · wkts" },
  TEST: { bat: "avg · inns", bowl: "avg · SR · wkts", ar: "bat avg · bowl avg · wkts" },
};

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

/**
 * T20 and ODI: the two best death bowlers and the two best finishers (from #4-#8), judged on what they did in overs
 * 16-20 (their level, adjusted for when they played, times how much better or worse they are at the
 * death, pulled towards normal for small samples). Shown with their raw death numbers and balls.
 */
function deathUnits(all: PlayerWithStats[], squad: Squad, f: MatchFormat): { death: Unit; finish: Unit } {
  const deathEcon = (p: PlayerWithStats) => eraAdjusted(p, f).stats.bowl_economy * phaseShape(p, f, "death").econ;
  const deathSr = (p: PlayerWithStats) => eraAdjusted(p, f).stats.bat_strike_rate * phaseShape(p, f, "death").sr;
  // The two best proven death bowlers (as the captain picks them in the match engine); if fewer than
  // two are proven, whoever has bowled most at the death makes up the pair
  const options = all.filter((p) => isBowlingOption(p) && hasBowlingPhases(p, f) && p.stats.bowl_economy > 0);
  const proven = options.filter((p) => phaseTrust(p, f, "death") >= 1).sort((a, b) => deathEcon(a) - deathEcon(b));
  const rest = options.filter((p) => !proven.includes(p)).sort((a, b) => phaseLine(b, "death").bowlBalls - phaseLine(a, "death").bowlBalls);
  const bowlers = [...proven, ...rest].slice(0, 2);
  // Finishers: whoever bats #4-#8, the batters actually in at the death (openers rarely are)
  const hitters = squad
    .slice(3, 8)
    .filter((p): p is PlayerWithStats => !!p && p.primary_role !== "BOWL" && hasBattingPhases(p, f))
    .sort((a, b) => deathSr(b) - deathSr(a))
    .slice(0, 2);
  const show = (p: PlayerWithStats, kind: "econ" | "sr") => {
    const l = phaseLine(p, "death");
    const v = kind === "econ" ? l.econ : l.sr;
    const n = kind === "econ" ? l.bowlBalls : l.batBalls;
    return { name: p.name, stat: v === undefined ? `— · 0` : `${kind === "econ" ? v.toFixed(1) : Math.round(v)} · ${n}` };
  };
  return {
    // Lower is better for economy: the value is turned round so that higher always wins
    death: { line: { names: bowlers.map((p) => p.name), stat: bowlers.length ? "" : "nobody proven", players: bowlers.map((p) => show(p, "econ")) }, value: bowlers.length ? 100 / mean(bowlers.map(deathEcon)) : 0 },
    finish: { line: { names: hitters.map((p) => p.name), stat: hitters.length ? "" : "nobody proven", players: hitters.map((p) => show(p, "sr")) }, value: hitters.length ? mean(hitters.map(deathSr)) : 0 },
  };
}

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
  const each = (ps: PlayerWithStats[], line: (p: PlayerWithStats, f: MatchFormat) => string) => ps.map((p) => ({ name: p.name, stat: line(p, f) }));
  return {
    openers: {
      line: { names: names(openers), stat: makeshift ? `${makeshift === 2 ? "both" : "one"} makeshift` : "", players: each(openers, batLine) },
      value: openerValue,
    },
    middle: { line: { names: names(middle), stat: "", players: each(middle, batLine) }, value: mean(middle.map(bat)) },
    keeper: {
      line: { names: keeper ? [keeper.name] : [], stat: keeper ? "" : "no keeper", players: keeper ? each([keeper], batLine) : [] },
      value: keeper ? bat(keeper) : 0,
    },
    allrounders: {
      line: { names: names(ars), stat: ars.length ? "" : "none", players: each(ars, arLine) },
      // Both skills count: a genuine all-rounder lets the XI carry an extra batter or bowler
      value: sum(ars.map((p) => (battingRating(p, f) + bowlingRating(p, f)) / 2)),
    },
    // The attack is judged on the bowlers who will bowl most of the overs
    pace: { line: { names: names(pace), stat: pace.length ? "" : "none", players: each(pace, bowlLine) }, value: sum(pace.slice(0, 4).map(bowl)) },
    spin: { line: { names: names(spin), stat: spin.length ? "" : "none", players: each(spin, bowlLine) }, value: sum(spin.slice(0, 3).map(bowl)) },
    ...(f !== "TEST" ? deathUnits(all, squad, f) : { death: EMPTY_UNIT, finish: EMPTY_UNIT }),
    depth: { line: { names: names(tail), stat: tail.length ? `#7-#11 ${batStat(tail, f).replace(/ · SR \d+/, "")}` : "" }, value: mean(tail.map(bat)) },
    pitch: {
      line: { names: names(fit), stat: fitStat },
      value: calculateDeterministicScore(squad, challenge).pitch_suitability_score,
    },
  };
}

const EMPTY_UNIT: Unit = { line: { names: [], stat: "" }, value: 0 };

const LABELS: Record<Matchup["key"], string> = {
  openers: "Openers",
  middle: "Middle order",
  keeper: "Keeper",
  allrounders: "All-rounders",
  pace: "Pace attack",
  spin: "Spin attack",
  death: "Death bowling",
  finish: "Finishers",
  depth: "Batting depth",
  pitch: "Pitch fit",
};

/**
 * How much each unit's edge moves the result, per format: fitted on drafted pairs replayed in the
 * match engine (tests/h2h-calibration.test.ts). Applied to the relative difference between the sides.
 */
export const ROW_WEIGHTS: Record<MatchFormat, Partial<Record<Matchup["key"], number>>> = {
  T20: { openers: -0.028, middle: 0.011, keeper: -0.006, allrounders: -0.001, pace: -0.015, spin: -0.012, death: 0.042, finish: 0.058, depth: 0.007, pitch: 0.053 },
  ODI: { openers: 0.056, middle: 0.058, keeper: 0.071, allrounders: 0.006, pace: -0.034, spin: -0.023, death: 0.058, finish: 0.203, depth: -0.097, pitch: 0.143 },
  TEST: { openers: -0.025, middle: 0.52, keeper: -0.114, allrounders: -0.018, pace: 0.043, spin: -0.046, depth: 0.28, pitch: 0.12 },
};

/** The rows that count most in a format: those with at least 40% of the biggest weight (at most three). */
export function rowsThatMatter(f: MatchFormat): Matchup["key"][] {
  const w = Object.entries(ROW_WEIGHTS[f]).filter(([, v]) => (v ?? 0) > 0) as [Matchup["key"], number][];
  const top = Math.max(0, ...w.map(([, v]) => v));
  return w.filter(([, v]) => v >= 0.4 * top).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
}

/** One unit's relative difference between the sides (user minus AI, over their average), within +-1. */
export const relDiff = (u: number, a: number) => {
  const m = (Math.abs(u) + Math.abs(a)) / 2;
  return m === 0 ? 0 : Math.max(-1, Math.min(1, (u - a) / m));
};

/** The relative difference of every unit, for fitting ROW_WEIGHTS. */
export function unitDiffs(userSquad: Squad, aiSquad: Squad, challenge: Challenge): Partial<Record<Matchup["key"], number>> {
  const u = units(userSquad, challenge), a = units(aiSquad, challenge);
  const f = (challenge.format || "T20") as MatchFormat;
  const out: Partial<Record<Matchup["key"], number>> = {};
  for (const k of Object.keys(LABELS) as Matchup["key"][]) {
    if (f === "TEST" && (k === "death" || k === "finish")) continue;
    out[k] = relDiff(u[k].value, a[k].value);
  }
  return out;
}

/** Position by position: whose unit is better on career numbers. */
export function buildHeadToHead(userSquad: Squad, aiSquad: Squad, challenge: Challenge): HeadToHead {
  const u = units(userSquad, challenge);
  const a = units(aiSquad, challenge);
  const label = (k: Matchup["key"]) =>
    k === "pitch" ? PITCH_NEED[challenge.venue.pitch_type]?.label ?? LABELS.pitch : LABELS[k];
  const f = (challenge.format || "T20") as MatchFormat;
  const cols: Partial<Record<Matchup["key"], string>> = {
    openers: COLS[f].bat, middle: COLS[f].bat, keeper: COLS[f].bat, allrounders: COLS[f].ar, pace: COLS[f].bowl, spin: COLS[f].bowl,
    death: `econ in overs ${f === "ODI" ? "41-50" : "16-20"} · balls`, finish: `SR in overs ${f === "ODI" ? "41-50" : "16-20"} · balls`,
  };
  // Death bowling and finishers come from phase stats (T20 and ODI)
  const keys = (Object.keys(LABELS) as Matchup["key"][]).filter((k) => f !== "TEST" || (k !== "death" && k !== "finish"));
  const rows: Matchup[] = keys.map((k) => ({
    key: k,
    label: label(k),
    ...(cols[k] ? { cols: cols[k] } : {}),
    user: u[k].line,
    ai: a[k].line,
    // Pitch fit is a points score: a couple of points either way is level
    edge: k === "pitch" ? (Math.abs(u[k].value - a[k].value) < 2 ? "EVEN" : u[k].value > a[k].value ? "USER" : "AI") : edgeOf(u[k].value, a[k].value),
  }));
  const won = { USER: rows.filter((r) => r.edge === "USER").length, AI: rows.filter((r) => r.edge === "AI").length };
  return { rows, won, matters: rowsThatMatter(f).filter((k) => keys.includes(k)) };
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

type Kind = "keeper" | "batter" | "all-rounder" | "seamer" | "spinner" | "bowler";
const kindOf = (p: PlayerWithStats): Kind =>
  p.primary_role === "WK" ? "keeper" : p.primary_role === "BAT" ? "batter" : p.primary_role === "AR" ? "all-rounder" : p.bowling_category === "PACE" ? "seamer" : p.bowling_category === "SPIN" ? "spinner" : "bowler";
const PLURAL: Record<Kind, string> = { keeper: "keepers", batter: "batters", "all-rounder": "all-rounders", seamer: "seamers", spinner: "spinners", bowler: "bowlers" };

/** Players this close in quality are "of a level": one can stand in for the other. */
const TIER = 8;

const list = (ps: PlayerWithStats[]) => (ps.length === 2 ? `${ps[0].name} and ${ps[1].name}` : ps.map((p) => p.name).join(", "));

/**
 * Your key decisions, read off the draft itself: at each of your picks, who was on the board (the
 * pick log and the full pool replay it), and what happened afterwards.
 *
 *  - Smart: you took a player of a kind that was running out (the best keeper left, with a big drop
 *    to the next) ahead of a bigger name of a kind that was easy to replace (his equals were still
 *    there, or you got one later).
 *  - Costly: you took a player of a plentiful kind ahead of the last good one of another kind, who
 *    then went to the AI.
 *
 * Kinds are keeper, batter, all-rounder, seamer, spinner. Quality is the stats-only rating the AI
 * uses; it is never shown, only the reasoning.
 */
export function buildDraftDecisions(
  pickLog: PickLogEntry[] | undefined,
  draftPool: PlayerWithStats[] | undefined,
  quality: (p: PlayerWithStats) => number
): DraftDecision[] {
  if (!pickLog?.length || !draftPool?.length) return [];
  const byId = new Map(draftPool.map((p) => [p.id, p]));
  const taken = new Set<string>();
  const near = (x: PlayerWithStats, ref: PlayerWithStats) => kindOf(x) === kindOf(ref) && quality(x) >= quality(ref) - TIER;
  const mine = pickLog.filter((e) => e.by === "USER");
  const found: (DraftDecision & { score: number })[] = [];

  for (const e of pickLog) {
    const avail = draftPool.filter((p) => !taken.has(p.id));
    taken.add(e.playerId);
    const P = byId.get(e.playerId);
    if (e.by !== "USER" || !P) continue;
    const others = avail.filter((p) => p.id !== P.id);
    const B = others.reduce<PlayerWithStats | undefined>((best, p) => (!best || quality(p) > quality(best) ? p : best), undefined);
    // Only a choice between a lesser name and a bigger one of another kind is a decision
    if (!B || quality(B) < quality(P) + 3 || kindOf(B) === kindOf(P)) continue;
    const gP = kindOf(P), gB = kindOf(B);

    const equalsOfB = others.filter((x) => x.id !== B.id && near(x, B));
    const equalsOfP = others.filter((x) => near(x, P));
    const nextP = others.filter((x) => kindOf(x) === gP).sort((a, b) => quality(b) - quality(a))[0];
    const gap = nextP ? quality(P) - quality(nextP) : Infinity;
    const gotLater = mine.filter((u) => u.n > e.n).map((u) => ({ n: u.n, p: byId.get(u.playerId)! })).find((u) => u.p && near(u.p, B));
    const aiTook = pickLog.find((x) => x.by === "AI" && x.playerId === B.id && x.n > e.n);

    if (gap >= TIER && (gotLater || equalsOfB.length >= 2)) {
      const hadKeeper = mine.filter((u) => u.n < e.n).some((u) => byId.get(u.playerId)?.primary_role === "WK");
      const why =
        `${P.name} was the best ${gP} left` +
        (nextP ? (gap >= 15 ? `, with a big drop to the next (${nextP.name}).` : `, a clear step up on the next (${nextP.name}).`) : ", and the last one of any standard.") +
        (gP === "keeper" && !hadKeeper ? " You had no keeper yet." : "");
      // The star himself may have lasted to your next pick: you got both
      const alt = gotLater
        ? gotLater.p.id === B.id
          ? ` ${B.name} looked bigger, but he was still there at pick ${gotLater.n}, and you took him then: you got both.`
          : ` ${B.name} looked bigger, but ${gotLater.p.name}, almost his equal, was still there, and you took him at pick ${gotLater.n}.`
        : ` ${B.name} could be replaced: ${list(equalsOfB.slice(0, 2))} ${equalsOfB.length > 1 ? "were" : "was"} still on the board.`;
      found.push({ kind: "smart", title: `${P.name} over ${B.name}`, pick: e.n, picked: P.name, passed: B.name, text: why + alt, score: Math.min(gap, 30) + (gotLater ? 10 : 0) + equalsOfB.length });
    } else if (aiTook && !gotLater && equalsOfP.length >= 2 && equalsOfB.length <= 1) {
      const last = equalsOfB.length === 0 ? `the last ${gB} of his class` : `one of the last two ${PLURAL[gB]} of his class`;
      found.push({
        kind: "costly",
        title: `${P.name} over ${B.name}`,
        pick: e.n,
        picked: P.name,
        passed: B.name,
        text: `${list(equalsOfP.slice(0, 2))} ${equalsOfP.length > 1 ? "were" : "was"} of ${P.name}'s level and still there, but ${B.name} was ${last}, and went to the AI at pick ${aiTook.n}.`,
        score: equalsOfP.length + 10,
      });
    }
  }
  // One lesson per player passed over: the strongest case for each (the earliest pick on a tie)
  const top = (kind: DraftDecision["kind"], n: number) => {
    const seen = new Set<string>();
    return found
      .filter((d) => d.kind === kind)
      .sort((a, b) => b.score - a.score || a.pick - b.pick)
      .filter((d) => !seen.has(d.passed) && !!seen.add(d.passed))
      .slice(0, n);
  };
  return [...top("smart", 3), ...top("costly", 2)].map(({ score: _s, ...d }) => d);
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
  return replayMatch(simulate, baseSeed, played).winChance;
}

const oversToBalls = (o: string | number) => {
  const [w, f] = String(o).split(".");
  return Number(w) * 6 + Number(f ?? 0);
};

/**
 * Replays the match, and (when the replays carry scorecards) averages every player's card at the
 * same time: one set of simulations gives both the win chance and the typical scorecard.
 */
export function replayMatch(
  simulate: (seed: number) => Pick<MatchSimulationResult, "winner"> & Partial<MatchSimulationResult>,
  baseSeed: number,
  played = REPLAYS,
  /** The XIs in batting order, so the typical scorecard lists players in that order */
  squads: { user: Squad; ai: Squad } = { user: [], ai: [] }
): { winChance: WinChance; typical?: TypicalScorecard } {
  let wins = 0, losses = 0, draws = 0;
  type Bat = { games: number; innings: number; runs: number; balls: number; outs: number; best: number };
  type Bowl = { games: number; balls: number; runs: number; wkts: number };
  const acc = { USER: { bat: new Map<string, Bat>(), bowl: new Map<string, Bowl>(), first: [] as number[] }, AI: { bat: new Map<string, Bat>(), bowl: new Map<string, Bowl>(), first: [] as number[] } };
  let cards = false;
  for (let i = 1; i <= played; i++) {
    const r = simulate((baseSeed + i * 7919) % 2147483646 || 1);
    if (r.winner === "USER") wins++;
    else if (r.winner === "AI") losses++;
    else draws++;
    if (!r.userInnings || !r.aiInnings) continue;
    cards = true;
    acc.USER.first.push(r.userInnings.totalRuns);
    acc.AI.first.push(r.aiInnings.totalRuns);
    // Per game: a player's innings and spells are summed over the match (Tests have two innings each)
    const game = { USER: { bat: new Map<string, Bat>(), bowl: new Map<string, Bowl>() }, AI: { bat: new Map<string, Bat>(), bowl: new Map<string, Bowl>() } };
    const sides: [("USER" | "AI"), (typeof r.userInnings)[]][] = [
      ["USER", [r.userInnings, r.userSecondInnings].filter((x): x is NonNullable<typeof x> => !!x && x.totalBalls > 0)],
      ["AI", [r.aiInnings, r.aiSecondInnings].filter((x): x is NonNullable<typeof x> => !!x && x.totalBalls > 0)],
    ];
    for (const [side, inns] of sides) {
      const other = side === "USER" ? "AI" : "USER";
      for (const inn of inns) {
        for (const b of inn.batters) {
          if (!b.balls && !b.isOut) continue;
          const g = game[side].bat.get(b.name) ?? { games: 1, innings: 0, runs: 0, balls: 0, outs: 0, best: 0 };
          g.innings++; g.runs += b.runs; g.balls += b.balls; g.outs += b.isOut ? 1 : 0; g.best = Math.max(g.best, b.runs);
          game[side].bat.set(b.name, g);
        }
        // The bowlers on a side's batting card belong to the other side
        for (const b of inn.bowlers) {
          const g = game[other].bowl.get(b.name) ?? { games: 1, balls: 0, runs: 0, wkts: 0 };
          g.balls += oversToBalls(b.overs); g.runs += b.runs; g.wkts += b.wickets;
          game[other].bowl.set(b.name, g);
        }
      }
    }
    for (const side of ["USER", "AI"] as const) {
      for (const [name, g] of game[side].bat) {
        const t = acc[side].bat.get(name) ?? { games: 0, innings: 0, runs: 0, balls: 0, outs: 0, best: 0 };
        t.games++; t.innings += g.innings; t.runs += g.runs; t.balls += g.balls; t.outs += g.outs; t.best = Math.max(t.best, g.best);
        acc[side].bat.set(name, t);
      }
      for (const [name, g] of game[side].bowl) {
        const t = acc[side].bowl.get(name) ?? { games: 0, balls: 0, runs: 0, wkts: 0 };
        t.games++; t.balls += g.balls; t.runs += g.runs; t.wkts += g.wkts;
        acc[side].bowl.set(name, t);
      }
    }
  }
  const winChance = { played, wins, losses, draws };
  if (!cards) return { winChance };
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
  const side = (s: "USER" | "AI", squad: Squad): TypicalSide => {
    const order = new Map(squad.map((p, i) => [p?.name ?? "", i]));
    const rank = (n: string) => order.get(n) ?? 99;
    return {
      avgRuns: Math.round(mean(acc[s].first)),
      low: pct(acc[s].first, 0.1),
      high: pct(acc[s].first, 0.9),
      batters: [...acc[s].bat].sort((a, b) => rank(a[0]) - rank(b[0])).map(([name, t]) => ({ name, bats: t.games, runs: r1(t.runs / t.innings), balls: r1(t.balls / t.innings), outPct: Math.round((t.outs / t.innings) * 100), best: t.best })),
      bowlers: [...acc[s].bowl].filter(([, t]) => t.balls > 0).sort((a, b) => b[1].wkts / b[1].games - a[1].wkts / a[1].games).map(([name, t]) => ({ name, bowls: t.games, overs: r1(t.balls / t.games / 6), runs: r1(t.runs / t.games), wickets: Math.round((t.wkts / t.games) * 100) / 100 })),
    };
  };
  return { winChance, typical: { played, user: side("USER", squads.user), ai: side("AI", squads.ai) } };
}

export interface ReviewInput {
  userSquad: Squad;
  aiSquad: Squad;
  challenge: Challenge;
  simulation: MatchSimulationResult;
  pickLog?: PickLogEntry[];
  /** Everyone who was available when the draft began (needed for the key decisions). */
  draftPool?: PlayerWithStats[];
  /** Replays the match with another seed (left out, no win chance is given). */
  replay?: (seed: number) => Pick<MatchSimulationResult, "winner"> & Partial<MatchSimulationResult>;
  seed?: number;
}

export function buildMatchReview(input: ReviewInput): MatchReview {
  // One set of replays gives the win chance and the typical scorecard
  const replayed = input.replay ? replayMatch(input.replay, input.seed ?? 1, REPLAYS, { user: input.userSquad, ai: input.aiSquad }) : undefined;
  return {
    headToHead: buildHeadToHead(input.userSquad, input.aiSquad, input.challenge),
    awards: buildDraftAwards(input.pickLog, input.simulation.matchFacts?.contributions),
    ...(input.draftPool ? { decisions: buildDraftDecisions(input.pickLog, input.draftPool, (p) => playerQuality(p, input.challenge.format || "T20")) } : {}),
    winChance: replayed?.winChance,
    ...(replayed?.typical ? { typical: replayed.typical } : {}),
  };
}
