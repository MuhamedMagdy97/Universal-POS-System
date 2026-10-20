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
import { actionError, getRequestId } from "@/lib/http";
import {
  archiveSupplier,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  orderPurchaseOrder,
  receivePurchaseOrder,
  recordSupplierPayment,
  restoreSupplier,
  returnToSupplier,
  reverseSupplierPayment,
  updatePurchaseOrder,
  updateSupplier,
  type PaymentInput,
  type PoInput,
  type PoPatch,
  type ReceiptInput,
  type ReturnInput,
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
    return { ok: false, error: await actionError(err, "purchasing") };
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

/** Like receiving: one key per return form, kept across a retry, so a retry never returns twice. */
export async function returnPoAction(
  poId: string,
  idempotencyKey: string,
  input: z.input<typeof ReturnInput>,
): Promise<ActionResult<{ returnId: string }>> {
  return run(async (ctx, meta) => ({
    returnId: (await returnToSupplier(ctx, poId, idempotencyKey, input, meta)).returnId,
  }));
}

/** Supplier payments (supplier-payments-spec S8): one key per form, kept across a retry, so a retry never pays twice. */
export async function recordPaymentAction(
  supplierId: string,
  idempotencyKey: string,
  input: z.input<typeof PaymentInput>,
): Promise<ActionResult<{ paymentId: string }>> {
  return run(async (ctx, meta) => ({
    paymentId: (await recordSupplierPayment(ctx, supplierId, idempotencyKey, input, meta)).paymentId,
  }));
}

export async function reversePaymentAction(
  supplierId: string,
  paymentId: string,
  idempotencyKey: string,
  reason: string,
): Promise<ActionResult<{ paymentId: string }>> {
  return run(async (ctx, meta) => ({
    paymentId: (await reverseSupplierPayment(ctx, supplierId, paymentId, idempotencyKey, { reason }, meta)).paymentId,
  }));
}
