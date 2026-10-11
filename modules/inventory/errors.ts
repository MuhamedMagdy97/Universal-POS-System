/**
 * Inventory error helpers. Shared `ErrorCode`s with the specific cause in `details.reason`
 * (inventory-api-and-rules.md §6), the same pattern as catalog.
 */
import { AppError } from "@/lib/errors";

export type InsufficientLine = {
  productId: string;
  variantId: string | null;
  branchId: string;
  onHand: number;
  requested: number;
};

/** One or more lines would go below zero under the "block" policy. Lists every failing line. */
export function insufficientStock(lines: InsufficientLine[]): AppError {
  return new AppError("CONFLICT", "There is not enough stock for this change", {
    reason: "INSUFFICIENT_STOCK",
    lines,
  });
}

export function invalidInput(reason: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason });
}

/** The adjustment's expected on-hand is out of date (a sale or count landed first). */
export function staleStock(onHand: number): AppError {
  return new AppError("CONFLICT", "Stock changed while you were editing. Check the new quantity and confirm again", {
    reason: "STALE_STOCK",
    onHand,
  });
}

/** Some lines already have ledger rows at this branch, so they cannot be opened again. */
export function openingExists(refs: { productId: string; variantId: string | null }[]): AppError {
  return new AppError("CONFLICT", "Opening stock is already recorded for some items at this branch", {
    reason: "OPENING_BALANCE_EXISTS",
    refs,
  });
}

/** A counted quantity equal to on-hand is not an adjustment. */
export function noChange(): AppError {
  return new AppError("VALIDATION_FAILED", "The counted quantity matches the current stock", { reason: "NO_CHANGE" });
}

/** The same transferId was sent before with different content. */
export function idempotencyConflict(): AppError {
  return new AppError("IDEMPOTENCY_CONFLICT", "This transfer id was already used for a different transfer", {
    reason: "IDEMPOTENCY_CONFLICT",
  });
}
