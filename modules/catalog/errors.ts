/**
 * Catalog error helpers. We keep the shared `ErrorCode` set and put the specific
 * cause in `details.reason` (catalog-api-and-rules.md §2), so lib/errors.ts is unchanged.
 */
import { AppError } from "@/lib/errors";

export type CatalogConflictReason =
  | "SKU_TAKEN"
  | "BARCODE_TAKEN"
  | "NAME_TAKEN"
  | "STALE_WRITE"
  | "CATEGORY_HAS_ACTIVE_CHILDREN"
  | "ALREADY_ARCHIVED"
  | "NOT_ARCHIVED"
  | "PRIMARY_BARCODE_TAKEN"
  | "PRODUCT_HAS_STOCK";

export type CatalogValidationReason =
  | "CATEGORY_INACTIVE"
  | "CATEGORY_CYCLE"
  | "CATEGORY_TOO_DEEP"
  | "UNIT_NOT_SUPPORTED"
  | "UNIT_IMMUTABLE"
  | "VARIANT_PRODUCT_MISMATCH"
  | "VARIANT_REQUIRED"
  | "ITEM_NOT_SELLABLE"
  | "OPTIONS_NOT_SUPPORTED"
  | "SERVICE_NOT_SUPPORTED";

const CONFLICT_MESSAGES: Record<CatalogConflictReason, string> = {
  SKU_TAKEN: "This SKU is already used in your catalog",
  BARCODE_TAKEN: "This barcode is already used in your catalog",
  NAME_TAKEN: "A category with this name already exists here",
  STALE_WRITE: "This record was changed by someone else. Reload and try again",
  CATEGORY_HAS_ACTIVE_CHILDREN: "Archive the active sub-categories first",
  ALREADY_ARCHIVED: "This record is already archived",
  NOT_ARCHIVED: "This record is not archived",
  PRIMARY_BARCODE_TAKEN: "Another primary barcode was set at the same time. Reload and try again",
  PRODUCT_HAS_STOCK: "This product already has stock recorded without variants",
};

const VALIDATION_MESSAGES: Record<CatalogValidationReason, string> = {
  CATEGORY_INACTIVE: "This category is archived and cannot be assigned",
  CATEGORY_CYCLE: "A category cannot be moved under itself or one of its sub-categories",
  CATEGORY_TOO_DEEP: "Categories can be at most 3 levels deep",
  UNIT_NOT_SUPPORTED: "This unit is not supported yet",
  UNIT_IMMUTABLE: "The unit cannot be changed after creation",
  VARIANT_PRODUCT_MISMATCH: "The variant does not belong to this product",
  VARIANT_REQUIRED: "This product has variants: choose a variant",
  ITEM_NOT_SELLABLE: "This item cannot be sold",
  OPTIONS_NOT_SUPPORTED: "Options cannot be combined with variants",
  SERVICE_NOT_SUPPORTED: "A service cannot be sold by weight or have variants",
};

export function conflict(reason: CatalogConflictReason, details: Record<string, unknown> = {}): AppError {
  return new AppError("CONFLICT", CONFLICT_MESSAGES[reason], { reason, ...details });
}

export function invalid(reason: CatalogValidationReason, details: Record<string, unknown> = {}): AppError {
  return new AppError("VALIDATION_FAILED", VALIDATION_MESSAGES[reason], { reason, ...details });
}

/** 409 STALE_WRITE unless the row still carries the timestamp the client last saw. */
export function assertFresh(updatedAt: Date, expectedUpdatedAt: string): void {
  if (updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
    throw conflict("STALE_WRITE", { currentUpdatedAt: updatedAt.toISOString() });
  }
}

// ---------------------------------------------------------------------------
// Prisma unique violations (P2002)
// ---------------------------------------------------------------------------

type PrismaKnownError = { name: string; code: string; meta?: Record<string, unknown>; message: string };

function isPrismaKnownError(err: unknown): err is PrismaKnownError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "PrismaClientKnownRequestError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/** Known unique constraints / indexes on catalog tables (names from the migrations). */
export type CatalogUniqueConstraint =
  | "Product_orgId_sku_key"
  | "ProductVariant_orgId_sku_key"
  | "sku_namespace"
  | "Barcode_orgId_code_key"
  | "Barcode_one_primary_per_item"
  | "Category_sibling_name_key";

const KNOWN_CONSTRAINTS: readonly CatalogUniqueConstraint[] = [
  "Product_orgId_sku_key",
  "ProductVariant_orgId_sku_key",
  "sku_namespace",
  "Barcode_orgId_code_key",
  "Barcode_one_primary_per_item",
  "Category_sibling_name_key",
];

/**
 * Name of the violated catalog unique constraint for a Prisma P2002, else null.
 * With the pg driver adapter the name sits in `meta.driverAdapterError.cause.constraint.index`;
 * the trigger-raised `sku_namespace` violation arrives the same way.
 */
export function uniqueViolation(err: unknown): CatalogUniqueConstraint | null {
  if (!isPrismaKnownError(err) || err.code !== "P2002") return null;
  const cause = (err.meta?.driverAdapterError as { cause?: { constraint?: unknown; originalMessage?: unknown } })
    ?.cause;
  const constraint = cause?.constraint as { index?: unknown; fields?: unknown } | undefined;
  const candidates = [
    typeof constraint?.index === "string" ? constraint.index : null,
    typeof err.meta?.target === "string" ? err.meta.target : null,
  ];
  for (const name of candidates) {
    const known = KNOWN_CONSTRAINTS.find((c) => c === name);
    if (known) return known;
  }
  const text = `${typeof cause?.originalMessage === "string" ? cause.originalMessage : ""} ${err.message}`;
  return KNOWN_CONSTRAINTS.find((c) => text.includes(c)) ?? null;
}
