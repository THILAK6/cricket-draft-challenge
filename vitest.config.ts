import { defineConfig } from "vitest/config";

// Tests run from the repo root; vite.config.ts (root: web/) is only for building the UI.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
