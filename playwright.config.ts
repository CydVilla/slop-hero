import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke tests for layouts that unit tests can't see: the iPhone Duo's
 * screen shapes (folded, open, Split View), fold postures emulated through
 * Chromium's Device Posture override and stubbed viewport segments, and the
 * two-player split. Runs against a production build (`npm run build` first).
 */
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], hasTouch: true } }],
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
