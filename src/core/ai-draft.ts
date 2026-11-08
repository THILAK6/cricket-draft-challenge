import type { Challenge, MatchFormat, PlayerWithStats } from "./types";
import { canPickPlayer, isOpenerCapable, isTailCapable, rulesFor, type Need, type PickContext } from "./validator";
import { isCutter } from "./scoring";
import { playerQuality } from "./player-quality";
import { isNaturalOpener } from "./batting-order";
import { PERSONA_INFO } from "./personas";

/**
 * The AI opponent drafts the way a friend would at school:
 * - early on it takes the best player left (stars go first);
 * - as the XI fills up it balances the side (a keeper, openers, enough bowling, the right attack
 *   for the pitch) and stops stacking one role;
 * - late on it fills whatever the rules still need;
 * - it only takes a player to keep him from you when that kind of player is about to run out.
 *
 * Three personalities replace a pure difficulty dial. Values are on the rating scale (about
 * 30 for a fringe international, 95+ for the best), so every bonus reads as "rating points".
 */
export type Difficulty = "easy" | "normal" | "hard";
type Squad = (PlayerWithStats | null)[];

export interface Persona {
  name: string;
  blurb: string;
  /** Weight on keeping scarce players from you. */
  denial: number;
  /** Rating points for every 10 caps (famous names), up to +15. */
  fame: number;
  /** Rating points for players from its favourite country. */
  home: number;
  /** Size of its misjudgements, in rating points (seeded per match). */
  noise: number;
  /** How much it cares about the XI's needs and balance. */
  balance: number;
  /** How much it plays to the pitch. */
  pitch: number;
}

export const PERSONAS: Record<Difficulty, Persona> = {
  easy: { ...PERSONA_INFO.easy, denial: 0, fame: 1, home: 10, noise: 9, balance: 0.6, pitch: 0.4 },
  normal: { ...PERSONA_INFO.normal, denial: 0.5, fame: 0, home: 0, noise: 0, balance: 1, pitch: 1 },
  hard: { ...PERSONA_INFO.hard, denial: 1.2, fame: 0, home: 0, noise: 0, balance: 1, pitch: 1.2 },
};

export interface AiPickInput {
  /** Players still available to both sides. */
  pool: PlayerWithStats[];
  /** The AI's own squad (11 slots, null = empty). */
  squad: Squad;
  /** The human's squad. */
  opponentSquad: Squad;
  challenge: Challenge;
  difficulty: Difficulty;
  /** Per-match seed (e.g. from the room id): the Fanboy's misjudgements differ between matches but replay identically. */
  noiseSeed: number;
  /** Pick number within the match, so noise changes pick to pick. */
  round: number;
}

export interface AiPickResult {
  player: PlayerWithStats;
  slotIndex: number;
  reason: string;
  /** True only when no legal pick existed and the best player left was taken anyway. */
  fallback: boolean;
  /** The pick's own value to the AI's XI (rating points). */
  ownGain: number;
  /** Rating points the pick earned for keeping a scarce player from the human. */
  denial: number;
  /**
   * The pick and the others nearly as good (best first, at most SHORTLIST_SIZE), each with its own
   * reason: a voice model may choose between them in character without ever making a bad pick.
   */
  shortlist: { player: PlayerWithStats; reason: string }[];
}

/** How close (in rating points) an option must be to the best pick to make the shortlist. */
export const SHORTLIST_MARGIN = 6;
export const SHORTLIST_SIZE = 4;

/** Hard slot eligibility (kept for the simulation harness): what a player may never be asked to do. */
export function slotEligible(p: PlayerWithStats, slot: number, strict = true): boolean {
  const bowler = p.primary_role === "BOWL";
  if (slot <= 1) return isOpenerCapable(p) && !bowler && (!strict || p.stats.finisher_innings < 4);
  if (slot <= 4) return !bowler;
  if (slot >= 8) return isTailCapable(p);
  return true;
}

const hash = (...xs: (string | number)[]): number => {
  let h = 2166136261;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 0x9e37, 2654435761);
  }
  return (h >>> 0) / 4294967296;
};

/** A sensible XI shape per format, used for diminishing returns (the 4th all-rounder is worth less). */
const SHAPE: Record<MatchFormat, { BAT: number; WK: number; AR: number; BOWL: number }> = {
  T20: { BAT: 4, WK: 1, AR: 3, BOWL: 3 },
  ODI: { BAT: 5, WK: 1, AR: 2, BOWL: 3 },
  TEST: { BAT: 5, WK: 1, AR: 1, BOWL: 4 },
};

