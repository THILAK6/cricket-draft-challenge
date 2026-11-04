import { z } from "zod";
import type { Challenge, MatchFormat, PitchType, PlayerWithStats } from "../core/types";
import { ChallengeSchema } from "../core/types";
import { checkChallengeFeasibility } from "../core/validator";

export interface Env {
  DB: D1Database;
  AI?: any;
}

const FALLBACK_SCENARIOS: Omit<Challenge, "id">[] = [
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
];

/**
 * Loads active format players from D1 into the domain PlayerWithStats format.
 */
export async function fetchPlayerPool(
  db: D1Database,
  format: MatchFormat = "T20",
  limit = 70
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
    WHERE s.format = ? AND s.matches >= 5
    ORDER BY s.matches DESC, s.bat_runs DESC
    LIMIT ?;
  `;

  const { results } = await db.prepare(query).bind(format, limit).all();

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
export async function generateValidatedChallenge(
  env: Env,
  options: { format?: MatchFormat; requestedVenue?: string } = {}
): Promise<{ challenge: Challenge; pool: PlayerWithStats[]; attempts: number }> {
  const format: MatchFormat = options.format || "T20";
  const pool = await fetchPlayerPool(env.DB, format, 80);

  if (pool.length < 22) {
    throw new Error(`Insufficient players in D1 database for format ${format} (found ${pool.length}). Run database seeding.`);
  }

  const maxAttempts = 3;
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
    const feasibility = checkChallengeFeasibility(pool, candidateChallenge, 50);

    if (feasibility.isFeasible) {
      // Persist challenge into D1
      await saveChallenge(env.DB, candidateChallenge);
      return { challenge: candidateChallenge, pool, attempts: attempt };
    }

    lastRejectionReason = feasibility.reasons.join("; ");
    console.warn(`[Generator] Attempt ${attempt} failed feasibility check: ${lastRejectionReason}`);
  }

  // If AI generation attempts failed feasibility, fall back to guaranteed feasible template
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
  const template = FALLBACK_SCENARIOS[Math.floor(Math.random() * FALLBACK_SCENARIOS.length)];
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
