import type { DraftState, PlayerWithStats } from "../core/types";
import type { MatchSnapshot, MatchSummary, StoredPick } from "../core/match-snapshot";

export type { MatchSnapshot, MatchSummary, StoredPick };

/**
 * Finished matches, kept in D1 so a result can be reopened or shared at any time.
 *
 * What is stored is what the player saw (scorecards, review, awards), not the inputs to replay it:
 * the match engine changes, and an old scorecard should not change with it.
 *
 * One row per match: about 20-40 KB, one write. The table is created on first use, so a fresh
 * database needs no migration step.
 */

const ID_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
/** A short, unguessable id for the share link (10 characters: about 50 bits). */
export function newMatchId(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ID_CHARS[Math.floor(random() * ID_CHARS.length)];
  return s;
}

export const isMatchId = (s: unknown): s is string => typeof s === "string" && /^[a-z2-9]{10}$/.test(s);
/** The phone's anonymous id: random, made in the browser. */
export const isDeviceId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(s);

const pick = (p: PlayerWithStats | null): StoredPick[] => (p ? [{ id: p.id, name: p.name, country: p.country, role: p.primary_role }] : []);

const innings = (i?: { totalRuns: number; totalWickets: number; totalBalls: number; declared?: boolean }) =>
  i && i.totalBalls > 0 ? (i.totalWickets >= 10 ? `${i.totalRuns}` : `${i.totalRuns}/${i.totalWickets}${i.declared ? "d" : ""}`) : "";
const both = (a?: Parameters<typeof innings>[0], b?: Parameters<typeof innings>[0]) => [innings(a), innings(b)].filter(Boolean).join(" & ");

export function buildSnapshot(ds: DraftState, id: string, playedAt = Date.now()): MatchSnapshot {
  const sim = ds.simulation!;
  // The results object carries a second copy of the simulation; keep one
  const { simulation: _dup, ...results } = (ds.results ?? {}) as Record<string, unknown>;
  return {
    id,
    playedAt,
    challenge: ds.challenge,
    difficulty: ds.difficulty,
    theme: ds.theme,
    userXI: ds.userPicks.flatMap(pick),
    aiXI: ds.aiPicks.flatMap(pick),
    pickLog: ds.pickLog,
    seed: ds.matchSeed,
    simulation: sim,
    results,
  };
}

export function summaryOf(s: MatchSnapshot): MatchSummary {
  const sim = s.simulation;
  return {
    id: s.id,
    playedAt: s.playedAt,
    format: s.challenge.league ?? sim.format,
    venue: s.challenge.venue.name,
    pitch: s.challenge.venue.pitch_type,
    winner: sim.winner,
    userScore: both(sim.userInnings, sim.userSecondInnings),
    aiScore: both(sim.aiInnings, sim.aiSecondInnings),
    summary: sim.summary,
  };
}

const CREATE = `CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  played_at INTEGER NOT NULL,
  format TEXT NOT NULL,
  venue TEXT NOT NULL,
  pitch TEXT NOT NULL,
  winner TEXT NOT NULL,
  user_score TEXT NOT NULL,
  ai_score TEXT NOT NULL,
  summary TEXT NOT NULL,
  data TEXT NOT NULL
)`;
const INDEX = "CREATE INDEX IF NOT EXISTS idx_matches_device ON matches(device_id, played_at)";

let ready: Promise<unknown> | null = null;
/** Creates the table once per isolate (cheap no-op afterwards). */
function ensureTable(db: D1Database): Promise<unknown> {
  if (!ready) ready = db.batch([db.prepare(CREATE), db.prepare(INDEX)]).catch((e) => ((ready = null), Promise.reject(e)));
  return ready;
}

export async function saveMatch(db: D1Database, snap: MatchSnapshot, deviceId?: string): Promise<void> {
  await ensureTable(db);
  const m = summaryOf(snap);
  await db
    .prepare(
      "INSERT OR REPLACE INTO matches (id, device_id, played_at, format, venue, pitch, winner, user_score, ai_score, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(m.id, deviceId ?? null, m.playedAt, m.format, m.venue, m.pitch, m.winner, m.userScore, m.aiScore, m.summary, JSON.stringify(snap))
    .run();
}

/** This phone's matches, newest first (summary columns only: the list never reads the big data column). */
export async function listMatches(db: D1Database, deviceId: string, limit = 50): Promise<MatchSummary[]> {
  await ensureTable(db);
  const { results } = await db
    .prepare(
      "SELECT id, played_at, format, venue, pitch, winner, user_score, ai_score, summary FROM matches WHERE device_id = ? ORDER BY played_at DESC LIMIT ?"
    )
    .bind(deviceId, limit)
    .all<Record<string, any>>();
  return (results ?? []).map((r) => ({
    id: r.id,
    playedAt: r.played_at,
    format: r.format,
    venue: r.venue,
    pitch: r.pitch,
    winner: r.winner,
    userScore: r.user_score,
    aiScore: r.ai_score,
    summary: r.summary,
  }));
}

export async function getMatch(db: D1Database, id: string): Promise<MatchSnapshot | null> {
  await ensureTable(db);
  const { results } = await db.prepare("SELECT data FROM matches WHERE id = ?").bind(id).all<{ data: string }>();
  const row = results?.[0];
  return row ? (JSON.parse(row.data) as MatchSnapshot) : null;
}
