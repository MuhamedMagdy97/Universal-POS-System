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
