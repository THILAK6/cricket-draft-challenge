import { z } from "zod";
import type { Challenge, MatchFormat, PitchType, PlayerWithStats } from "../core/types";
import { ChallengeSchema } from "../core/types";
import { checkDraftFeasibility } from "../core/validator";
import { generateScenario } from "./scenario-generator";

/**
 * Players in each draft room. Every draft gets a fresh random 30 drawn from the most-capped
 * eligible players of the format (POOL_SOURCE_SIZE; not limited to the most-capped). 30 leaves 8 spare after both XIs are filled, which
 * keeps role and country rules satisfiable; 25 left too little slack (only 70-83% of random
 * pools could host any scenario, against 98-100% at 30).
 */
export const DRAFT_POOL_SIZE = 30;
/** Players the random pool is drawn from. */
export const POOL_SOURCE_SIZE = 1000;
/** Minimum caps to be eligible for a random pool (any player with a real record, not just the top-N). */
export const POOL_MIN_MATCHES = 15;
/** The most-capped players count as "top players"; at least this share of every random pool comes from them. */
export const TOP_PLAYER_COUNT = 50;
export const TOP_PLAYER_SHARE = 0.6;
/** The fixed top-N pool the built-in templates are verified against (tests/templates.test.ts). */
export const VERIFIED_POOL_SIZE = 50;

/**
 * Free-plan budget: Workers AI gives ~10k neurons/day, so ask the model once per request and
 * fall back to the built-in templates (which cost nothing) rather than retrying.
 */
const MAX_AI_ATTEMPTS = 1;

/** Pools change only when the DB is re-seeded, so keep them per isolate to save D1 reads and CPU. */
const POOL_CACHE_TTL_MS = 10 * 60 * 1000;
const poolCache = new Map<string, { at: number; pool: PlayerWithStats[] }>();

export async function getPlayerPool(
  db: D1Database,
  format: MatchFormat,
  limit = VERIFIED_POOL_SIZE,
  minMatches = 5
): Promise<PlayerWithStats[]> {
  const key = `${format}:${limit}:${minMatches}`;
  const hit = poolCache.get(key);
  if (hit && Date.now() - hit.at < POOL_CACHE_TTL_MS) return hit.pool;
  const pool = await fetchPlayerPool(db, format, limit, minMatches);
  if (pool.length > 0) poolCache.set(key, { at: Date.now(), pool });
  return pool;
}

export interface Env {
  DB: D1Database;
  AI?: any;
}

