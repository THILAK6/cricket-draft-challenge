import type { AuctionState, Challenge, PickLogEntry } from "./types";
import type { MatchSimulationResult } from "./simulator";

/** A saved match as the API sends it (stored by worker/match-store.ts). */
export interface MatchSummary {
  id: string;
  playedAt: number;
  format: string;
  venue: string;
  pitch: string;
  winner: string;
  userScore: string;
  aiScore: string;
  summary: string;
}

/** A player as the stored match remembers him: enough for lists and records, without career data. */
export interface StoredPick {
  id: string;
  name: string;
  country: string;
  role: string;
}

/** Everything the result screen needs, and nothing it doesn't (no pool, no career stats). */
export interface MatchSnapshot {
  id: string;
  playedAt: number;
  challenge: Challenge;
  difficulty?: string;
  theme?: string;
  /** How the draft ran (matches saved before this have neither this nor `auction`). */
  draftMode?: "snake" | "auction";
  /** The auction, for analysis: the rival's style, what each side had left, and every lot in order, unsold ones included. */
  auction?: { style: AuctionState["style"]; purseLeft: { USER: number; AI: number }; accelerated: boolean; log: AuctionState["log"] };
  /** Everyone who was in the pool (ids), so who was not drafted is known too. */
  poolIds?: string[];
  userXI: StoredPick[];
  aiXI: StoredPick[];
  pickLog?: PickLogEntry[];
  /** The match seed: with both XIs and the engine of the day, replays this exact match (for checking a result). */
  seed?: number;
  simulation: MatchSimulationResult;
  results: Record<string, unknown>;
}
