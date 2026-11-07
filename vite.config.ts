import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The game UI lives in web/ and builds to dist/, which the Worker serves as static assets
// (wrangler.jsonc "assets"). `npm run dev:web` serves the UI with hot reload and sends /api to
// a running `wrangler dev` on port 8787.
export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: { outDir: "../dist", emptyOutDir: true, target: "es2020" },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