const frontline = (p: PlayerWithStats) => p.primary_role === "BOWL" || p.primary_role === "AR";
const isPace = (p: PlayerWithStats) => frontline(p) && p.bowling_category === "PACE";
const isSpin = (p: PlayerWithStats) => frontline(p) && p.bowling_category === "SPIN";

/** Role bucket for balance: a second keeper is just another batter. */
function bucket(p: PlayerWithStats, mine: PlayerWithStats[]): "BAT" | "WK" | "AR" | "BOWL" {
  if (p.primary_role === "WK") return mine.some((q) => q.primary_role === "WK" && q.id !== p.id) ? "BAT" : "WK";
  return p.primary_role;
}

const NEED_WORDS: Record<string, [string, string]> = {
  WK: ["a keeper", "keeper"],
  BOWL: ["another bowling option", "bowler"],
  PACE: ["more pace", "seamer"],
  SPIN: ["a spinner", "spinner"],
  AR: ["an all-rounder", "all-rounder"],
};

const PITCH_WORDS: Record<string, string> = {
  GREEN_SEAMER: "a green seamer",
  DUSTBOWL: "a turner",
  SLOW_LOW: "a slow, low pitch",
  HIGH_SCORING_FLAT: "a flat deck",
};

interface Scored {
  p: PlayerWithStats;
  total: number;
  quality: number;
  pitch: number;
  need: number;
  needKey?: string;
  balance: number;
  denial: number;
  denialKey?: string;
  fame: number;
  home: number;
}

