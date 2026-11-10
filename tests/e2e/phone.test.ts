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

// The in-memory database, saves included (so the e2e can reopen a saved match)
const DB = {
  prepare: (sql: string) => ({ ...(d1.prepare(sql) as any), bind: (...a: unknown[]) => ({ ...(d1.prepare(sql) as any).bind(...a), first: async () => null }) }),
  batch: (d1 as any).batch,
};
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

  for (const format of ["T20", "TEST", "IPL"] as const) {
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
        if (format === "IPL") {
          await page.click("button.choice:has-text('IPL')");
          // The league's own pool themes
          expect(await page.locator(".themes button:has-text('IPL legends')").count()).toBe(1);
          expect(await page.locator(".themes button:has-text('The Ashes')").count()).toBe(0);
          if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, 'setup-IPL.png'), fullPage: true });
        }
        await page.click("text=Next: the ground and the toss");
        await page.waitForSelector("text=Start drafting");
        if (format === "IPL") {
          // The franchise rule is on the briefing, and the match is the IPL's
          expect(await page.locator("text=/overseas/i").count()).toBeGreaterThan(0);
          expect(await page.locator("text=/IPL/").count()).toBeGreaterThan(0);
        }
        expect(await overflow()).toBe(0);
        await page.click("text=Start drafting");
        await page.waitForSelector(".prow");
        expect(await overflow()).toBe(0);

        let taps = 0;
        let movedName = "";
        for (let guard = 0; guard < 15 && !(await page.$("text=Play the match")); guard++) {
          const draft = page.locator(".prow .pick").first();
          await draft.click();
          taps++;
          if (taps === 4) {
            // Mid-draft: drag the first player in Your XI down two spots, then carry on drafting
            await page.click(".tabbar button:has-text('Your XI')");
            const rows = () => page.$$eval(".side-panel.m-on .xi .xrow", (els: any[]) => els.map((e) => (e.querySelector(".who b")?.textContent ?? "")));
            if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `draft-xi-${format}.png`) });
            const before = await rows();
            const from = before.findIndex((n: string) => n);
            movedName = before[from];
            const grip = page.locator(".side-panel.m-on .xi .grip").first();
            const box = (await grip.boundingBox())!;
            // Aim at the middle of the row two places down (rows differ in height)
            const target = (await page.locator(".side-panel.m-on .xi .xrow").nth(from + 2).boundingBox())!;
            const gripY = box.y + box.height / 2, aimY = target.y + target.height / 2;
            await page.mouse.move(box.x + box.width / 2, gripY);
            await page.mouse.down();
            for (let s = 1; s <= 8; s++) await page.mouse.move(box.x + box.width / 2, gripY + ((aimY - gripY) * s) / 8);
            const saved = page.waitForResponse((r: any) => r.url().includes("/reorder"));
            await page.mouse.up();
            await saved;
            await page.waitForTimeout(100);
            const after = await rows();
            expect(after.indexOf(movedName), "the dragged player moved down two spots").toBe(from + 2);
            expect(await overflow()).toBe(0);
            await page.click(".tabbar button:has-text('Pool')");
          }
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
        // The order set mid-draft survived the rest of the draft (the batting order screen opens as he left it)
        expect(before.indexOf(movedName), "the order set during the draft is kept").toBeGreaterThanOrEqual(0);
        const grip = page.locator(".lineup-list .grip").first();
        // The batting-order screen opens at the top
        expect(await page.evaluate("window.scrollY")).toBe(0);
        const box = (await grip.boundingBox())!;
        const aim = (await page.locator(".lineup-list .xrow").nth(2).boundingBox())!;
        const gy = box.y + box.height / 2, ay = aim.y + aim.height / 2;
        await page.mouse.move(box.x + box.width / 2, gy);
        await page.mouse.down();
        for (let s = 1; s <= 8; s++) await page.mouse.move(box.x + box.width / 2, gy + ((ay - gy) * s) / 8);
        if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `drag-${format}.png`) });
        const saved = page.waitForResponse((r: any) => r.url().includes("/reorder"));
        await page.mouse.up();
        await saved;
        await page.waitForTimeout(100);
        const after = await names();
        expect(after[2]).toBe(before[0]);
        expect(after[0]).toBe(before[1]);
        expect(await overflow()).toBe(0);
        // No bowling plan to fill in: the captain picks bowlers from their records
        expect(await page.locator("summary:has-text('Bowling plan')").count()).toBe(0);
        expect(await overflow()).toBe(0);
        await page.click("text=Play the match");
        await page.waitForSelector(".scorehead", { timeout: 20_000 });
        expect(await overflow()).toBe(0);
        // Result: how often this XI wins, then the head-to-head, with the scorecards closed
        await page.waitForSelector("text=Head to head");
        expect(await page.locator(".h2h .row").count()).toBe(format === "TEST" ? 8 : 10);
        expect(await page.locator(".chance").count()).toBe(1);
        // Head to head: every area closed, each with who leads; one tap opens it
        expect(await page.locator(".h2h details.row[open]").count()).toBe(0);
        expect(await page.locator(".h2h .lead").count()).toBe(format === "TEST" ? 8 : 10);
        await page.click(".h2h details.row summary >> nth=0");
        expect(await page.locator(".h2h details.row[open]").count()).toBe(1);
        await page.click(".h2h details.row summary >> nth=0");
        // The draft comes first; the player of the match is below the scorecards
        const y = async (sel: string) => (await page.locator(sel).first().boundingBox())?.y ?? -1;
        if (await page.locator(".draft-card").count()) expect(await y(".draft-card")).toBeLessThan(await y(".chance"));
        expect(await y("details.box:has(summary:text('Scorecards'))")).toBeLessThan(await y(".potm"));
        expect(await y(".chance")).toBeLessThan(await y(".h2h"));
        expect(await page.locator("details.box[open]").count()).toBe(0);
        await page.click("summary:has-text('Scorecards')");
        expect(await overflow()).toBe(0);
        // The typical card: every player averaged over the replays, for either side
        await page.click("button:has-text('Typical')");
        expect(await page.locator("table.sc").count()).toBe(2);
        expect(await page.locator("table.sc tbody tr").count()).toBeGreaterThanOrEqual(12);
        expect(await overflow()).toBe(0);
        if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `typical-${format}.png`), fullPage: true });
        await page.click(".tabs2 button:has-text('AI XI')");
        expect(await page.locator("table.sc").count()).toBe(2);
        expect(await overflow()).toBe(0);
        await page.click(".tabs2 button:has-text('Your XI')");
        if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `result-${format}.png`), fullPage: true });
        // The match is saved: it can be shared, and reopened from My matches on the start screen
        expect(await page.locator("text=Share this match").count()).toBe(1);
        const headline = await page.locator(".verdict h2").textContent();
        await page.click("text=New game");
        await page.waitForSelector(".mymatches li");
        expect(await page.locator(".mymatches li").count()).toBe(1);
        expect(await overflow()).toBe(0);
        if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `mymatches-${format}.png`) });
        await page.click(".mymatches button");
        await page.waitForSelector(".saved-head");
        expect(page.url()).toMatch(/\?match=[a-z2-9]{10}$/);
        expect(await page.locator(".verdict h2").textContent()).toBe(headline);
        expect(await page.locator(".h2h .row").count()).toBe(format === "TEST" ? 8 : 10);
        expect(await overflow()).toBe(0);
        // The link works on its own, as a friend would open it
        const link = page.url();
        const friend = await browser.newContext({ ...playwright.devices["iPhone 13"] });
        const fp = await friend.newPage();
        await fp.goto(link);
        await fp.waitForSelector(".saved-head");
        expect(await fp.locator(".verdict h2").textContent()).toBe(headline);
        await fp.click("text=Back");
        await fp.waitForSelector("text=Next: the ground and the toss");
        expect(await fp.locator(".mymatches li").count()).toBe(0);
        await friend.close();
        // Back returns to the start screen
        await page.click("text=Back");
        await page.waitForSelector("text=Next: the ground and the toss");
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    }, 120_000);
  }

  for (const bidder of ["Calculated", "Impulsive"] as const) {
    it(`IPL auction (${bidder} rival): bid through the lots, fill the XI, play the match`, async () => {
      const browser = await playwright.chromium.launch();
      const ctx = await browser.newContext({ ...playwright.devices["iPhone 13"] });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      const overflow = () => page.evaluate("document.documentElement.scrollWidth - window.innerWidth");
      try {
        await page.goto(base);
        await page.click("button.choice:has-text('IPL')");
        await page.click(".seg button:has-text('Auction')");
        await page.click(`.seg button:has-text('${bidder}')`);
        expect(await page.locator("text=/carried away|never pays more/").count()).toBeGreaterThan(0);
        if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `auction-setup-${bidder}.png`), fullPage: true });
        await page.click("text=Next: the ground and the toss");
        await page.waitForSelector("text=Start the auction");
        expect(await page.locator("text=/crore/").count()).toBeGreaterThan(0);
        expect(await overflow()).toBe(0);
        await page.click("text=Start the auction");
        await page.waitForSelector(".lot");
        expect(await overflow()).toBe(0);
        let shot = false;
        for (let guard = 0; guard < 160 && !(await page.$("text=Play the match")); guard++) {
          await page.waitForSelector(".bid-bar, :text('Play the match')", { timeout: 15_000 });
          if (await page.$("text=Play the match")) break;
          if (process.env.SHOTS && !shot && guard === 3) {
            await page.screenshot({ path: join(process.env.SHOTS, `auction-${bidder}.png`) });
            shot = true;
          }
          // Bid whenever it is allowed (the room refuses when you cannot afford it), otherwise pass
          const bid = page.locator(".bid-bar .btn-primary");
          const respond = page.waitForResponse((r: any) => r.url().includes("/bid"));
          if (await bid.isEnabled()) await bid.click();
          else await page.click(".bid-bar .btn:not(.btn-primary)");
          await respond;
          expect(await page.$(".toast.error"), "a bid was refused").toBeNull();
        }
        await page.waitForSelector("text=Play the match");
        expect(await overflow()).toBe(0);
        await page.click("text=Play the match");
        await page.waitForSelector(".scorehead", { timeout: 30_000 });
        await page.waitForSelector("text=Head to head");
        // The auction's awards are about money
        expect(await page.locator(".draft-card").count()).toBe(1);
        expect(await page.locator("text=/crore/").count()).toBeGreaterThan(0);
        expect(await overflow()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    }, 180_000);
  }
});
