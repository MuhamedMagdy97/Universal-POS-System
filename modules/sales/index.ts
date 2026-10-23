/**
 * sales — Checkout, sale snapshots, idempotent sale creation, refunds and voids (T6, T8).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export { createSale, loadSale, requestHashOf, type CreateSaleResult, type SaleDetail } from "./create";
export { getReceipt, type ReceiptDoc, type ReceiptKind, type ReceiptRequest } from "./receipt";
export { getTillSnapshot, SNAPSHOT_VERSION, type SnapshotItem, type TillSnapshot } from "./offline-snapshot";
export { refundSale, voidSale, loadRefund, type RefundDetail, type RefundResult } from "./refunds";
export {
  getSaleForReturns,
  normalizeSaleNumber,
  type SaleForReturns,
  type ReturnLine,
  type ReturnRefund,
} from "./returns-view";
export {
  listOfflineReview,
  markOfflineSaleReviewed,
  REVIEW_PAGE_SIZE,
  type OfflineReviewPage,
  type OfflineReviewRow,
} from "./review";
export {
  SaleInput,
  IdempotencyKey,
  OpenShiftInput,
  CloseShiftInput,
  CashMovementInput,
  RefundInput,
  VoidInput,
} from "./schemas";
