import { z } from "zod";
import type { MatchSimulationResult } from "./simulator";

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
export interface AiSnipeInfo {
  player: PlayerWithStats;
  slotIndex: number;
  reason: string;
}

export interface DraftState {
  roomId: string;
  challenge: Challenge;
  pool: PlayerWithStats[];
  userPicks: (PlayerWithStats | null)[];
  aiPicks: (PlayerWithStats | null)[];
  currentTurn: "USER" | "AI";
  round: number;
  maxRounds: number;
  status: "WAITING" | "DRAFTING" | "SOLO_PICK" | "READY_TO_PLAY" | "COMPLETED";
  lastActionTimestamp: number;
  /** Fixed per-room RNG seed so a given pair of squads always produces the same match. */
  matchSeed?: number;
  simulation?: MatchSimulationResult;
  results?: any;
  lastAiSnipe?: AiSnipeInfo;
}

export interface SlotDefinition {
  slot: number; // 1 to 11
  name: string;
  shortRole: string;
  icon: string;
  description: string;
}

export function getSlotDefinitions(format: MatchFormat = "T20"): SlotDefinition[] {
  if (format === "TEST") {
    return [
      { slot: 1, name: "Opening Batter", shortRole: "OPENER", icon: "🏏", description: "Blunt the new Dukes ball with solid defense and patience" },
      { slot: 2, name: "Opening Batter", shortRole: "OPENER", icon: "🏏", description: "Top order leave technique and high balls faced" },
      { slot: 3, name: "No. 3 Anchor", shortRole: "ANCHOR", icon: "🛡️", description: "First drop technician to steady early breakthroughs" },
      { slot: 4, name: "Middle Order Pillar", shortRole: "MIDDLE", icon: "🏛️", description: "Proven century-maker and partnership builder" },
      { slot: 5, name: "Middle Order Batter", shortRole: "MIDDLE", icon: "🛡️", description: "Patience against spin and second new ball resilience" },
      { slot: 6, name: "All-Rounder / Middle Order", shortRole: "ALL-ROUND", icon: "⚔️", description: "Counter-attacking bat and vital 5th bowling option" },
      { slot: 7, name: "Wicketkeeper-Batter", shortRole: "WK_BAT", icon: "🧤", description: "Glovework to pacers & spinners, batting with the tail" },
      { slot: 8, name: "Bowling All-Rounder", shortRole: "BOWL_AR", icon: "🎯", description: "Lower order resilience and frontline bowling spells" },
      { slot: 9, name: "Specialist Bowler", shortRole: "BOWLER", icon: "⚡", description: "Strike weapon (Express Pace / Mystery Spin)" },
      { slot: 10, name: "Specialist Bowler", shortRole: "BOWLER", icon: "🎯", description: "Workhorse seamer / probing line & length" },
      { slot: 11, name: "Specialist Bowler", shortRole: "BOWLER", icon: "💥", description: "Attack spearhead or spin wizard taking 20 wickets" },
    ];
  }

  if (format === "ODI") {
    return [
      { slot: 1, name: "Opener", shortRole: "OPENER", icon: "🏏", description: "Powerplay 1 aggressor / strike builder" },
      { slot: 2, name: "Opener", shortRole: "OPENER", icon: "🏏", description: "New ball boundary finder & runner" },
      { slot: 3, name: "No. 3 Anchor", shortRole: "ANCHOR", icon: "🛡️", description: "Middle overs tempo controller (avg 45+)" },
      { slot: 4, name: "Middle Order", shortRole: "MIDDLE", icon: "🛡️", description: "Strike rotator & boundary accumulator" },
      { slot: 5, name: "Middle Aggressor", shortRole: "MIDDLE", icon: "⚡", description: "Accelerates between overs 30-40" },
      { slot: 6, name: "Finisher / All-Rounder", shortRole: "FINISHER", icon: "💥", description: "Death overs blitz and clutch match finishing" },
      { slot: 7, name: "Lower Order AR", shortRole: "ALL-ROUND", icon: "🌟", description: "Late-innings hitting and 10 overs quota" },
      { slot: 8, name: "Bowling All-Rounder", shortRole: "BOWL_AR", icon: "🎯", description: "Deep batting security and wicket taker" },
      { slot: 9, name: "Frontline Bowler", shortRole: "BOWLER", icon: "⚡", description: "New ball swing and middle overs cutter" },
      { slot: 10, name: "Frontline Bowler", shortRole: "BOWLER", icon: "🎯", description: "Line & length containment bowler" },
      { slot: 11, name: "Frontline Bowler", shortRole: "BOWLER", icon: "💥", description: "Death yorker specialist and wicket taker" },
    ];
  }

  // T20 Default
  return [
    { slot: 1, name: "Powerplay Opener", shortRole: "OPENER", icon: "🚀", description: "Exploit 30-yard circle in overs 1-6" },
    { slot: 2, name: "Powerplay Opener", shortRole: "OPENER", icon: "🚀", description: "Boundary hunter with high strike rate" },
    { slot: 3, name: "Anchor / Stroke Player", shortRole: "ANCHOR", icon: "🛡️", description: "Rotates strike against spin in middle overs" },
    { slot: 4, name: "Middle Order Hitter", shortRole: "MIDDLE", icon: "⚡", description: "Target boundaries against slow bowlers" },
    { slot: 5, name: "Middle Order Power", shortRole: "MIDDLE", icon: "⚡", description: "Clears long boundaries at 140+ SR" },
    { slot: 6, name: "Death Finisher / AR", shortRole: "FINISHER", icon: "💥", description: "180+ death SR specialist (Hardik/Russell role)" },
    { slot: 7, name: "Power Finisher / AR", shortRole: "FINISHER", icon: "🌟", description: "High-octane hitting in overs 17-20" },
    { slot: 8, name: "Bowling All-Rounder", shortRole: "BOWL_AR", icon: "🎯", description: "Batting depth + 4 overs bowling option" },
    { slot: 9, name: "Specialist Bowler", shortRole: "BOWLER", icon: "⚡", description: "Express pace / Mystery spinner" },
    { slot: 10, name: "Frontline Bowler", shortRole: "BOWLER", icon: "🎯", description: "Middle overs squeeze and wicket taker" },
    { slot: 11, name: "Death Bowler", shortRole: "BOWLER", icon: "💥", description: "Nails pinpoint yorkers under pressure" },
  ];
}