export const FALLBACK_SCENARIOS: Omit<Challenge, "id">[] = [
  {
    title: "The Chepauk Dustbowl Trial",
    format: "T20",
    venue: {
      name: "MA Chidambaram Stadium, Chennai",
      country: "IND",
      pitch_type: "DUSTBOWL",
    },
    narrative_intro:
      "A baking summer afternoon at Chepauk. The red clay surface is cracked from ball one. Fast bowlers will get zero bounce, and spinners will turn the ball square.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { IND: 3 } },
      { type: "min_category", category: "SPIN", count: 2 },
    ],
  },
  {
    title: "Headingley Monsoon Green-Top",
    format: "T20",
    venue: {
      name: "Headingley, Leeds",
      country: "ENG",
      pitch_type: "GREEN_SEAMER",
    },
    narrative_intro:
      "Overcast skies, 16°C drizzle, and a lush green outfield. The ball is expected to dart sideways under heavy cloud cover. Survival against seam is paramount.",
    constraints: [
      { type: "max_per_country", value: 1, exceptions: { ENG: 2 } },
      { type: "min_category", category: "PACE", count: 3 },
      { type: "batting_hand_order", positions: [1, 2], hand: "LHB" },
    ],
  },
  {
    title: "Wankhede Fireworks Festival",
    format: "T20",
    venue: {
      name: "Wankhede Stadium, Mumbai",
      country: "IND",
      pitch_type: "HIGH_SCORING_FLAT",
    },
    narrative_intro:
      "A true batsman's paradise with lightning-fast outfields and true bounce. Par score is 210+. Accumulators won't cut it—you need boundary riders and death specialists.",
    constraints: [
      { type: "max_per_country", value: 2 },
      { type: "min_category", category: "AR", count: 2 },
    ],
  },
  {
    title: "Dhaka Slow Burner",
    format: "T20",
    venue: {
      name: "Sher-e-Bangla National Cricket Stadium, Mirpur",
      country: "BAN",
      pitch_type: "SLOW_LOW",
    },
    narrative_intro:
      "A black-soil Mirpur gripper with unpredictable variable bounce. Spinners and cutters dominate, and any batsman with a strike rate above 120 is golden.",
    constraints: [
      { type: "max_per_country", value: 1, exceptions: { BAN: 2 } },
      { type: "min_category", category: "SPIN", count: 2 },
    ],
  },
  // ODI Scenarios
  {
    title: "World Cup 50-Over Crucible",
    format: "ODI",
    venue: {
      name: "Narendra Modi Stadium, Ahmedabad",
      country: "IND",
      pitch_type: "SLOW_LOW",
    },
    narrative_intro:
      "50 overs under scorching sun. Overs 11-40 strike rotation and reverse swing will decide the match. Patience and tactical field-placing are paramount.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { IND: 3 } },
      { type: "min_category", category: "PACE", count: 2 },
      { type: "min_category", category: "SPIN", count: 1 },
    ],
  },
  {
    title: "Wanderers 438 Tribute Match",
    format: "ODI",
    venue: {
      name: "Wanderers Stadium, Johannesburg",
      country: "RSA",
      pitch_type: "HIGH_SCORING_FLAT",
    },
    narrative_intro:
      "High altitude and rock-hard pitch. Ball flies over boundaries; Dale Steyn style express pace needed to stem flow and break partnerships.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { RSA: 3 } },
      { type: "min_category", category: "PACE", count: 3 },
    ],
  },
  // TEST Scenarios
  {
    title: "The Ashes at Lord's - Day 1 Seam Battle",
    format: "TEST",
    venue: {
      name: "Lord's Cricket Ground, London",
      country: "ENG",
      pitch_type: "GREEN_SEAMER",
    },
    narrative_intro:
      "Red Dukes ball, emerald green pitch with Lord's slope. Swing bowlers like Anderson rule the morning session; top order must leave well.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { ENG: 3 } },
      { type: "min_category", category: "PACE", count: 3 },
      { type: "batting_hand_order", positions: [1, 2], hand: "LHB" },
    ],
  },
  {
    title: "Border-Gavaskar Trophy at The Gabba",
    format: "TEST",
    venue: {
      name: "The Gabba, Brisbane",
      country: "AUS",
      pitch_type: "GREEN_SEAMER",
    },
    narrative_intro:
      "Fast, bouncy deck with steep carry to the keeper. Taking 20 wickets with express pace is mandatory to triumph on this historic fortress.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { AUS: 3 } },
      { type: "min_category", category: "PACE", count: 3 },
    ],
  },
  {
    title: "Eden Gardens Day 4 Spin Cauldron",
    format: "TEST",
    venue: {
      name: "Eden Gardens, Kolkata",
      country: "IND",
      pitch_type: "DUSTBOWL",
    },
    narrative_intro:
      "Puff of dust on every delivery. Ball is spitting off the cracks. Subcontinental spin wizards are lethal; batters need soft hands and sweep technique.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { IND: 3 } },
      // The Test pool has only 3 spinners and both teams draft from it, so 1 each is the max
      { type: "min_category", category: "SPIN", count: 1 },
    ],
  },
  // --- More scenarios (verified against random pools by tests/random-draft.test.ts) ---
  {
    title: "Newlands Evening Seam",
    format: "T20",
    venue: { name: "Newlands, Cape Town", country: "RSA", pitch_type: "GREEN_SEAMER" },
    narrative_intro: "Table Mountain shadows and a cool sea breeze. The new ball nips around under lights; pace with bounce gets rewarded.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { RSA: 3 } },
      { type: "min_category", category: "PACE", count: 2 },
    ],
  },
  {
    title: "Dubai Under The Lights",
    format: "T20",
    venue: { name: "Dubai International Stadium", country: "UAE", pitch_type: "SLOW_LOW" },
    narrative_intro: "A tacky, tired surface that grips under lights. Pace-off cutters and clever spin choke the powerplay; chasing is never easy.",
    constraints: [
      { type: "max_per_country", value: 2 },
      { type: "min_category", category: "SPIN", count: 1 },
    ],
  },
  {
    title: "MCG Boxing Day Blast",
    format: "T20",
    venue: { name: "Melbourne Cricket Ground", country: "AUS", pitch_type: "HIGH_SCORING_FLAT" },
    narrative_intro: "A huge outfield, a packed house and a flat deck. Clean hitters thrive, and bowlers must back their yorkers.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { AUS: 3 } },
      { type: "min_category", category: "AR", count: 1 },
    ],
  },
  {
    title: "Lord's Final Showdown",
    format: "ODI",
    venue: { name: "Lord's Cricket Ground, London", country: "ENG", pitch_type: "GREEN_SEAMER" },
    narrative_intro: "A cloudy morning in St John's Wood. The ball swings and seams early, then the slope and the Lord's crowd take over.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { ENG: 3 } },
      { type: "min_category", category: "PACE", count: 2 },
    ],
  },
  {
    title: "Colombo Spin Web",
    format: "ODI",
    venue: { name: "R. Premadasa Stadium, Colombo", country: "SL", pitch_type: "DUSTBOWL" },
    narrative_intro: "Humid air, a dry square and spinners from the first over. Rotating strike against turn decides who wins the middle overs.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { SL: 3 } },
      { type: "min_category", category: "SPIN", count: 2 },
    ],
  },
  {
    title: "Melbourne 90,000 Roar",
    format: "ODI",
    venue: { name: "Melbourne Cricket Ground", country: "AUS", pitch_type: "HIGH_SCORING_FLAT" },
    narrative_intro: "The biggest ground in the game on a true surface. Boundaries are long but pace on the ball runs away; all-rounders carry the balance.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { AUS: 3 } },
      { type: "min_category", category: "AR", count: 1 },
    ],
  },
  {
    title: "Galle Day 3 Turner",
    format: "TEST",
    venue: { name: "Galle International Stadium", country: "SL", pitch_type: "DUSTBOWL" },
    narrative_intro: "The Indian Ocean on one side and a crumbling pitch on the other. By day three every spinner is a threat and every defensive prod is risky.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { SL: 3 } },
      { type: "min_category", category: "SPIN", count: 1 },
    ],
  },
  {
    title: "Newlands Cape Town Seam",
    format: "TEST",
    venue: { name: "Newlands, Cape Town", country: "RSA", pitch_type: "GREEN_SEAMER" },
    narrative_intro: "Grass, cloud and pace. The ball does plenty off the seam on day one, and patient batters are rewarded after lunch.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { RSA: 3 } },
      { type: "min_category", category: "PACE", count: 2 },
    ],
  },
  {
    title: "Sabina Park Slow Burn",
    format: "TEST",
    venue: { name: "Sabina Park, Kingston", country: "WI", pitch_type: "SLOW_LOW" },
    narrative_intro: "A slow, low surface that keeps low and tests patience. Reverse swing and relentless line and length decide who breaks through.",
    constraints: [
      { type: "max_per_country", value: 2, exceptions: { WI: 3 } },
      { type: "min_category", category: "PACE", count: 2 },
    ],
  },
];

