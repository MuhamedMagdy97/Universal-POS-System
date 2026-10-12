import { AppError } from "@/lib/errors";

/**
 * Purchasing error helpers. The shared ErrorCode set is kept and the cause goes in
 * `details.reason` (purchasing-data-model-and-api.md §5).
 */

export type PurchasingConflictReason =
  | "PO_NOT_EDITABLE"
  | "PO_NOT_RECEIVABLE"
  | "PO_BAD_TRANSITION"
  | "QTY_EXCEEDS_OUTSTANDING"
  | "SUPPLIER_INACTIVE"
  | "SUPPLIER_NAME_TAKEN"
  | "IDEMPOTENCY_CONFLICT";

export function purchasingConflict(
  reason: PurchasingConflictReason,
  message: string,
  details: Record<string, unknown> = {},
) {
  return new AppError(reason === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "CONFLICT", message, {
    reason,
    ...details,
  });
}

export type PurchasingValidationReason = "NOTHING_TO_RECEIVE" | "AMOUNT_TOO_LARGE";

export function purchasingInvalid(
  reason: PurchasingValidationReason,
  message: string,
  details: Record<string, unknown> = {},
) {
  return new AppError("VALIDATION_FAILED", message, { reason, ...details });
}
