import "server-only";
import type { Db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { ItemRef } from "./types";
import { keyOf } from "./locking";

/**
 * Read-only inventory queries used across modules. This file imports nothing from
 * modules/catalog: catalog imports it for the variant guard, so the graph stays acyclic.
 */

export type InventoryClient = Db | Prisma.TransactionClient;

/** True if the product has stock or ledger rows that are not tied to a variant (catalog TODO(T4)). */
export async function hasUnvariantedStock(client: InventoryClient, orgId: string, productId: string): Promise<boolean> {
  const balance = await client.stockBalance.findFirst({
    where: { orgId, productId, variantId: null, qty: { not: 0 } },
    select: { id: true },
  });
  if (balance) return true;
  const movement = await client.inventoryMovement.findFirst({
    where: { orgId, productId, variantId: null },
    select: { id: true },
  });
  return movement !== null;
}

/** On-hand quantities at one branch, in the same order as `refs`. Items with no balance row are 0. */
export async function getOnHand(
  client: InventoryClient,
  orgId: string,
  branchId: string,
  refs: readonly ItemRef[],
): Promise<number[]> {
  if (refs.length === 0) return [];
  const productIds = [...new Set(refs.map((ref) => ref.productId))];
  const rows = await client.stockBalance.findMany({
    where: { orgId, branchId, productId: { in: productIds } },
    select: { productId: true, variantId: true, qty: true },
  });
  const byKey = new Map(
    rows.map((row) => [keyOf({ branchId, productId: row.productId, variantId: row.variantId }), row.qty]),
  );
  return refs.map((ref) => byKey.get(keyOf({ branchId, productId: ref.productId, variantId: ref.variantId })) ?? 0);
}