/**
 * Loads active format players from D1 into the domain PlayerWithStats format.
 */
export async function fetchPlayerPool(
  db: D1Database,
  format: MatchFormat = "T20",
  limit = 70,
  minMatches = 5
): Promise<PlayerWithStats[]> {
  const query = `
    SELECT 
      p.id, p.cricinfo_id, p.name, p.short_name, p.country,
      p.batting_hand, p.bowling_category, p.bowling_style, p.primary_role,
      s.matches, s.bat_innings, s.bat_runs, s.bat_balls, s.bat_average,
      s.bat_strike_rate, s.top_order_innings, s.middle_order_innings,
      s.finisher_innings, s.bowl_innings, s.bowl_overs, s.bowl_wickets,
      s.bowl_average, s.bowl_economy
    FROM players p
    JOIN player_format_stats s ON p.id = s.player_id
    WHERE s.format = ? AND s.matches >= ?
    ORDER BY s.matches DESC, s.bat_runs DESC
    LIMIT ?;
  `;

  const { results } = await db.prepare(query).bind(format, minMatches, limit).all();

  return (results || []).map((row: any) => ({
    id: row.id,
    cricinfo_id: row.cricinfo_id,
    name: row.name,
    short_name: row.short_name,
    country: row.country,
    batting_hand: row.batting_hand,
    bowling_category: row.bowling_category,
    bowling_style: row.bowling_style,
    primary_role: row.primary_role,
    stats: {
      player_id: row.id,
      format,
      matches: row.matches,
      bat_innings: row.bat_innings,
      bat_runs: row.bat_runs,
      bat_average: row.bat_average,
      bat_strike_rate: row.bat_strike_rate,
      top_order_innings: row.top_order_innings,
      middle_order_innings: row.middle_order_innings,
      finisher_innings: row.finisher_innings,
      bowl_innings: row.bowl_innings,
      bowl_overs: row.bowl_overs,
      bowl_wickets: row.bowl_wickets,
      bowl_average: row.bowl_average,
      bowl_economy: row.bowl_economy,
    },
  }));
}

