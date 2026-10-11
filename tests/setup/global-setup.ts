import { execFileSync } from "node:child_process";
import { config } from "dotenv";

/**
 * Applies all migrations to the test database before any test runs.
 * Integration tests are mandatory: a missing TEST_DATABASE_URL fails the run.
 */
export default function setup() {
  config({ quiet: true });
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is not set. Add it to .env (see .env.example) to run the test suite.");
  }
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL must point to a different database than DATABASE_URL.");
  }
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}
