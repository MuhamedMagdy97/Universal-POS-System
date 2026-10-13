/**
 * Development seed: loads the E2E demo shops into the local development database (DATABASE_URL)
 * so the app can be used by hand before shop onboarding exists. Adds what the E2E specs create
 * per run: a till per shop and opening stock for every active item.
 *
 * Run: `npm run db:seed:dev`. Idempotent. Logins and their throwaway passwords are the E2E_USERS
 * in prisma/seed-e2e.ts. Refuses any database that is not on this machine, or that is the
 * integration-test or E2E database.
 */
import { config } from "dotenv";
import { Client } from "pg";
import { E2E_ORGS, E2E_USERS, seedE2E } from "./seed-e2e";

config({ quiet: true });

const DEV_REGISTERS = {
  A: "de70a000-0000-4000-8000-0000000000f1",
  B: "de70b000-0000-4000-8000-0000000000f1",
} as const;
const OPENING_QTY = 100;

/** CLI output (the app logger is for the server). */
const say = (line: string) =>
  process.stdout.write(`${line}
`);

function databaseKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`.toLowerCase();
}

function devDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see .env.example).");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Refusing to seed ${host}: the dev seed only runs against a database on this machine.`);
  }
  for (const other of ["TEST_DATABASE_URL", "E2E_DATABASE_URL"] as const) {
    const value = process.env[other];
    if (value && databaseKey(value) === databaseKey(url)) {
      throw new Error(`DATABASE_URL is the same database as ${other}; refusing to seed it.`);
    }
  }
  return url;
}

async function main() {
  const url = devDatabaseUrl();
  await seedE2E(url);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const key of ["A", "B"] as const) {
      const org = E2E_ORGS[key];
      await client.query(
        `INSERT INTO "Register" ("id", "orgId", "branchId", "name", "isActive", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'Till 1', true, now(), now())
         ON CONFLICT ("id") DO UPDATE SET "isActive" = true, "updatedAt" = now()`,
        [DEV_REGISTERS[key], org.id, org.branchId],
      );
      const actor = Object.values(E2E_USERS).find((user) => user.org === key)?.email;
      // Opening stock for each active sellable item that has no balance yet (a re-run adds nothing).
      const items = `
        SELECT p."id" AS "productId", NULL::uuid AS "variantId" FROM "Product" p
         WHERE p."orgId" = $1 AND p."isActive" AND NOT p."hasVariants"
        UNION ALL
        SELECT v."productId", v."id" FROM "ProductVariant" v JOIN "Product" p ON p."id" = v."productId"
         WHERE v."orgId" = $1 AND v."isActive" AND p."isActive"`;
      const missing = `
        WITH items AS (${items})
        SELECT i.* FROM items i
         WHERE NOT EXISTS (SELECT 1 FROM "StockBalance" b WHERE b."orgId" = $1 AND b."branchId" = $2
                             AND b."productId" = i."productId" AND b."variantId" IS NOT DISTINCT FROM i."variantId")`;
      const { rows } = await client.query<{ productId: string; variantId: string | null }>(missing, [
        org.id,
        org.branchId,
      ]);
      for (const row of rows) {
        await client.query(
          `INSERT INTO "InventoryMovement" ("id", "orgId", "branchId", "productId", "variantId", "qtyDelta", "reason",
                                            "actorUserId", "createdAt")
           SELECT gen_random_uuid(), $1, $2, $3, $4, $5, 'OPENING_BALANCE', u."id", now() FROM "User" u WHERE u."email" = $6`,
          [org.id, org.branchId, row.productId, row.variantId, OPENING_QTY, actor],
        );
        await client.query(
          `INSERT INTO "StockBalance" ("id", "orgId", "branchId", "productId", "variantId", "qty", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
          [org.id, org.branchId, row.productId, row.variantId, OPENING_QTY],
        );
      }
      say(`${org.name}: till ready, opening stock added for ${rows.length} item(s).`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
  say("Logins (passwords in prisma/seed-e2e.ts, E2E_USERS):");
  for (const user of Object.values(E2E_USERS)) say(`  ${user.role.padEnd(9)} ${user.email}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err instanceof Error ? (err.stack ?? err.message) : err)}
`);
  process.exit(1);
});
