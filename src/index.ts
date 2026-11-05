import { Hono } from "hono";
import { cors } from "hono/cors";
import { DraftRoom } from "./durable-objects/DraftRoom";
import { generateValidatedChallenge, fetchPlayerPool, DRAFT_POOL_SIZE } from "./worker/challenge-generator";
import { checkDraftFeasibility } from "./core/validator";
import type { PlayerWithStats } from "./core/types";
import type { Challenge, MatchFormat } from "./core/types";

export { DraftRoom };

export interface Env {
  DB: D1Database;
  DRAFT_ROOM: DurableObjectNamespace;
  AI?: any;
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
    let pool: PlayerWithStats[];

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

      // Stored challenges may predate the current pool: re-check head-to-head playability
      pool = await fetchPlayerPool(c.env.DB, challenge.format, DRAFT_POOL_SIZE);
      const feasibility = checkDraftFeasibility(pool, challenge, 1);
      if (!feasibility.isFeasible) {
        return c.json({ error: `Challenge is not playable with the current player pool: ${feasibility.reasons.join("; ")}` }, 409);
      }
    } else {
      // Auto-generate a challenge if not supplied; reuse the exact pool it was validated against
      const generated = await generateValidatedChallenge(c.env, { format: body.format });
      challenge = generated.challenge;
      pool = generated.pool;
    }

    // Instantiate unique Durable Object room
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const doId = c.env.DRAFT_ROOM.idFromName(roomId);
    const stub = c.env.DRAFT_ROOM.get(doId);

    const initState = {
      roomId,
      challenge,
      pool,
      userPicks: Array(11).fill(null),
      aiPicks: Array(11).fill(null),
      currentTurn: "USER",
      round: 1,
      maxRounds: 11,
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

  // Room initialization is internal-only (done by /api/draft/start); never expose it publicly.
  if (doPath.endsWith("/init")) {
    return c.json({ error: "Not found" }, 404);
  }
  const doUrl = new URL(doPath + url.search, url.origin);

  return stub.fetch(new Request(doUrl.toString(), c.req.raw));
});

export default app;
