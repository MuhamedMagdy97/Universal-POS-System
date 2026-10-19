import { AppError } from "@/lib/errors";

/**
 * Checkout error helpers. The shared ErrorCode set is kept and the cause goes in
 * `details.reason` (checkout-data-model-and-api.md §7).
 */

export type SalesConflictReason =
  | "SHIFT_NOT_OPEN"
  | "SHIFT_ALREADY_OPEN"
  | "SHIFT_ALREADY_CLOSED"
  | "IDEMPOTENCY_CONFLICT"
  | "REFUND_QTY_EXCEEDED"
  | "SALE_NOT_COMPLETED"
  | "SALE_HAS_REFUNDS"
  | "VOID_SHIFT_CLOSED";

export function salesConflict(reason: SalesConflictReason, message: string, details: Record<string, unknown> = {}) {
  return new AppError(reason === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "CONFLICT", message, {
    reason,
    ...details,
  });
}

export function invalidPayment(message: string, details: Record<string, unknown> = {}) {
  return new AppError("VALIDATION_FAILED", message, { reason: "PAYMENT_MISMATCH", ...details });
}

/** A discount bigger than the amount it comes off (discounts-spec DC3). */
export function discountTooLarge(discountMinor: number, baseMinor: number) {
  return new AppError("VALIDATION_FAILED", "The discount is larger than the amount it comes off", {
    reason: "DISCOUNT_TOO_LARGE",
    discountMinor,
    baseMinor,
  });
}

/** A discount past the caller's limit, or by someone who may not discount (DC9). `limitBp` 0 = none allowed. */
export function discountLimit(limitBp: number) {
  return new AppError("FORBIDDEN", `This discount is over your limit of ${limitBp / 100}%; ask a manager`, {
    reason: "DISCOUNT_LIMIT",
    limitBp,
  });
}

/** A line, sale, or shift total that does not fit the 32-bit money columns. */
export function amountTooLarge(scope: "line" | "sale" | "shift") {
  return new AppError("VALIDATION_FAILED", `The ${scope} total is too large`, { reason: "AMOUNT_TOO_LARGE", scope });
}
