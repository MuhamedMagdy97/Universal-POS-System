import { execFileSync } from "node:child_process";
import { seedE2E } from "../../prisma/seed-e2e";
import { e2eDatabaseUrl } from "./support/env";

/**
 * Prepares the dedicated E2E database (catalog Q13): guard → migrate → seed.
 * Refuses to run against the development or integration-test database.
 */
export default async function globalSetup() {
  const url = e2eDatabaseUrl();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  await seedE2E(url);
}
