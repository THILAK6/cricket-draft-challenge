import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, extname, resolve } from "node:path";
import { d1 } from "../support/db";
import app from "../../src/index";
import { DraftRoom } from "../../src/durable-objects/DraftRoom";

/**
 * Phone check (U.11): builds the UI, serves it with the real API and draft room (test database),
 * and plays a full draft on an emulated iPhone. Fails if a "Draft" tap is refused, if anything has
 * to be dismissed to keep drafting, or if any screen scrolls sideways at phone width.
 * Skipped when Playwright isn't installed.
 */
const require = createRequire(import.meta.url);
let playwright: any = null;
try {
  playwright = require("playwright");
} catch {
  playwright = null;
}

const DIST = resolve("dist");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function fakeRoomNamespace(roomEnv: () => unknown) {
  const rooms = new Map<string, DraftRoom>();
  const store = () => {
    const m = new Map<string, unknown>();
    return { storage: { get: async (k: string) => (m.has(k) ? structuredClone(m.get(k)) : undefined), put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) } } as any;
  };
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!rooms.has(id)) rooms.set(id, new DraftRoom(store(), roomEnv()));
      return rooms.get(id)!;
    },
  };
}

const DB = { prepare: (sql: string) => ({ bind: (...a: unknown[]) => ({ ...(d1.prepare(sql) as any).bind(...a), run: async () => ({}), first: async () => null }) }) };
// Rooms get the database too: they build their own drafts
const env = { DB, DRAFT_ROOM: fakeRoomNamespace(() => ({ DB })) };

let server: Server;
let base = "";

describe.skipIf(!playwright)("phone playthrough", () => {
  beforeAll(async () => {
    const { build } = await import("vite");
    await build({ configFile: resolve("vite.config.ts"), logLevel: "error" });
    server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://local");
      if (url.pathname.startsWith("/api/")) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const r: Response = await app.fetch(new Request(url, { method: req.method, headers: req.headers as any, body: req.method === "GET" ? undefined : body }), env as any);
        res.writeHead(r.status, { "Content-Type": r.headers.get("Content-Type") || "application/json" });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const file = join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
      const path = existsSync(file) ? file : join(DIST, "index.html");
      res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(readFileSync(path));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  }, 120_000);

  afterAll(() => server?.close());

  for (const format of ["T20", "TEST"] as const) {
    it(`${format}: a full draft takes one tap per pick, with no sideways scrolling`, async () => {
      const browser = await playwright.chromium.launch();
      const ctx = await browser.newContext({ ...playwright.devices["iPhone 13"] });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      // Runs in the browser page (the test itself has no DOM types)
      const overflow = () => page.evaluate("document.documentElement.scrollWidth - window.innerWidth");
      try {
        await page.goto(base);
        expect(await overflow()).toBe(0);
        if (format === "TEST") await page.click("button.choice:has-text('Test')");
        await page.click("text=Next: the ground and the toss");
        await page.waitForSelector("text=Start drafting");
        expect(await overflow()).toBe(0);
        await page.click("text=Start drafting");
        await page.waitForSelector(".prow");
        expect(await overflow()).toBe(0);

        let taps = 0;
        for (let guard = 0; guard < 15 && !(await page.$("text=Play the match")); guard++) {
          const draft = page.locator(".prow .pick").first();
          await draft.click();
          taps++;
          await page.waitForTimeout(150);
          expect(await page.$(".toast.error"), "a Draft tap was refused").toBeNull();
          expect(await page.$('[aria-modal="true"]'), "something must be dismissed to keep drafting").toBeNull();
        }
        await page.waitForSelector("text=Play the match");
        expect(taps).toBe(11);
        expect(await overflow()).toBe(0);
        // Drag the opener down two places by his handle
        const names = () => page.$$eval(".lineup-list .xrow .who b", (els: any[]) => els.map((e) => e.textContent));
        const before = await names();
        const grip = page.locator(".lineup-list .grip").first();
        // The batting-order screen opens at the top
        expect(await page.evaluate("window.scrollY")).toBe(0);
        const box = (await grip.boundingBox())!;
        const rowH = (await page.locator(".lineup-list .xrow").first().boundingBox())!.height;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        for (let s = 1; s <= 8; s++) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + (2 * rowH * s) / 8);
        if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `drag-${format}.png`) });
        const saved = page.waitForResponse((r: any) => r.url().includes("/reorder"));
        await page.mouse.up();
        await saved;
        await page.waitForTimeout(100);
        const after = await names();
        expect(after[2]).toBe(before[0]);
        expect(after[0]).toBe(before[1]);
        expect(await overflow()).toBe(0);
        await page.click("summary:has-text('Bowling plan')");
        expect(await overflow()).toBe(0);
        await page.click("text=Play the match");
        await page.waitForSelector(".scorehead", { timeout: 20_000 });
        expect(await overflow()).toBe(0);
        // Result: how often this XI wins, then the head-to-head, with the scorecards closed
        await page.waitForSelector("text=Head to head");
        expect(await page.locator(".h2h .row").count()).toBe(format === "T20" ? 10 : 8);
        expect(await page.locator(".chance").count()).toBe(1);
        expect(await page.locator("details.box[open]").count()).toBe(0);
        await page.click("summary:has-text('Scorecards')");
        expect(await overflow()).toBe(0);
        if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `result-${format}.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    }, 120_000);
  }
});
