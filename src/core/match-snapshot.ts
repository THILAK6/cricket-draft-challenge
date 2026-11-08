import type { Challenge, PickLogEntry } from "./types";
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
  userXI: StoredPick[];
  aiXI: StoredPick[];
  pickLog?: PickLogEntry[];
  simulation: MatchSimulationResult;
  results: Record<string, unknown>;
}
