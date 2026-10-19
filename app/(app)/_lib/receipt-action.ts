"use server";
/**
 * Receipt data for printing (T10 H2, H4): a thin adapter over `getReceipt`. A public POST like
 * every Server Action, so it re-resolves the tenant; the service checks scope and permission.
 */
import { headers } from "next/headers";
import { requireTenant } from "@/lib/auth/tenant";
import type { ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import { getZReport, type ZReport } from "@/modules/registers";
import { getReceipt, type ReceiptDoc, type ReceiptRequest } from "@/modules/sales";

export type ReceiptActionResult = { ok: true; data: ReceiptDoc } | { ok: false; error: ErrorBody };

export async function receiptAction(saleId: string, request: ReceiptRequest): Promise<ReceiptActionResult> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    return { ok: true, data: await getReceipt(ctx, saleId, request, { requestId: getRequestId(h) }) };
  } catch (err) {
    return { ok: false, error: await actionError(err, "receipt") };
  }
}

export type ZReportActionResult = { ok: true; data: ZReport } | { ok: false; error: ErrorBody };

/** A closed shift's Z-report for printing (T10 H9). */
export async function zReportAction(shiftId: string): Promise<ZReportActionResult> {
  try {
    const ctx = await requireTenant(await headers());
    return { ok: true, data: await getZReport(ctx, shiftId) };
  } catch (err) {
    return { ok: false, error: await actionError(err, "receipt") };
  }
}