export function chooseAiPick(input: AiPickInput): AiPickResult | null {
  const { pool, squad, opponentSquad, challenge, difficulty } = input;
  if (pool.length === 0) return null;
  const slotIndex = squad.findIndex((p) => !p);
  if (slotIndex === -1) return null;
  const format = (challenge.format || "T20") as MatchFormat;
  const persona = PERSONAS[difficulty] ?? PERSONAS.normal;
  const mine = squad.filter((p): p is PlayerWithStats => !!p);
  const theirs = opponentSquad.filter((p): p is PlayerWithStats => !!p);
  const ctx: PickContext = { pool, opponentSquad };
  const left = 11 - mine.length;
  const stage = mine.length / 11; // 0 at the first pick, ~0.9 at the last

  const legal = pool.filter((p) => canPickPlayer(p, squad, challenge, undefined, ctx).allowed);
  if (legal.length === 0) {
    // No legal pick at all (the draft room allows any player then): take the best one left
    const best = [...pool].sort((a, b) => playerQuality(b, format) - playerQuality(a, format))[0];
    const reason = `${best.name} was the best player left.`;
    return { player: best, slotIndex, reason, fallback: true, ownGain: 0, denial: 0, shortlist: [{ player: best, reason }] };
  }

  // What my XI still needs, and how urgent it is
  const myNeeds = rulesFor(challenge, mine, pool);
  const open = (needs: Need[], xi: PlayerWithStats[]) => needs.map((n) => ({ n, count: Math.max(0, n.required - xi.filter(n.matches).length) })).filter((x) => x.count > 0);
  const myOpen = open(myNeeds, mine);
  // Same count as the pick rules: pace and spin are different players, bowling options can overlap with them
  const of = (key: string) => myOpen.find((x) => x.n.key === key)?.count ?? 0;
  const demand = of("WK") + Math.max(of("BOWL"), of("PACE") + of("SPIN"), of("AR"));
  const urgency = Math.min(1, demand / Math.max(1, left));
  const openers = mine.filter(isNaturalOpener).length;

  // What the human still needs, for scarcity sniping
  const theirOpen = persona.denial > 0 ? open(rulesFor(challenge, theirs, pool), theirs) : [];
  const theirLeft = 11 - theirs.length;

  const shape = SHAPE[format];
  const counts = { BAT: 0, WK: 0, AR: 0, BOWL: 0 };
  for (const q of mine) counts[bucket(q, mine)]++;
  const pace = mine.filter(isPace).length;
  const spin = mine.filter(isSpin).length;
  const pitchType = challenge.venue.pitch_type;
  const fav = favouriteCountry(input, pool);

  const scored: Scored[] = legal.map((p) => {
    const quality = playerQuality(p, format);

    // Play to the conditions
    let pitch = 0;
    if (pitchType === "GREEN_SEAMER") {
      if (isPace(p)) pitch += pace < 3 ? 8 : 2;
      if (isSpin(p) && spin >= 1) pitch -= 6;
    } else if (pitchType === "DUSTBOWL") {
      if (isSpin(p)) pitch += spin < 3 ? 8 : 2;
      if (isPace(p) && pace >= 2) pitch -= 6;
    } else if (pitchType === "SLOW_LOW") {
      if (isSpin(p) && spin < 2) pitch += 6;
      if (isCutter(p) && frontline(p)) pitch += 4;
    } else if (format !== "TEST" && p.primary_role !== "BOWL" && p.stats.bat_strike_rate >= (format === "T20" ? 140 : 95)) {
      pitch += 4;
    }
    pitch *= persona.pitch;

    // Fill what the rules still need: little early, a lot late
    let need = 0;
    let needKey: string | undefined;
    for (const { n } of myOpen) {
      if (!n.matches(p)) continue;
      const v = 45 * urgency ** 3;
      if (v > need) {
        need = v;
        needKey = n.key;
      }
    }
    // Two proper openers: a makeshift opener struggles against the new ball (most in Tests). Matters
    // more as the XI takes shape
    if (openers < 2 && isNaturalOpener(p) && stage >= 0.25) {
      const v = (format === "TEST" ? 12 : 8) + 10 * stage;
      if (v > need) {
        need = v;
        needKey = "OPEN";
      }
    }
    need *= persona.balance;

    // Diminishing returns: the shape of a real XI
    const b = bucket(p, mine);
    const over = counts[b] + 1 - shape[b];
    let balance = over > 0 ? -12 * over : 0;
    if (b === "WK" && counts.WK === 0 && left <= 4) balance += 10; // the gloves, before it's too late
    // Test sides win with their best players (twenty wickets): shape matters less there
    balance *= persona.balance * (0.3 + 0.7 * stage) * (format === "TEST" ? 0.4 : 1);

    // Keep a scarce player from the human
    let denial = 0;
    let denialKey: string | undefined;
    for (const { n, count } of theirOpen) {
      if (!n.matches(p) || count > theirLeft) continue;
      // Scarce: after this pick there are hardly any good ones of this type left for them.
      // The Shark reacts one player earlier than the Captain.
      const good = pool.filter((q) => q.id !== p.id && n.matches(q) && playerQuality(q, format) >= 55);
      if (good.length > count + (persona.denial >= 1 ? 1 : 0)) continue;
      // Worth more the bigger the drop to the best one they could still get
      const nextBest = good.reduce((m, q) => Math.max(m, playerQuality(q, format)), 30);
      const v = persona.denial * (8 + 0.5 * Math.max(0, quality - nextBest));
      if (v > denial) {
        denial = v;
        denialKey = n.key;
      }
    }

    const fame = persona.fame ? Math.min(15, (p.stats.matches / 10) * persona.fame) : 0;
    const home = persona.home && p.country === fav ? persona.home : 0;
    const noise = persona.noise ? (hash(input.noiseSeed, input.round, p.id) - 0.5) * 2 * persona.noise : 0;
    const total = quality + pitch + need + balance + denial + fame + home + noise;
    return { p, total, quality, pitch, need, needKey, balance, denial, denialKey, fame, home };
  });

  scored.sort((a, b) => b.total - a.total || b.quality - a.quality || a.p.id.localeCompare(b.p.id));
  const best = scored[0];
  // A shortlisted alternative wasn't the AI's own first choice, so its reason only says what he does for the side
  const why = (x: Scored) => explain(x, scored, { format, pitch: pitchType, mine, persona, difficulty, seed: input.noiseSeed + input.round, fav }, x !== best);
  const reason = why(best);
  const shortlist = [
    { player: best.p, reason },
    ...scored
      .slice(1)
      .filter((x) => x.total >= best.total - SHORTLIST_MARGIN)
      .slice(0, SHORTLIST_SIZE - 1)
      .map((x) => ({ player: x.p, reason: why(x) })),
  ];
  return {
    player: best.p,
    slotIndex,
    reason,
    fallback: false,
    ownGain: best.total - best.denial,
    denial: best.denial,
    shortlist,
  };
}

