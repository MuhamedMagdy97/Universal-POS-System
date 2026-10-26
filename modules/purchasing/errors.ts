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
  | "QTY_EXCEEDS_RETURNABLE"
  | "SUPPLIER_INACTIVE"
  | "SUPPLIER_NAME_TAKEN"
  | "PAYMENT_ALREADY_REVERSED"
  | "PAYMENT_NOT_REVERSIBLE"
  | "INVOICE_NUMBER_TAKEN"
  | "RECEIPT_ALREADY_INVOICED"
  | "RETURN_ALREADY_CREDITED"
  | "INVOICE_VOIDED"
  | "AMOUNT_EXCEEDS_OPEN"
  | "AMOUNT_EXCEEDS_UNALLOCATED"
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

export type PurchasingValidationReason =
  | "NOTHING_TO_RECEIVE"
  | "ITEM_NOT_STOCKED"
  | "NOTHING_TO_RETURN"
  | "AMOUNT_TOO_LARGE"
  | "PAYMENT_DATE_IN_FUTURE"
  | "INVOICE_DATE_IN_FUTURE"
  | "DUE_BEFORE_ISSUE"
  | "VAT_ABOVE_RATE"
  | "TOTAL_NOT_POSITIVE"
  | "INVALID_DOCUMENT_LINK"
  | "ALLOCATION_EXCEEDS_PAYMENT";

export function purchasingInvalid(
  reason: PurchasingValidationReason,
  message: string,
  details: Record<string, unknown> = {},
) {
  return new AppError("VALIDATION_FAILED", message, { reason, ...details });
}
