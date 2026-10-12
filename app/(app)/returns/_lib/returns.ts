/**
 * Pure helpers for the Returns screen (client-safe). Unit-tested in tests/unit/returns-helpers.test.ts.
 * No DB, no server imports. Amounts here are a preview using the server's rule (returns-void-spec.md V4);
 * the refund the server writes is the authority.
 */
import type { ErrorBody } from "@/lib/errors";
import type { MessageKey } from "@/lib/i18n";
import { divideRoundHalfUp, normalizeDigits } from "@/lib/money";

export type PreviewLine = {
  saleItemId: string;
  qty: number;
  lineTotalMinor: number;
  refundedQty: number;
  refundedAmountMinor: number;
};

export function refundableOf(line: Pick<PreviewLine, "qty" | "refundedQty">): number {
  return line.qty - line.refundedQty;
}

/** A typed quantity: blank means 0 (not refunded); a whole number from 0 to `refundable`; otherwise null. */
export function parseRefundQty(raw: string, refundable: number): number | null {
  const digits = normalizeDigits(raw).trim();
  if (digits === "") return 0;
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value <= refundable ? value : null;
}

/** What one line would refund: its share of the line total, and the remainder when it takes the last units. */
export function lineRefundMinor(line: PreviewLine, qty: number): number {
  if (qty <= 0) return 0;
  if (qty === refundableOf(line)) return line.lineTotalMinor - line.refundedAmountMinor;
  return Number(divideRoundHalfUp(BigInt(line.lineTotalMinor) * BigInt(qty), BigInt(line.qty)));
}

export type RefundPlan =
  { ok: true; lines: { saleItemId: string; qty: number }[]; totalMinor: number } | { ok: false; invalid: string[] };

/** Turns the typed quantities into the refund lines. Any unreadable box blocks the plan; zero lines are left out. */
export function planRefund(lines: readonly PreviewLine[], raw: Readonly<Record<string, string>>): RefundPlan {
  const invalid: string[] = [];
  const picked: { saleItemId: string; qty: number }[] = [];
  let totalMinor = 0;
  for (const line of lines) {
    const qty = parseRefundQty(raw[line.saleItemId] ?? "", refundableOf(line));
    if (qty === null) {
      invalid.push(line.saleItemId);
      continue;
    }
    if (qty === 0) continue;
    picked.push({ saleItemId: line.saleItemId, qty });
    totalMinor += lineRefundMinor(line, qty);
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, lines: picked, totalMinor };
}

export function canSubmitRefund(plan: RefundPlan, reason: string, pending: boolean): boolean {
  return !pending && plan.ok && plan.lines.length > 0 && plan.totalMinor > 0 && reason.trim() !== "";
}

/** Maps a refund or void error to a message. The server's `details.reason` decides it. */
export function returnErrorKey(error: ErrorBody): MessageKey {
  if (error.code === "IDEMPOTENCY_CONFLICT") return "returns.error.idempotency";
  if (error.code === "FORBIDDEN") return "returns.error.forbidden";
  if (error.code === "NOT_FOUND") return "returns.error.notFound";
  const reason = (error.details as { reason?: string } | null)?.reason;
  switch (reason) {
    case "REFUND_QTY_EXCEEDED":
      return "returns.error.qtyExceeded";
    case "SHIFT_NOT_OPEN":
      return "returns.error.shiftNotOpen";
    case "SALE_NOT_COMPLETED":
      return "returns.error.voided";
    case "SALE_HAS_REFUNDS":
      return "returns.error.hasRefunds";
    case "VOID_SHIFT_CLOSED":
      return "returns.error.voidShiftClosed";
    case "REFUND_ZERO_TOTAL":
      return "returns.error.zeroTotal";
    default:
      return "returns.error.generic";
  }
}
