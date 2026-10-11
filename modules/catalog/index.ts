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
  getSellableItems,
  getItemsForHistory,
  assertStockable,
  type CatalogClient,
} from "./seam";
export type { ItemRefViolation } from "./sellable";
export type { CatalogConflictReason, CatalogValidationReason } from "./errors";
export { MAX_CATEGORY_DEPTH, type CatalogWarning } from "./rules";
