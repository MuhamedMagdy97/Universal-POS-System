"use server";
/**
 * Till Server Actions: thin adapters over modules/sales and modules/registers
 * (checkout-data-model-and-api.md). Every action is a public POST, so each one re-resolves the
 * tenant from the session and relies on the service's own permission and scope checks.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import type { ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import {
  addCashMovement,
  closeShift,
  openShift,
  type CashMovementSummary,
  type ShiftCloseSummary,
  type ShiftSummary,
} from "@/modules/registers";
import {
  createSale,
  type CashMovementInput,
  type CloseShiftInput,
  type OpenShiftInput,
  type SaleDetail,
  type SaleInput,
} from "@/modules/sales";

export type PosActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

async function run<T>(
  fn: (ctx: TenantContext, meta: { requestId: string }) => Promise<T>,
): Promise<PosActionResult<T>> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    return { ok: true, data: await fn(ctx, { requestId: getRequestId(h) }) };
  } catch (err) {
    return { ok: false, error: await actionError(err, "pos") };
  }
}

/** The key is generated once per cart on the client and kept across retries, so a retry never sells twice. */
export async function createSaleAction(
  input: z.input<typeof SaleInput>,
  idempotencyKey: string,
): Promise<PosActionResult<SaleDetail>> {
  return run(async (ctx, meta) => (await createSale(ctx, input, idempotencyKey, meta)).sale);
}

export async function openShiftAction(input: z.input<typeof OpenShiftInput>): Promise<PosActionResult<ShiftSummary>> {
  const result = await run((ctx, meta) => openShift(ctx, input, meta));
  if (result.ok) revalidatePath("/pos");
  return result;
}

/** Closes the shift on screen. The server computes the expected cash; the page reloads only after the cashier leaves the summary. */
export async function closeShiftAction(
  shiftId: string,
  input: z.input<typeof CloseShiftInput>,
): Promise<PosActionResult<ShiftCloseSummary>> {
  return run((ctx, meta) => closeShift(ctx, shiftId, input, meta));
}

/** Records a pay-in, pay-out or drop. There is no replay, so the screen keeps its button disabled while this runs. */
export async function addCashMovementAction(
  shiftId: string,
  input: z.input<typeof CashMovementInput>,
): Promise<PosActionResult<CashMovementSummary>> {
  return run((ctx, meta) => addCashMovement(ctx, shiftId, input, meta));
}