/**
 * Calls Workers AI to propose a challenge, then validates feasibility deterministically.
 * If validation fails, it retries with the error explanation.
 */

const shuffled = <T,>(xs: T[], rand: () => number): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * Draws a random pool: role quotas first (so a keeper, pace, spin and all-rounders are always
 * available), then random fill with at most a fifth of the pool from one country.
 */
export function samplePool(
  source: PlayerWithStats[],
  size: number,
  rand: () => number = Math.random,
  topN = TOP_PLAYER_COUNT,
  topShare = TOP_PLAYER_SHARE
): PlayerWithStats[] {
  const order = shuffled(source, rand);
  // The most-capped players of the format; at least topShare of every pool comes from them.
  const topIds = new Set([...source].sort((x, y) => y.stats.matches - x.stats.matches).slice(0, topN).map((p) => p.id));
  const topOrder = order.filter((p) => topIds.has(p.id));
  const topTarget = Math.min(topOrder.length, Math.ceil(size * topShare));
  const picked: PlayerWithStats[] = [];
  const ids = new Set<string>();
  const add = (p: PlayerWithStats) => {
    picked.push(p);
    ids.add(p.id);
  };
  const take = (from: PlayerWithStats[], match: (p: PlayerWithStats) => boolean, count: number) => {
    for (const p of from) {
      if (count <= 0) break;
      if (!ids.has(p.id) && match(p)) {
        add(p);
        count--;
      }
    }
  };
  const quotas: [(p: PlayerWithStats) => boolean, number][] = [
    [(p) => p.primary_role === "WK", 4],
    [(p) => p.primary_role === "BOWL" && p.bowling_category === "PACE", 6],
    [(p) => p.primary_role === "BOWL" && p.bowling_category === "SPIN", 4],
    [(p) => p.primary_role === "AR", 4],
    [(p) => p.primary_role === "BAT", 10],
  ];
  // Role quotas first, with the top-player share of each taken from the top players
  for (const [match, q] of quotas) take(topOrder, match, Math.min(q, Math.floor(q * topShare)));
  const topCount = () => picked.filter((p) => topIds.has(p.id)).length;
  for (const [match, q] of quotas) {
    // Remaining slots in each role come from top players until the share is met, then from anyone
    const need = q - picked.filter(match).length;
    take(topOrder, match, Math.min(need, Math.max(0, topTarget - topCount())));
    take(order, match, q - picked.filter(match).length);
  }
  const perCountry = new Map<string, number>();
  for (const p of picked) perCountry.set(p.country, (perCountry.get(p.country) ?? 0) + 1);
  const cap = Math.ceil(size / 5);
  const fill = (from: PlayerWithStats[], until: () => boolean) => {
    for (const p of from) {
      if (until()) break;
      if (ids.has(p.id) || (perCountry.get(p.country) ?? 0) >= cap) continue;
      add(p);
      perCountry.set(p.country, (perCountry.get(p.country) ?? 0) + 1);
    }
  };
  // Top up the top-player share first, then fill the rest from anyone
  fill(topOrder, () => picked.length >= size || picked.filter((p) => topIds.has(p.id)).length >= topTarget);
  fill(order, () => picked.length >= size);
  return picked.sort((a, b) => b.stats.matches - a.stats.matches);
}

