import { Hono } from "hono";
import { cors } from "hono/cors";
import { DraftRoom } from "./durable-objects/DraftRoom";
import { generateValidatedChallenge } from "./worker/challenge-generator";
import type { PlayerWithStats } from "./core/types";
import type { Challenge, MatchFormat } from "./core/types";
import { getMatch, isDeviceId, isMatchId, listMatches } from "./worker/match-store";

export { DraftRoom };

export interface Env {
  DB: D1Database;
  DRAFT_ROOM: DurableObjectNamespace;
  AI?: any;
  /** "on" lets Workers AI choose the AI's picks from the rules' shortlist and add a line (off by default). */
  AI_VOICE?: string;
  /** Workers AI model for the voice (default in core/ai-voice.ts). */
  AI_VOICE_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for web frontend clients
app.use("/*", cors());

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "healthy", service: "cricket-draft-challenge" });
});

// List recent challenges (optionally filtered by format: ?format=T20|ODI|TEST)
app.get("/api/challenges", async (c) => {
  const format = c.req.query("format");
  let query = "SELECT id, format, venue_name, venue_country, pitch_type, title, narrative_intro, constraints_json, created_at FROM challenges";
  const params: any[] = [];
  if (format) {
    query += " WHERE format = ?";
    params.push(format);
  }
  query += " ORDER BY created_at DESC LIMIT 20";

  const stmt = c.env.DB.prepare(query);
  const { results } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

  const formatted = (results || []).map((row: any) => ({
    id: row.id,
    format: row.format,
    venue: {
      name: row.venue_name,
      country: row.venue_country,
      pitch_type: row.pitch_type,
    },
    title: row.title,
    narrative_intro: row.narrative_intro,
    constraints: JSON.parse(row.constraints_json || "[]"),
    created_at: row.created_at,
  }));

  return c.json({ challenges: formatted });
});

// Get single challenge by ID
app.get("/api/challenges/:id", async (c) => {
  const id = c.req.param("id");
  const row: any = await c.env.DB.prepare(
    "SELECT id, format, venue_name, venue_country, pitch_type, title, narrative_intro, constraints_json, created_at FROM challenges WHERE id = ?"
  )
    .bind(id)
    .first();

  if (!row) {
    return c.json({ error: "Challenge not found" }, 404);
  }

  return c.json({
    challenge: {
      id: row.id,
      format: row.format,
      venue: {
        name: row.venue_name,
        country: row.venue_country,
        pitch_type: row.pitch_type,
      },
      title: row.title,
      narrative_intro: row.narrative_intro,
      constraints: JSON.parse(row.constraints_json || "[]"),
      created_at: row.created_at,
    },
  });
});

// Generate a new validated challenge via Workers AI + Deterministic Solver
app.post("/api/challenges/generate", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { format?: MatchFormat; requestedVenue?: string };
    // No Workers AI here: the free daily allowance is kept for the opponent's voice in the draft
    const result = await generateValidatedChallenge({ ...c.env, AI: undefined }, body);

    return c.json({
      success: true,
      challenge: result.challenge,
      attempts: result.attempts,
      poolSize: result.pool.length,
    });
  } catch (err: any) {
    console.error("[API] Failed to generate challenge:", err);
    return c.json({ error: err.message || "Failed to generate challenge" }, 500);
  }
});

// Start a new draft room. The Worker only picks a room id and forwards: the room (a Durable
// Object, 30 s CPU per request) loads the pool and builds the draft, so this request stays far
// under the Workers Free plan's 10 ms CPU limit even in a cold isolate.
app.post("/api/draft/start", async (c) => {
  try {
    const body = await c.req.json<{ format?: MatchFormat; difficulty?: string; theme?: string; deviceId?: string }>().catch(() => ({}) as any);
    const difficulty = body.difficulty === "easy" || body.difficulty === "hard" ? body.difficulty : "normal";
    const format: MatchFormat = body.format === "ODI" || body.format === "TEST" ? body.format : "T20";
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const stub = c.env.DRAFT_ROOM.get(c.env.DRAFT_ROOM.idFromName(roomId));
    const res = await stub.fetch(
      new Request("http://internal/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, format, difficulty, theme: body.theme, deviceId: isDeviceId(body.deviceId) ? body.deviceId : undefined }),
      })
    );
    const data = (await res.json()) as any;
    if (!res.ok) return c.json({ error: data?.error || "Failed to start draft room" }, 500);
    const state = data.state;
    return c.json({ success: true, roomId, challenge: state.challenge, poolSize: state.pool.length, theme: state.theme });
  } catch (err: any) {
    console.error("[API] Failed to start draft room:", err);
    return c.json({ error: err.message || "Failed to start draft room" }, 500);
  }
});

// Saved matches: this phone's list, and one match by its share id
app.get("/api/matches", async (c) => {
  const device = c.req.query("device");
  if (!isDeviceId(device)) return c.json({ matches: [] });
  try {
    return c.json({ matches: await listMatches(c.env.DB, device) });
  } catch (err: any) {
    console.error("[API] Failed to list matches:", err);
    return c.json({ error: "Could not load your matches" }, 500);
  }
});

app.get("/api/match/:id", async (c) => {
  const id = c.req.param("id");
  if (!isMatchId(id)) return c.json({ error: "Match not found" }, 404);
  try {
    const match = await getMatch(c.env.DB, id);
    return match ? c.json({ match }) : c.json({ error: "Match not found" }, 404);
  } catch (err: any) {
    console.error("[API] Failed to load match:", err);
    return c.json({ error: "Could not load this match" }, 500);
  }
});

// Durable Object Proxy (HTTP & WebSocket upgrades)
app.all("/api/room/:roomId/*", async (c) => {
  const roomId = c.req.param("roomId");
  const doId = c.env.DRAFT_ROOM.idFromName(roomId);
  const stub = c.env.DRAFT_ROOM.get(doId);

  const url = new URL(c.req.url);
  const doPath = url.pathname.replace(`/api/room/${roomId}`, "") || "/";

  // Room creation is internal-only (done by /api/draft/start); never expose it publicly.
  if (doPath.endsWith("/init") || doPath.endsWith("/create")) {
    return c.json({ error: "Not found" }, 404);
  }
  const doUrl = new URL(doPath + url.search, url.origin);

  return stub.fetch(new Request(doUrl.toString(), c.req.raw));
});

export default app;
