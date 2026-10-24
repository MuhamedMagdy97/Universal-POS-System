/**
 * catalog — Products, variants, barcodes, categories (T3 / Phase 6).
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 *
 * Server-only: the services below touch the database. Client components import
 * `@/modules/catalog/schemas` (pure zod) instead of this barrel.
 *
 * Service signatures: `(ctx: TenantContext, [id(s),] input, meta?)`. Every
 * function checks its own permission on `ctx` (catalog-api-and-rules.md §3).
 */
export * from "./schemas";

export {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  archiveProduct,
  restoreProduct,
  type ProductWriteResult,
  type UpdateProductInput,
} from "./products";
export { createProductAggregate, updateProductAggregate } from "./aggregate";
export {
  previewProductImport,
  importProducts,
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  type ImportColumn,
  type ImportErrorCode,
  type ImportPreview,
  type ImportPreviewRow,
} from "./import";
// Shared with the stock import (modules/inventory/import.ts).
export { parseCsv, readCsvTable, csvFileError, type CsvRow } from "./csv";
export {
  createVariant,
  updateVariant,
  archiveVariant,
  restoreVariant,
  type VariantWriteResult,
  type UpdateVariantInput,
} from "./variants";
export {
  listCategories,
  createCategory,
  updateCategory,
  archiveCategory,
  restoreCategory,
  type CategoryNode,
  type CategoryDetail,
} from "./categories";
export { addBarcode, removeBarcode } from "./barcodes";
// Cross-module seam (T3.5). The tx-aware functions skip permission checks: callers authorise first.
export {
  lookupCode,
  searchSellable,
  browseSellable,
  listSellable,
  getSellableItems,
  getItemsForHistory,
  assertStockable,
  lockProducts,
  type CatalogClient,
} from "./seam";
// Purchasing writes last cost through this seam (T5 P2); tx-aware, no permission check.
export { applyReceivedCosts } from "./costs";
export { itemNames, type ItemRefViolation } from "./sellable";
// Inventory-system sync writes (Phase 13); tx-aware, no permission check: the integration authorises first.
export {
  applyExternalItem,
  applyExternalCategory,
  archiveUnlisted,
  archiveUnlistedCategories,
  externalVariantIdsOf,
  ShapeChanged,
  type ApplyOutcome,
  type ExternalCategory,
  type ExternalItem,
  type ExternalVariant,
  type NotSellableReason,
} from "./external";
export type { CatalogConflictReason, CatalogValidationReason } from "./errors";
export { MAX_CATEGORY_DEPTH, type CatalogWarning } from "./rules";