/** The Fanboy's favourite country: the host nation when it's in the pool, otherwise a seeded pick. */
function favouriteCountry(input: AiPickInput, pool: PlayerWithStats[]): string {
  const host = input.challenge.venue.country;
  const all = [...pool, ...input.squad.filter((p): p is PlayerWithStats => !!p)];
  const countries = [...new Set(all.map((p) => p.country))].sort();
  if (countries.includes(host)) return host;
  return countries[Math.floor(hash(input.noiseSeed, "fav") * countries.length)] ?? host;
}

const COUNTRY_WORD: Record<string, string> = {
  AUS: "an Australian", ENG: "an English", IND: "an Indian", PAK: "a Pakistani", RSA: "a South African", NZL: "a Kiwi",
  WI: "a West Indian", SL: "a Sri Lankan", BAN: "a Bangladeshi", ZIM: "a Zimbabwean", IRE: "an Irish", AFG: "an Afghan",
};

/**
 * The pick's main reason, in a sentence a friend would say. A factor is only named when it decided
 * the pick (without it, the runner-up would have been taken); otherwise the reason is the player.
 */
function explain(
  s: Scored,
  all: Scored[],
  c: { format: MatchFormat; pitch: string; mine: PlayerWithStats[]; persona: Persona; difficulty: Difficulty; seed: number; fav: string },
  roleOnly = false
): string {
  const name = s.p.name;
  const vary = <T,>(xs: T[]) => xs[Math.floor(hash(c.seed, name) * xs.length)];
  if (roleOnly) return forTheSide(s.p, c.mine, vary);
  const runner = all.find((x) => x !== s);
  const margin = runner ? s.total - runner.total : Infinity;
  // A factor decided the pick when it gave this player more than the runner-up by at least the winning margin
  const decided = (key: "denial" | "home" | "fame" | "need" | "pitch") => s[key] > 0 && s[key] - (runner?.[key] ?? 0) >= margin;

  const early = c.mine.length <= 2;
  if (s.denial > 0 && s.denialKey && decided("denial")) {
    const [what, word] = NEED_WORDS[s.denialKey] ?? ["that", "player"];
    return vary([
      `You still need ${what}, and ${name} was one of the last good ones left. Sorry.`,
      `Took ${name} before you could: there aren't many good ${word}s left and you still need one.`,
    ]);
  }
  if (decided("home")) return vary([`Had to have ${name}. Can't leave out ${COUNTRY_WORD[c.fav] ?? "a home"} hero.`, `${name}! Always wanted him in my side.`]);
  if (decided("fame")) return vary([`${name}, a big name. Couldn't resist.`, `Everyone knows ${name}. He's in.`]);
  if (s.needKey && decided("need") && !early) {
    if (s.needKey === "OPEN") return `Needed a proper opener, and ${name} was the best one left.`;
    const [what] = NEED_WORDS[s.needKey] ?? ["him"];
    return vary([`Needed ${what}, and ${name} was the best one left.`, `${name} fills the gap: I still needed ${what}.`]);
  }
  if (decided("pitch") && !early) {
    return vary([`${name} on ${PITCH_WORDS[c.pitch] ?? "this pitch"}: exactly what this ground wants.`, `These conditions are made for ${name}.`]);
  }
  const top = all.reduce((m, x) => Math.max(m, x.quality), 0);
  if (s.quality >= top - 3 || early) {
    return vary([`${name} is the best player left. Too good to pass up.`, `Couldn't let ${name} go past me.`, `${name}, the pick of what's left.`]);
  }
  return forTheSide(s.p, c.mine, vary);
}

/** What a player does for the side, when no single factor decided the pick. */
function forTheSide(p: PlayerWithStats, mine: PlayerWithStats[], vary: <T>(xs: T[]) => T): string {
  const name = p.name;
  const pace = mine.filter(isPace).length;
  if (p.primary_role === "BOWL") return isPace(p) && pace <= 1 ? `${name} to lead my attack.` : vary([`${name} strengthens my bowling.`, `${name} gives my attack another weapon.`]);
  if (p.primary_role === "AR") return vary([`${name} gives me runs and overs.`, `${name} balances my side: bat and ball.`]);
  if (p.primary_role === "WK") return `${name} with the gloves and the bat.`;
  return isNaturalOpener(p) ? `${name} to open the batting.` : vary([`${name} strengthens my top order.`, `${name} adds runs to my middle order.`]);
}
