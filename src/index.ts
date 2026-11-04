import { Hono } from "hono";
import { DraftRoom } from "./durable-objects/DraftRoom";

export { DraftRoom };

export interface Env {
  DB: D1Database;
  DRAFT_ROOM: DurableObjectNamespace;
  AI: any;
}

const app = new Hono<{ Bindings: Env }>();

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "healthy", service: "cricket-draft-challenge" });
});

// Challenges list
app.get("/api/challenges", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, format, venue_name, venue_country, pitch_type, title, narrative_intro FROM challenges ORDER BY created_at DESC LIMIT 10"
  ).all();
  return c.json({ challenges: results });
});

// Draft Room proxy to Durable Object
app.all("/api/room/:roomId/*", async (c) => {
  const roomId = c.req.param("roomId");
  const id = c.env.DRAFT_ROOM.idFromName(roomId);
  const stub = c.env.DRAFT_ROOM.get(id);

  const url = new URL(c.req.url);
  // Strip /api/room/:roomId prefix for the DO
  const doPath = url.pathname.replace(`/api/room/${roomId}`, "") || "/";
  const doUrl = new URL(doPath + url.search, url.origin);

  return stub.fetch(new Request(doUrl.toString(), c.req.raw));
});

export default app;

