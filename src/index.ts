import { Hono } from "hono";
import { cors } from "hono/cors";
import { DraftRoom } from "./durable-objects/DraftRoom";
import { generateValidatedChallenge, fetchPlayerPool } from "./worker/challenge-generator";
import type { Challenge, MatchFormat } from "./core/types";

export { DraftRoom };

export interface Env {
  DB: D1Database;
  DRAFT_ROOM: DurableObjectNamespace;
  AI?: any;
  GEMINI_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for web frontend clients
app.use("/*", cors());

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "healthy", service: "cricket-draft-challenge" });
});

// List recent challenges
app.get("/api/challenges", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, format, venue_name, venue_country, pitch_type, title, narrative_intro, constraints_json, created_at FROM challenges ORDER BY created_at DESC LIMIT 10"
  ).all();

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
    const result = await generateValidatedChallenge(c.env, body);

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

// Start a new draft room session with a challenge
app.post("/api/draft/start", async (c) => {
  try {
    const body = await c.req.json<{ challengeId?: string; format?: MatchFormat }>();
    let challenge: Challenge;

    if (body.challengeId) {
      const row: any = await c.env.DB.prepare(
        "SELECT id, format, venue_name, venue_country, pitch_type, title, narrative_intro, constraints_json FROM challenges WHERE id = ?"
      )
        .bind(body.challengeId)
        .first();

      if (!row) return c.json({ error: "Challenge not found" }, 404);

      challenge = {
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
      };
    } else {
      // Auto-generate a challenge if not supplied
      const generated = await generateValidatedChallenge(c.env, { format: body.format });
      challenge = generated.challenge;
    }

    // Load candidate player pool for the format
    const pool = await fetchPlayerPool(c.env.DB, challenge.format, 50);

    // Instantiate unique Durable Object room
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const doId = c.env.DRAFT_ROOM.idFromName(roomId);
    const stub = c.env.DRAFT_ROOM.get(doId);

    const initState = {
      roomId,
      challenge,
      pool,
      userPicks: [],
      aiPicks: [],
      currentTurn: "USER",
      round: 1,
      maxRounds: 6, // 6 rounds of alternate draft picks, remaining 5 chosen solo
      status: "DRAFTING",
      lastActionTimestamp: Date.now(),
    };

    // Initialize state inside the Durable Object
    const initRes = await stub.fetch(
      new Request(`http://internal/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initState),
      })
    );

    if (!initRes.ok) {
      return c.json({ error: "Failed to initialize draft room state" }, 500);
    }

    return c.json({
      success: true,
      roomId,
      challenge,
      poolSize: pool.length,
    });
  } catch (err: any) {
    console.error("[API] Failed to start draft room:", err);
    return c.json({ error: err.message || "Failed to start draft room" }, 500);
  }
});

// Durable Object Proxy (HTTP & WebSocket upgrades)
app.all("/api/room/:roomId/*", async (c) => {
  const roomId = c.req.param("roomId");
  const doId = c.env.DRAFT_ROOM.idFromName(roomId);
  const stub = c.env.DRAFT_ROOM.get(doId);

  const url = new URL(c.req.url);
  const doPath = url.pathname.replace(`/api/room/${roomId}`, "") || "/";
  const doUrl = new URL(doPath + url.search, url.origin);

  return stub.fetch(new Request(doUrl.toString(), c.req.raw));
});

export default app;
