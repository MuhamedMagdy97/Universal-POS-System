import "server-only";
import type { Prisma } from "@/lib/generated/prisma/client";
import { lockProducts } from "@/modules/catalog/seam";

/**
 * Balance-row locking (inventory D7). Every write locks its StockBalance rows in one global
 * order, `(branchId, productId, variantId NULLS FIRST)`, so two transactions over the same
 * rows always acquire them in the same order and cannot deadlock.
 */

export type LockKey = { branchId: string; productId: string; variantId: string | null };

/** Stable key for a balance row, shared by the lock map and the callers. */
export function keyOf(k: LockKey): string {
  return `${k.branchId}|${k.productId}|${k.variantId ?? ""}`;
}

/** Sorts the keys into lock order and removes duplicates. Pure, so it can be tested without a DB. */
export function lockOrder(keys: readonly LockKey[]): LockKey[] {
  const unique = new Map<string, LockKey>();
  for (const k of keys) unique.set(keyOf(k), { branchId: k.branchId, productId: k.productId, variantId: k.variantId });
  return [...unique.values()].sort((a, b) => {
    if (a.branchId !== b.branchId) return a.branchId < b.branchId ? -1 : 1;
    if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
    if (a.variantId === b.variantId) return 0;
    if (a.variantId === null) return -1;
    if (b.variantId === null) return 1;
    return a.variantId < b.variantId ? -1 : 1;
  });
}

export type LockedBalance = { id: string; qty: number };

/**
 * Ensures each balance row exists (`INSERT … ON CONFLICT DO NOTHING`) and then locks it
 * (`SELECT … FOR UPDATE`), in lock order. Returns the locked rows keyed by `keyOf`.
 */
export async function lockBalances(
  tx: Prisma.TransactionClient,
  orgId: string,
  keys: readonly LockKey[],
): Promise<Map<string, LockedBalance>> {
  // Product rows first, so every writer takes its locks in the same order (checkout R1).
  await lockProducts(
    tx,
    orgId,
    keys.map((k) => k.productId),
  );
  const locked = new Map<string, LockedBalance>();
  for (const k of lockOrder(keys)) {
    await tx.$executeRaw`
      INSERT INTO "StockBalance" ("id", "orgId", "branchId", "productId", "variantId", "qty", "updatedAt")
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${k.branchId}::uuid, ${k.productId}::uuid, ${k.variantId}::uuid, 0, now())
      ON CONFLICT DO NOTHING`;
    const rows = await tx.$queryRaw<LockedBalance[]>`
      SELECT "id", "qty" FROM "StockBalance"
      WHERE "orgId" = ${orgId}::uuid AND "branchId" = ${k.branchId}::uuid AND "productId" = ${k.productId}::uuid
        AND "variantId" IS NOT DISTINCT FROM ${k.variantId}::uuid
      FOR UPDATE`;
    locked.set(keyOf(k), rows[0]);
  }
  return locked;
}
