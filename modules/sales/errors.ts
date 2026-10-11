import { AppError } from "@/lib/errors";

/**
 * Checkout error helpers. The shared ErrorCode set is kept and the cause goes in
 * `details.reason` (checkout-data-model-and-api.md §7).
 */

export type SalesConflictReason = "SHIFT_NOT_OPEN" | "SHIFT_ALREADY_OPEN" | "IDEMPOTENCY_CONFLICT";

export function salesConflict(reason: SalesConflictReason, message: string, details: Record<string, unknown> = {}) {
  return new AppError(reason === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "CONFLICT", message, {
    reason,
    ...details,
  });
}

export function invalidPayment(message: string, details: Record<string, unknown> = {}) {
  return new AppError("VALIDATION_FAILED", message, { reason: "PAYMENT_MISMATCH", ...details });
}

/** A line or sale total that does not fit the 32-bit money columns. */
export function amountTooLarge(scope: "line" | "sale") {
  return new AppError("VALIDATION_FAILED", `The ${scope} total is too large`, { reason: "AMOUNT_TOO_LARGE", scope });
}
