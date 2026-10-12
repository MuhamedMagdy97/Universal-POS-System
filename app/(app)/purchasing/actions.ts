"use server";
/**
 * Purchasing Server Actions: thin adapters over modules/purchasing (purchasing-data-model-and-api.md).
 * Every action is a public POST, so each one re-resolves the tenant from the session and relies on
 * the service's own permission and branch-scope checks.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { toErrorBody } from "@/lib/errors";
import { getRequestId } from "@/lib/http";
import {
  archiveSupplier,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  orderPurchaseOrder,
  receivePurchaseOrder,
  restoreSupplier,
  updatePurchaseOrder,
  updateSupplier,
  type PoInput,
  type PoPatch,
  type ReceiptInput,
  type SupplierInput,
  type SupplierPatch,
  type SupplierRow,
} from "@/modules/purchasing";
import type { ActionResult } from "./_lib/purchasing";

async function run<T>(fn: (ctx: TenantContext, meta: { requestId: string }) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    const data = await fn(ctx, { requestId: getRequestId(h) });
    revalidatePath("/purchasing", "layout");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toErrorBody(err).body };
  }
}

type PoRef = { id: string };

export async function createPoAction(input: z.input<typeof PoInput>): Promise<ActionResult<PoRef>> {
  return run(async (ctx, meta) => ({ id: (await createPurchaseOrder(ctx, input, meta)).id }));
}

export async function updatePoAction(poId: string, input: z.input<typeof PoPatch>): Promise<ActionResult<PoRef>> {
  return run(async (ctx, meta) => ({ id: (await updatePurchaseOrder(ctx, poId, input, meta)).id }));
}

export async function orderPoAction(poId: string): Promise<ActionResult<PoRef>> {
  return run(async (ctx, meta) => ({ id: (await orderPurchaseOrder(ctx, poId, meta)).id }));
}

export async function cancelPoAction(poId: string, reason: string): Promise<ActionResult<PoRef>> {
  return run(async (ctx, meta) => ({ id: (await cancelPurchaseOrder(ctx, poId, { reason }, meta)).id }));
}

export async function closePoAction(poId: string, reason: string): Promise<ActionResult<PoRef>> {
  return run(async (ctx, meta) => ({ id: (await closePurchaseOrder(ctx, poId, { reason }, meta)).id }));
}

/** The key is made once per receive form on the client and kept across a retry, so a retry never receives twice. */
export async function receivePoAction(
  poId: string,
  idempotencyKey: string,
  input: z.input<typeof ReceiptInput>,
): Promise<ActionResult<{ receiptId: string }>> {
  return run(async (ctx, meta) => ({
    receiptId: (await receivePurchaseOrder(ctx, poId, idempotencyKey, input, meta)).receiptId,
  }));
}

export async function createSupplierAction(input: z.input<typeof SupplierInput>): Promise<ActionResult<SupplierRow>> {
  return run((ctx, meta) => createSupplier(ctx, input, meta));
}

export async function updateSupplierAction(
  supplierId: string,
  input: z.input<typeof SupplierPatch>,
): Promise<ActionResult<SupplierRow>> {
  return run((ctx, meta) => updateSupplier(ctx, supplierId, input, meta));
}

export async function setSupplierActiveAction(supplierId: string, active: boolean): Promise<ActionResult<SupplierRow>> {
  return run((ctx, meta) => (active ? restoreSupplier(ctx, supplierId, meta) : archiveSupplier(ctx, supplierId, meta)));
}