/**
 * A fresh draft: a random pool and a random scenario that the pool can actually host. The check
 * is the cheap constructive one (about 0.03 ms), so it fits the free-plan CPU budget. No AI call.
 */
export async function buildRandomDraft(
  db: D1Database,
  format: MatchFormat,
  rand: () => number = Math.random
): Promise<{ challenge: Challenge; pool: PlayerWithStats[] }> {
  const source = await getPlayerPool(db, format, POOL_SOURCE_SIZE, POOL_MIN_MATCHES);
  const templates = FALLBACK_SCENARIOS.filter((s) => s.format === format);
  if (source.length < DRAFT_POOL_SIZE || templates.length === 0) {
    throw new Error(`Not enough ${format} players in the database (found ${source.length}). Run database seeding.`);
  }
  const make = (t: Omit<Challenge, "id">): Challenge => ({
    id: `ch_${Date.now()}_${Math.floor(rand() * 1e9).toString(36)}`,
    ...t,
    format,
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    const pool = samplePool(source, DRAFT_POOL_SIZE, rand);
    // A freshly generated ground, conditions and selection rules, checked against this very pool
    for (let tries = 0; tries < 12; tries++) {
      const challenge = make(generateScenario(format, rand));
      if (checkDraftFeasibility(pool, challenge, 1).isFeasible) return { challenge, pool };
    }
    // Otherwise one of the hand-written scenarios
    for (const t of shuffled(templates, rand)) {
      const challenge = make(t);
      if (checkDraftFeasibility(pool, challenge, 1).isFeasible) return { challenge, pool };
    }
  }
  // Extremely unlikely: fall back to the fixed pool every template is verified against.
  const pool = await getPlayerPool(db, format, VERIFIED_POOL_SIZE);
  return { challenge: make(templates[Math.floor(rand() * templates.length)]), pool };
}

export async function generateValidatedChallenge(
  env: Env,
  options: { format?: MatchFormat; requestedVenue?: string } = {}
): Promise<{ challenge: Challenge; pool: PlayerWithStats[]; attempts: number }> {
  const format: MatchFormat = options.format || "T20";
  const pool = await getPlayerPool(env.DB, format, VERIFIED_POOL_SIZE);

  if (pool.length < 22) {
    throw new Error(`Insufficient players in D1 database for format ${format} (found ${pool.length}). Run database seeding.`);
  }

  const maxAttempts = env.AI && typeof env.AI.run === "function" ? MAX_AI_ATTEMPTS : 1;
  let lastRejectionReason = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let candidateChallenge: Challenge;

    if (env.AI && typeof env.AI.run === "function") {
      try {
        candidateChallenge = await requestChallengeFromAI(env.AI, format, options.requestedVenue, lastRejectionReason);
      } catch (err) {
        console.warn(`[Generator] AI generation error on attempt ${attempt}:`, err);
        candidateChallenge = selectFallbackChallenge(format);
      }
    } else {
      candidateChallenge = selectFallbackChallenge(format);
    }

    // Deterministic Feasibility Validation Check
    const feasibility = checkDraftFeasibility(pool, candidateChallenge, 50);

    if (feasibility.isFeasible) {
      // Persist challenge into D1
      await saveChallenge(env.DB, candidateChallenge);
      return { challenge: candidateChallenge, pool, attempts: attempt };
    }

    lastRejectionReason = feasibility.reasons.join("; ");
    console.warn(`[Generator] Attempt ${attempt} failed feasibility check: ${lastRejectionReason}`);
  }

  // Built-in templates are verified against the seeded pools by tests/templates.test.ts,
  // so serving one costs no CPU (no runtime search) and no AI quota.
  const fallback = selectFallbackChallenge(format);
  await saveChallenge(env.DB, fallback);
  return { challenge: fallback, pool, attempts: maxAttempts + 1 };
}

