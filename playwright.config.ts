import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT, e2eDatabaseUrl } from "./tests/e2e/support/env";

/**
 * E2E runs against `next start` on its own port with its own database
 * (E2E_DATABASE_URL, catalog Q13), so it never touches dev data. The global
 * setup migrates and seeds that database; the `setup` project signs the seeded
 * users in once and saves their sessions under playwright/.auth.
 */
const databaseUrl = e2eDatabaseUrl();

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: `npm run start -- --port ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    // Never attach to a server we did not start: it could be using another database.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: databaseUrl,
      AUTH_URL: E2E_BASE_URL,
      PORT: String(E2E_PORT),
    },
  },
});
