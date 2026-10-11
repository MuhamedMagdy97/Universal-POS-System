import { e2eQuery } from "./db";

/**
 * Per-run fixtures for the till specs. Each run gets its own register (one open shift per
 * register) and its own stocked product, so parallel workers and earlier runs never collide.
 */

export async function createRunRegister(orgId: string, branchId: string, name: string): Promise<string> {
  const rows = await e2eQuery<{ id: string }>(
    `INSERT INTO "Register" ("id", "orgId", "branchId", "name", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, true, now(), now())
     RETURNING "id"`,
    [orgId, branchId, name],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`could not create register ${name}`);
  return id;
}

/** Opening stock written the way the ledger does: one OPENING_BALANCE row plus its balance row. */
export async function openRunStock(
  orgId: string,
  branchId: string,
  productId: string,
  qty: number,
  actorEmail: string,
): Promise<void> {
  await e2eQuery(
    `WITH actor AS (SELECT "id" FROM "User" WHERE "email" = $5)
     INSERT INTO "InventoryMovement" ("id", "orgId", "branchId", "productId", "variantId", "qtyDelta", "reason",
                                      "actorUserId", "createdAt")
     SELECT gen_random_uuid(), $1, $2, $3, NULL, $4, 'OPENING_BALANCE', actor."id", now() FROM actor`,
    [orgId, branchId, productId, qty, actorEmail],
  );
  await e2eQuery(
    `INSERT INTO "StockBalance" ("id", "orgId", "branchId", "productId", "variantId", "qty", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, NULL, $4, now())`,
    [orgId, branchId, productId, qty],
  );
}

export async function onHand(orgId: string, branchId: string, productId: string): Promise<number> {
  const rows = await e2eQuery<{ qty: number }>(
    `SELECT "qty" FROM "StockBalance" WHERE "orgId" = $1 AND "branchId" = $2 AND "productId" = $3 AND "variantId" IS NULL`,
    [orgId, branchId, productId],
  );
  return rows[0]?.qty ?? 0;
}
