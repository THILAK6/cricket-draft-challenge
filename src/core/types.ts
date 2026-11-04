import { z } from "zod";

// Match format and pitch types
export type MatchFormat = "T20" | "ODI" | "TEST";
export type PitchType = "GREEN_SEAMER" | "DUSTBOWL" | "HIGH_SCORING_FLAT" | "SLOW_LOW";
export type BattingHand = "LHB" | "RHB";
export type BowlingCategory = "NONE" | "PACE" | "SPIN";
export type PlayerRole = "BAT" | "WK" | "AR" | "BOWL";

// Player model in memory & DB
export interface Player {
  id: string;
  cricinfo_id?: string;
  name: string;
  short_name?: string;
  country: string;
  batting_hand: BattingHand;
  bowling_category: BowlingCategory;
  bowling_style?: string;
  primary_role: PlayerRole;
  active_span_start?: number;
  active_span_end?: number;
}

export interface PlayerStats {
  player_id: string;
  format: MatchFormat;
  matches: number;
  bat_innings: number;
  bat_runs: number;
  bat_average: number;
  bat_strike_rate: number;
  top_order_innings: number;
  middle_order_innings: number;
  finisher_innings: number;
  bowl_innings: number;
  bowl_overs: number;
  bowl_wickets: number;
  bowl_average: number;
  bowl_economy: number;
}

export interface PlayerWithStats extends Player {
  stats: PlayerStats;
}

// Constraint AST Schema (Zod definition ensures LLM outputs strict JSON)
export const ConstraintSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("max_per_country"),
    value: z.number().int().min(1).max(11),
    exceptions: z.record(z.string(), z.number().int().min(1).max(11)).optional(),
  }),
  z.object({
    type: z.literal("min_category"),
    category: z.enum(["PACE", "SPIN", "WK", "AR"]),
    count: z.number().int().min(1).max(11),
  }),
  z.object({
    type: z.literal("batting_hand_order"),
    positions: z.array(z.number().int().min(1).max(11)),
    hand: z.enum(["LHB", "RHB"]),
  }),
  z.object({
    type: z.literal("min_strike_rate_top_order"),
    threshold: z.number().positive(),
  }),
  z.object({
    type: z.literal("min_bowlers_economy_under"),
    threshold: z.number().positive(),
    min_count: z.number().int().min(1).max(11),
  })
]);

export type Constraint = z.infer<typeof ConstraintSchema>;

// Full Challenge specification
export const ChallengeSchema = z.object({
  id: z.string(),
  title: z.string(),
  format: z.enum(["T20", "ODI", "TEST"]),
  venue: z.object({
    name: z.string(),
    country: z.string(),
    pitch_type: z.enum(["GREEN_SEAMER", "DUSTBOWL", "HIGH_SCORING_FLAT", "SLOW_LOW"]),
  }),
  narrative_intro: z.string(),
  constraints: z.array(ConstraintSchema),
});

export type Challenge = z.infer<typeof ChallengeSchema>;

// Scoring Breakdown
export interface ScoringBreakdown {
  role_balance_score: number;       // 0 - 25: WK, 5 bowling options, 2 openers
  pitch_suitability_score: number;  // 0 - 25: Match pitch condition to attack
  player_quality_score: number;     // 0 - 35: Career stats in requested format
  batting_depth_score: number;      // 0 - 15: Run capability down to pos 8
  deterministic_total: number;      // Sum (0 - 100)
  llm_adjustment: number;           // Bounded: -10 to +10
  final_score: number;              // Clamped: 0 - 100
  verdict_summary: string;
}

// Draft Room State for Durable Objects
export interface DraftState {
  roomId: string;
  challenge: Challenge;
  pool: PlayerWithStats[];
  userPicks: PlayerWithStats[];
  aiPicks: PlayerWithStats[];
  currentTurn: "USER" | "AI";
  round: number;
  maxRounds: number;
  status: "WAITING" | "DRAFTING" | "SOLO_PICK" | "COMPLETED";
  lastActionTimestamp: number;
}

