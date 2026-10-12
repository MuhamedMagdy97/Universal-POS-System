"use server";
/**
 * Returns Server Actions: thin adapters over modules/sales (returns-void-data-model-and-api.md).
 * Every action is a public POST, so each one re-resolves the tenant from the session and relies on
 * the service's own permission and scope checks.
 */
import { headers } from "next/headers";
import type { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { toErrorBody, type ErrorBody } from "@/lib/errors";
import { getRequestId } from "@/lib/http";
import { refundSale, voidSale, type RefundDetail, type RefundInput, type VoidInput } from "@/modules/sales";

export type ReturnsActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

async function run<T>(
  fn: (ctx: TenantContext, meta: { requestId: string }) => Promise<T>,
): Promise<ReturnsActionResult<T>> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    return { ok: true, data: await fn(ctx, { requestId: getRequestId(h) }) };
  } catch (err) {
    return { ok: false, error: toErrorBody(err).body };
  }
}

/** The key is made once per refund form on the client and kept across a retry, so a retry never refunds twice. */
export async function refundSaleAction(
  saleId: string,
  input: z.input<typeof RefundInput>,
  idempotencyKey: string,
): Promise<ReturnsActionResult<RefundDetail>> {
  return run(async (ctx, meta) => (await refundSale(ctx, saleId, idempotencyKey, input, meta)).refund);
}

export async function voidSaleAction(
  saleId: string,
  input: z.input<typeof VoidInput>,
): Promise<ReturnsActionResult<{ number: string }>> {
  return run(async (ctx, meta) => ({ number: (await voidSale(ctx, saleId, input, meta)).sale.number }));
}