async function requestChallengeFromAI(
  ai: any,
  format: MatchFormat,
  requestedVenue?: string,
  rejectionFeedback?: string
): Promise<Challenge> {
  const systemPrompt = `You are a cricket match scenario architect. Output ONLY valid JSON for a cricket XI draft challenge.
JSON Schema:
{
  "title": string,
  "format": "${format}",
  "venue": {
    "name": string,
    "country": string (ISO 3-letter, e.g. "IND", "AUS", "ENG", "BAN", "RSA", "WI", "NZL", "PAK"),
    "pitch_type": "GREEN_SEAMER" | "DUSTBOWL" | "HIGH_SCORING_FLAT" | "SLOW_LOW"
  },
  "narrative_intro": string,
  "constraints": [
    { "type": "max_per_country", "value": number (1 or 2), "exceptions": { "COUNTRY": number } },
    { "type": "min_category", "category": "PACE" | "SPIN" | "AR" | "WK", "count": number (1-3) },
    { "type": "batting_hand_order", "positions": [1, 2], "hand": "LHB" | "RHB" }
  ]
}
IMPORTANT RULES:
1. Do NOT make constraints impossible. Never require more than 3 of any bowling category.
2. Country constraints must allow at least 11 total players across countries.
3. Output RAW JSON only without markdown code blocks.`;

  let userPrompt = `Generate a creative ${format} cricket challenge${requestedVenue ? ` at ${requestedVenue}` : ""}.`;
  if (rejectionFeedback) {
    userPrompt += ` PREVIOUS ATTEMPT FAILED FEASIBILITY: ${rejectionFeedback}. Relax constraints to ensure solvability.`;
  }

  const response = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 600,
  });

  const rawText: string = response?.response || response?.text || JSON.stringify(response);
  const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

  const parsed = JSON.parse(cleanJson);
  const id = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  return ChallengeSchema.parse({
    id,
    ...parsed,
    format,
  });
}

function selectFallbackChallenge(format: MatchFormat): Challenge {
  const filtered = FALLBACK_SCENARIOS.filter((s) => s.format === format);
  const candidates = filtered.length > 0 ? filtered : FALLBACK_SCENARIOS;
  const template = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    id: `ch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    ...template,
    format,
  };
}

export async function saveChallenge(db: D1Database, challenge: Challenge) {
  const query = `
    INSERT OR REPLACE INTO challenges 
    (id, format, venue_name, venue_country, pitch_type, title, narrative_intro, constraints_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `;

  await db
    .prepare(query)
    .bind(
      challenge.id,
      challenge.format,
      challenge.venue.name,
      challenge.venue.country,
      challenge.venue.pitch_type,
      challenge.title,
      challenge.narrative_intro,
      JSON.stringify(challenge.constraints)
    )
    .run();
}

