import "server-only";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { InventorySource, Prisma } from "@/lib/generated/prisma/client";

/**
 * The one place other modules ask "does this shop use the inventory system?" (integration spec I1, I18).
 * Imported straight from this file (not the barrel) so catalog, inventory and purchasing do not
 * pull in the sync, which itself depends on catalog.
 */

type Client = Pick<Prisma.TransactionClient, "organization">;

export async function inventorySourceOf(orgId: string, client: Client = getDb()): Promise<InventorySource> {
  const org = await client.organization.findUnique({ where: { id: orgId }, select: { inventorySource: true } });
  return org?.inventorySource ?? "BUILT_IN";
}

/** 409 `MANAGED_BY_INVENTORY`: the change belongs in the inventory system. `fields` names what was refused. */
export function managedByInventory(fields: string[] = []): AppError {
  return new AppError("CONFLICT", "This is managed in the inventory system", {
    reason: "MANAGED_BY_INVENTORY",
    ...(fields.length > 0 ? { fields } : {}),
  });
}

/** Refuses a stock, catalog or purchasing write for a shop linked to the inventory system. */
export async function assertBuiltIn(orgId: string, client?: Client): Promise<void> {
  if ((await inventorySourceOf(orgId, client)) === "EXTERNAL") throw managedByInventory();
}

/**
 * For edits that may touch POS-owned fields (Arabic name, VAT category, category: spec I8) when linked:
 * refuses only if a synced field actually changes.
 */
export async function assertSyncedFieldsUnchanged(
  orgId: string,
  changedSyncedFields: string[],
  client?: Client,
): Promise<void> {
  if (changedSyncedFields.length === 0) return;
  if ((await inventorySourceOf(orgId, client)) === "EXTERNAL") throw managedByInventory(changedSyncedFields);
}
