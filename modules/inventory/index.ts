/**
 * inventory — Append-only movement ledger and stock balances (T4). Other modules call
 * inventory.recordMovements() and friends, never write its tables.
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export { applyLines, recordMovements, type RecordMovementsInput, type ApplyInput, type MovementReason } from "./ledger";
export { getOnHand, hasUnvariantedStock, type InventoryClient } from "./queries";
export { reconcile, type Mismatch } from "./reconcile";
export { type ItemRef } from "./types";
export { insufficientStock, type InsufficientLine } from "./errors";
