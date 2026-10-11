import "server-only";
import { Prisma } from "@/lib/generated/prisma/client";
import type { InventoryClient } from "./queries";
import type { ItemRef } from "./types";

export type Mismatch = { branchId: string; ref: ItemRef; cached: number; ledger: number };

/**
 * Compares each StockBalance cache with the sum of its ledger rows. Returns only mismatches,
 * including ledger totals that have no balance row. Read-only: it never repairs anything.
 */
export async function reconcile(client: InventoryClient, orgId: string, branchId?: string): Promise<Mismatch[]> {
  const branchFilter = branchId ? Prisma.sql`AND "branchId" = ${branchId}::uuid` : Prisma.empty;
  const rows = await client.$queryRaw<
    { branchId: string; productId: string; variantId: string | null; cached: number; ledger: number }[]
  >`
    WITH ledger AS (
      SELECT "branchId", "productId", "variantId", SUM("qtyDelta")::int AS total
      FROM "InventoryMovement"
      WHERE "orgId" = ${orgId}::uuid ${branchFilter}
      GROUP BY "branchId", "productId", "variantId"
    ), cached AS (
      SELECT "branchId", "productId", "variantId", "qty"
      FROM "StockBalance"
      WHERE "orgId" = ${orgId}::uuid ${branchFilter}
    )
    SELECT COALESCE(c."branchId", l."branchId") AS "branchId",
           COALESCE(c."productId", l."productId") AS "productId",
           COALESCE(c."variantId", l."variantId") AS "variantId",
           COALESCE(c."qty", 0) AS "cached",
           COALESCE(l."total", 0) AS "ledger"
    FROM cached c
    FULL OUTER JOIN ledger l
      ON c."branchId" = l."branchId" AND c."productId" = l."productId"
     AND c."variantId" IS NOT DISTINCT FROM l."variantId"
    WHERE COALESCE(c."qty", 0) <> COALESCE(l."total", 0)`;
  return rows.map((row) => ({
    branchId: row.branchId,
    ref: { productId: row.productId, variantId: row.variantId },
    cached: Number(row.cached),
    ledger: Number(row.ledger),
  }));
}
