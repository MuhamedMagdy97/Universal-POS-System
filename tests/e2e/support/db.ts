import { Client } from "pg";
import { e2eDatabaseUrl } from "./env";

/** Runs one query against the E2E database (short-lived connection; specs run in parallel workers). */
export async function e2eQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * The app has no organization picker yet: sign-in leaves `activeOrganizationId`
 * empty, so the tenant guard denies everything. Until the org switcher lands,
 * the E2E harness activates each seeded user's (single) membership on their
 * sessions, as an org picker would.
 */
export async function activateOrganization(email: string): Promise<void> {
  await e2eQuery(
    `UPDATE "Session" s SET "activeOrganizationId" = m."orgId", "updatedAt" = now()
       FROM "User" u JOIN "Membership" m ON m."userId" = u."id" AND m."isActive"
      WHERE s."userId" = u."id" AND u."email" = $1 AND s."activeOrganizationId" IS NULL`,
    [email],
  );
}

/** Login is rate limited (5/min per IP); the harness signs several users in from one IP. */
export async function resetLoginRateLimit(): Promise<void> {
  await e2eQuery(`DELETE FROM "RateLimit"`);
}

export async function productIdBySku(orgId: string, sku: string): Promise<string> {
  const rows = await e2eQuery<{ id: string }>(`SELECT "id" FROM "Product" WHERE "orgId" = $1 AND "sku" = $2`, [
    orgId,
    sku,
  ]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`No product ${sku} in org ${orgId}`);
  return id;
}

export async function countProductsBySku(orgId: string, sku: string): Promise<number> {
  const rows = await e2eQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM "Product" WHERE "orgId" = $1 AND "sku" = $2`,
    [orgId, sku],
  );
  return rows[0]?.n ?? 0;
}
