/**
 * purchasing — Suppliers, purchase orders, goods receipts (T5).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. Receiving adds stock through inventory.recordMovements() and sets
 * last cost through catalog.applyReceivedCosts(); a return to the supplier takes stock out
 * through recordMovements() too. See
 * docs/planning/phase-10/purchasing-data-model-and-api.md.
 *
 * Server-only barrel: client components import `@/modules/purchasing/schemas` and
 * `@/modules/purchasing/rules` (pure) instead.
 */
export * from "./schemas";
export { canViewPurchasing, branchesInScope, type PurchasingBranch } from "./access";
export {
  listSuppliers,
  createSupplier,
  updateSupplier,
  archiveSupplier,
  restoreSupplier,
  type SupplierRow,
} from "./suppliers";
export {
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  orderPurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  type PoDetail,
  type PoLine,
  type PoReceipt,
  type PoReturn,
  type PoSummary,
  type PoPage,
} from "./orders";
export { receivePurchaseOrder, type ReceiveResult } from "./receipts";
export {
  returnToSupplier,
  getPurchaseReturn,
  type ReturnResult,
  type ReturnLine,
  type PurchaseReturnDetail,
} from "./returns";
export type { PurchasingConflictReason, PurchasingValidationReason } from "./errors";
