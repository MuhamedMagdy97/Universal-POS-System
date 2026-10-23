"use server";
/**
 * Till Server Actions: thin adapters over modules/sales and modules/registers
 * (checkout-data-model-and-api.md). Every action is a public POST, so each one re-resolves the
 * tenant from the session and relies on the service's own permission and scope checks.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { getSession } from "@/lib/auth/session";
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
import { enrolOfflineDevice, reportOfflineQueue, type EnrolledDevice } from "@/modules/org";
import {
  createSale,
  getTillSnapshot,
  type TillSnapshot,
  type CashMovementInput,
  type CloseShiftInput,
  type OpenShiftInput,
  type SaleDetail,
  type SaleInput,
} from "@/modules/sales";
import { getTillOnHand, type TillStockInput } from "@/modules/inventory/till-stock";

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

/** On-hand at the till's branch for the given items, in the same order as `refs`. Read-only: it never blocks a sale. */
export async function tillStockAction(
  input: z.input<typeof TillStockInput>,
): Promise<PosActionResult<(number | null)[]>> {
  return run((ctx) => getTillOnHand(ctx, input));
}

/** The register's offline snapshot (offline-till-spec OF7), with the session's expiry for the offline limits (OF19). */
export async function tillSnapshotAction(branchId: string, registerId: string): Promise<PosActionResult<TillSnapshot>> {
  return run(async (ctx) => {
    const session = await getSession(await headers());
    return getTillSnapshot(ctx, branchId, registerId, session ? new Date(session.session.expiresAt) : null);
  });
}

/** Enrols this browser as the register's offline device (OF16, Owner). The secret is returned once; the till keeps it. */
export async function enrolTillDeviceAction(registerId: string): Promise<PosActionResult<EnrolledDevice>> {
  return run((ctx, meta) => enrolOfflineDevice(ctx, registerId, meta));
}

/** The device's unsynced count (OF14), so a close from another device can warn. Fire and forget. */
export async function reportOfflineQueueAction(input: {
  registerId: string;
  deviceId: string;
  deviceSecret: string;
  queued: number;
  oldestAt: string | null;
}): Promise<PosActionResult<null>> {
  return run(async (ctx) => {
    await reportOfflineQueue(ctx, input);
    return null;
  });
}
