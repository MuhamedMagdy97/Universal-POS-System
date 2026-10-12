/**
 * sales — Checkout, sale snapshots, idempotent sale creation, refunds and voids (T6, T8).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export { createSale, loadSale, requestHashOf, type CreateSaleResult, type SaleDetail } from "./create";
export { refundSale, voidSale, loadRefund, type RefundDetail, type RefundResult } from "./refunds";
export {
  getSaleForReturns,
  normalizeSaleNumber,
  type SaleForReturns,
  type ReturnLine,
  type ReturnRefund,
} from "./returns-view";
export {
  SaleInput,
  IdempotencyKey,
  OpenShiftInput,
  CloseShiftInput,
  CashMovementInput,
  RefundInput,
  VoidInput,
} from "./schemas";
