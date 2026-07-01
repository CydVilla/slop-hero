import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest is used for the pure game-logic unit tests (scoring, timing, charting,
 * hold/sustain rules). Those modules are framework-agnostic, so the default
 * Node environment is enough — no jsdom needed. The `@/` alias mirrors the one
 * in tsconfig.json so tests import modules exactly like the app does.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
