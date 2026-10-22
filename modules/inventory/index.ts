/**
 * inventory — Append-only movement ledger and stock balances (T4). Other modules call
 * inventory.recordMovements() and friends, never write its tables.
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export { applyLines, recordMovements, type RecordMovementsInput, type ApplyInput, type MovementReason } from "./ledger";
export { getOnHand, hasStockAt, hasUnvariantedStock, type InventoryClient } from "./queries";
export { reconcile, type Mismatch } from "./reconcile";
export { type ItemRef } from "./types";
export { insufficientStock, type InsufficientLine } from "./errors";

// Back-office services (inventory.read / inventory.adjust / inventory.transfer).
export { listStock, getItemLedger, type StockRow, type StockPage, type LedgerRow, type LedgerPage } from "./stock";
export { recordOpeningBalances } from "./opening";
export { adjustStock } from "./adjust";
export {
  previewStockImport,
  importStock,
  type StockImportPreview,
  type StockImportRow,
  type StockImportErrorCode,
} from "./import";
export { transferStock } from "./transfer";
export {
  sendTransfer,
  receiveTransfer,
  cancelTransfer,
  listTransfers,
  getTransfer,
  type TransferSummary,
  type TransferDetail,
  type TransferLineView,
  type ReceiveResult,
} from "./transit";
export {
  setReorderPoint,
  listLowStock,
  countLowStock,
  exportLowStockCsv,
  LOW_STOCK_CAP,
  type LowStockRow,
} from "./reorder";
export {
  listCounts,
  createCount,
  getCount,
  getCountSheet,
  addCountItems,
  removeCountItem,
  startCount,
  recordCountEntry,
  postCount,
  cancelCount,
  type CountSummary,
  type CountDetail,
  type CountLineView,
  type CountSheetItem,
  type PostResult,
} from "./counts";
export {
  CountCreateInput,
  CountListQuery,
  CountItemsInput,
  CountItemInput,
  CountEntryInput,
  OpeningInput,
  AdjustInput,
  StockImportInput,
  StockImportPreviewInput,
  TransferInput,
  TransferListQuery,
  TransferReceiveInput,
  StockQuery,
  LedgerQuery,
  ReorderPointInput,
  LowStockQuery,
  Uuid,
} from "./schemas";
