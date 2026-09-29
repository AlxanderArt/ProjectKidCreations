import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:4173";
const parsedBase = new URL(baseURL);
if (parsedBase.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsedBase.hostname)) {
  throw new Error("PLAYWRIGHT_BASE_URL must be loopback HTTP");
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  retries: process.env.CI ? 2 : 1,
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-webkit",
      use: { ...devices["iPhone 14"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: "env -u VERCEL -u VERCEL_ENV -u VERCEL_URL -u VERCEL_PROJECT_ID -u VERCEL_ORG_ID node scripts/playwright-local-server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
