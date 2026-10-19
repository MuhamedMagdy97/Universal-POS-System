"use server";
/**
 * Inventory Server Actions: thin adapters over modules/inventory (inventory-api-and-rules.md).
 * Every action is a public POST, so each one re-resolves the tenant from the session and relies
 * on the service's own permission and branch-scope checks. Results: `{ ok, data } | { ok: false, error }`.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import type { ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import {
  addCountItems,
  adjustStock,
  cancelCount,
  createCount,
  postCount,
  recordCountEntry,
  removeCountItem,
  startCount,
  type CountCreateInput,
  type CountEntryInput,
  type CountItemInput,
  type CountItemsInput,
  recordOpeningBalances,
  setReorderPoint,
  transferStock,
  type AdjustInput,
  type OpeningInput,
  type ReorderPointInput,
  type TransferInput,
} from "@/modules/inventory";

const INVENTORY_PATH = "/inventory";

export type InventoryActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

async function run<T>(
  fn: (ctx: TenantContext, meta: { requestId: string }) => Promise<T>,
): Promise<InventoryActionResult<T>> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    const data = await fn(ctx, { requestId: getRequestId(h) });
    revalidatePath(INVENTORY_PATH);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: await actionError(err, "inventory") };
  }
}

export async function adjustStockAction(input: z.input<typeof AdjustInput>) {
  return run((ctx, meta) => adjustStock(ctx, input, meta));
}

export async function transferStockAction(input: z.input<typeof TransferInput>) {
  return run((ctx, meta) => transferStock(ctx, input, meta));
}

export async function recordOpeningAction(input: z.input<typeof OpeningInput>) {
  return run((ctx, meta) => recordOpeningBalances(ctx, input, meta));
}

export async function setReorderPointAction(input: z.input<typeof ReorderPointInput>) {
  return run((ctx, meta) => setReorderPoint(ctx, input, meta));
}

// ── Stock counts ──

export async function createCountAction(input: z.input<typeof CountCreateInput>) {
  return run((ctx, meta) => createCount(ctx, input, meta));
}

export async function addCountItemsAction(countId: string, input: z.input<typeof CountItemsInput>) {
  return run((ctx, meta) => addCountItems(ctx, countId, input, meta));
}

export async function removeCountItemAction(countId: string, input: z.input<typeof CountItemInput>) {
  return run((ctx, meta) => removeCountItem(ctx, countId, input, meta));
}

export async function startCountAction(countId: string) {
  return run((ctx, meta) => startCount(ctx, countId, meta));
}

export async function recordCountEntryAction(countId: string, input: z.input<typeof CountEntryInput>) {
  return run((ctx, meta) => recordCountEntry(ctx, countId, input, meta));
}

export async function postCountAction(countId: string) {
  return run((ctx, meta) => postCount(ctx, countId, meta));
}

export async function cancelCountAction(countId: string) {
  return run((ctx, meta) => cancelCount(ctx, countId, meta));
}
