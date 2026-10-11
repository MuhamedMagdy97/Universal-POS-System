import { config } from "dotenv";

config({ quiet: true });

/** Port of the app server Playwright starts. Never 3000, so a dev server is never reused. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/** host:port/database, so two URLs that differ only in credentials or params still compare equal. */
function databaseKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`.toLowerCase();
}

/**
 * The dedicated E2E database. Refuses to run when it is missing or points at the
 * development or integration-test database: the seed writes to it and the specs
 * create products in it.
 */
export function e2eDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.E2E_DATABASE_URL;
  if (!url) {
    throw new Error("E2E_DATABASE_URL is not set. Add it to .env (see .env.example) to run the E2E suite.");
  }
  const key = databaseKey(url);
  for (const other of ["DATABASE_URL", "TEST_DATABASE_URL"] as const) {
    const value = env[other];
    if (value && databaseKey(value) === key) {
      throw new Error(`E2E_DATABASE_URL must point to a different database than ${other}.`);
    }
  }
  return url;
}
