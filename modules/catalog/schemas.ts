import { z } from "zod";
import { MAX_STORABLE_MINOR, parseMajor, type CurrencyCode } from "@/lib/money";

/**
 * Catalog input schemas and output types (T3.3).
 *
 * Pure validation: no DB access. Route Handlers, Server Actions and tests all
 * parse with these schemas. See docs/planning/phase-6/catalog-spec.md (§3, §4)
 * and catalog-api-and-rules.md (§2, §4).
 *
 * - Every input object is strict: unknown keys (`orgId`, `id`, `isActive`, …)
 *   are rejected, so tenant/identity fields can never come from the client.
 * - Money is integer minor units, 0 ≤ x ≤ MAX_STORABLE_MINOR.
 * - `vatApplicable` is derived server-side from `vatCategory` (decision Q3),
 *   so it is not an input field.
 */

// ---------------------------------------------------------------------------
// Enums (literal unions mirroring prisma/schema.prisma, kept independent of the
// generated client so this module stays importable from client components)
// ---------------------------------------------------------------------------

export const UNIT_TYPE_VALUES = ["EACH", "KG"] as const;
export const UnitType = z.enum(UNIT_TYPE_VALUES);
export type UnitType = z.infer<typeof UnitType>;

/** Units accepted on product create in T3 (decision Q5: EACH only until the grocery preset). */
export const SUPPORTED_UNIT_TYPES: readonly UnitType[] = ["EACH"];

export const VAT_CATEGORY_VALUES = ["STANDARD", "ZERO_RATED", "EXEMPT"] as const;
export const VatCategory = z.enum(VAT_CATEGORY_VALUES);
export type VatCategory = z.infer<typeof VatCategory>;

export const PRODUCT_STATUS_VALUES = ["active", "archived", "all"] as const;
export const ProductStatus = z.enum(PRODUCT_STATUS_VALUES);
export type ProductStatus = z.infer<typeof ProductStatus>;

export const PRODUCT_SORT_VALUES = ["name", "updatedAt"] as const;
export const ProductSort = z.enum(PRODUCT_SORT_VALUES);
export type ProductSort = z.infer<typeof ProductSort>;

/** Reasons carried in `details.reason` / zod issue params for catalog-specific 422s. */
export const UNIT_NOT_SUPPORTED = "UNIT_NOT_SUPPORTED";
export const DUPLICATE_BARCODE = "DUPLICATE_BARCODE";
export const INVALID_CURSOR = "INVALID_CURSOR";
export const INVALID_PRICE = "INVALID_PRICE";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const SKU_PATTERN = /^[A-Z0-9._/-]+$/;
/** Printable ASCII, no spaces. Matches the DB CHECK `Barcode_code_format`. */
export const BARCODE_PATTERN = /^[\x21-\x7E]+$/;

export const Uuid = z.uuid();

/**
 * SKU: trimmed, inner whitespace collapsed, upper-cased (decision Q4), then
 * checked against `[A-Z0-9._/-]{1,64}`. Spaces never survive the charset check;
 * collapsing first only makes the error point at the right character class.
 */
export const Sku = z
  .string()
  .trim()
  .overwrite((value) => value.replace(/\s+/g, " ").toUpperCase())
  .min(1)
  .max(64)
  .regex(SKU_PATTERN, { message: "SKU may contain only A-Z, 0-9, '.', '_', '/', '-'" });

/** Barcode/PLU code: trimmed, printable ASCII, 1–64, exact case (no folding). */
export const BarcodeCode = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(BARCODE_PATTERN, { message: "Barcode must be printable ASCII without spaces" });

/** Integer minor units within the storable range. Negative, fractional and NaN values fail. */
export const Minor = z.int().min(0).max(MAX_STORABLE_MINOR);

/** Display name: trimmed, NFC-normalised, 1–120 characters. */
export const Name = z.string().trim().normalize("NFC").min(1).max(120);

/** ISO-8601 UTC timestamp echoed back for optimistic concurrency (STALE_WRITE on mismatch). */
export const ExpectedUpdatedAt = z.iso.datetime();

/**
 * Form price field (major units, e.g. "12.50") → integer minor units for `currency`.
 *
 * TODO(T3.2): Arabic-Indic digit normalisation ("١٢٫٥٠" → "12.50") is being added
 * to lib/money.ts by T3.2. Once it lands, normalise here before `parseMajor`
 * (or rely on parseMajor if it normalises internally) — see C-28.
 */
export function majorPrice(currency: CurrencyCode) {
  return z
    .string()
    .transform((value, ctx) => {
      try {
        return parseMajor(value, currency);
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: err instanceof Error ? err.message : "Invalid amount",
          params: { reason: INVALID_PRICE },
        });
        return z.NEVER;
      }
    })
    .pipe(Minor);
}

/** Barcode list for one payload: max 10, each valid, no duplicates (C-19). */
export const BarcodeList = z
  .array(BarcodeCode)
  .max(10)
  .superRefine((codes, ctx) => {
    const seen = new Set<string>();
    codes.forEach((code, index) => {
      if (seen.has(code)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "Duplicate barcode in request",
          params: { reason: DUPLICATE_BARCODE },
        });
      }
      seen.add(code);
    });
  });

const SupportedUnitType = UnitType.refine((unit) => SUPPORTED_UNIT_TYPES.includes(unit), {
  message: UNIT_NOT_SUPPORTED,
  params: { reason: UNIT_NOT_SUPPORTED },
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const CreateProduct = z.strictObject({
  sku: Sku,
  name: Name,
  nameAr: Name.optional(),
  categoryId: Uuid.nullable().default(null),
  unitType: SupportedUnitType.default("EACH"),
  priceMinor: Minor,
  costMinor: Minor.default(0),
  vatCategory: VatCategory.default("STANDARD"),
  barcodes: BarcodeList.default([]),
});
export type CreateProductInput = z.input<typeof CreateProduct>;
export type CreateProduct = z.infer<typeof CreateProduct>;

/**
 * PATCH body. Built field-by-field (not `.partial()` of CreateProduct) so that
 * create-time defaults are never applied to an omitted field. `unitType` is
 * immutable and barcodes have their own endpoint, so neither is accepted.
 * `nameAr: null` clears the Arabic name.
 */
export const UpdateProduct = z.strictObject({
  sku: Sku.optional(),
  name: Name.optional(),
  nameAr: Name.nullable().optional(),
  categoryId: Uuid.nullable().optional(),
  priceMinor: Minor.optional(),
  costMinor: Minor.optional(),
  vatCategory: VatCategory.optional(),
  expectedUpdatedAt: ExpectedUpdatedAt,
});
export type UpdateProduct = z.infer<typeof UpdateProduct>;

export const ArchiveInput = z.strictObject({ expectedUpdatedAt: ExpectedUpdatedAt });
export type ArchiveInput = z.infer<typeof ArchiveInput>;

// ---------------------------------------------------------------------------
// Variants (price/cost `null` = inherit from the product)
// ---------------------------------------------------------------------------

export const CreateVariant = z.strictObject({
  sku: Sku,
  name: Name,
  nameAr: Name.optional(),
  priceMinor: Minor.nullable().default(null),
  costMinor: Minor.nullable().default(null),
  barcodes: BarcodeList.default([]),
});
export type CreateVariantInput = z.input<typeof CreateVariant>;
export type CreateVariant = z.infer<typeof CreateVariant>;

export const UpdateVariant = z.strictObject({
  sku: Sku.optional(),
  name: Name.optional(),
  nameAr: Name.nullable().optional(),
  priceMinor: Minor.nullable().optional(),
  costMinor: Minor.nullable().optional(),
  expectedUpdatedAt: ExpectedUpdatedAt,
});
export type UpdateVariant = z.infer<typeof UpdateVariant>;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const CreateCategory = z.strictObject({
  name: Name,
  nameAr: Name.optional(),
  parentId: Uuid.nullable().default(null),
});
export type CreateCategory = z.infer<typeof CreateCategory>;

/** Category list filter (the whole tree is returned; no cursor). */
export const ListCategoriesQuery = z.strictObject({ status: ProductStatus.default("active") });
export type ListCategoriesQuery = z.infer<typeof ListCategoriesQuery>;

export const UpdateCategory = z.strictObject({
  name: Name.optional(),
  nameAr: Name.nullable().optional(),
  parentId: Uuid.nullable().optional(),
  expectedUpdatedAt: ExpectedUpdatedAt,
});
export type UpdateCategory = z.infer<typeof UpdateCategory>;

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------

export const AddBarcode = z.strictObject({
  code: BarcodeCode,
  productId: Uuid,
  variantId: Uuid.nullable().default(null),
  isPrimary: z.boolean().default(false),
});
export type AddBarcode = z.infer<typeof AddBarcode>;

export const LookupQuery = z.strictObject({ code: BarcodeCode });
export type LookupQuery = z.infer<typeof LookupQuery>;

/** POS quick search (`searchSellable`): active items only, at most 50 rows. */
export const SearchSellableQuery = z.strictObject({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number<string | number>().int().min(1).max(50).default(20),
});
export type SearchSellableQueryInput = z.input<typeof SearchSellableQuery>;
export type SearchSellableQuery = z.infer<typeof SearchSellableQuery>;

// ---------------------------------------------------------------------------
// Cursor codec — opaque base64url JSON of (sortKey, id)
// ---------------------------------------------------------------------------

export type DecodedCursor = { sortKey: string; id: string };

const CursorPayload = z.strictObject({ k: z.string().max(256), id: Uuid });

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error("not base64url");
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Validates and decodes a cursor string; garbage yields a zod issue, never a raw throw. */
export const Cursor = z
  .string()
  .min(1)
  .max(512)
  .transform((value, ctx): unknown => {
    try {
      return JSON.parse(fromBase64Url(value));
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid cursor", params: { reason: INVALID_CURSOR } });
      return z.NEVER;
    }
  })
  .pipe(CursorPayload)
  .transform(({ k, id }): DecodedCursor => ({ sortKey: k, id }));

export function encodeCursor(sortKey: string, id: string): string {
  return toBase64Url(JSON.stringify({ k: sortKey, id }));
}

/** Throws a `ZodError` (→ 422 VALIDATION_FAILED via `toErrorBody`) for an invalid cursor. */
export function decodeCursor(cursor: string): DecodedCursor {
  return Cursor.parse(cursor);
}

// ---------------------------------------------------------------------------
// List query (URL search params: every value arrives as a string)
// ---------------------------------------------------------------------------

export const ListProductsQuery = z.strictObject({
  q: z.string().trim().min(1).max(64).optional(),
  categoryId: Uuid.optional(),
  status: ProductStatus.default("active"),
  limit: z.coerce.number<string | number>().int().min(1).max(100).default(25),
  cursor: Cursor.optional(),
  sort: ProductSort.default("name"),
});
export type ListProductsQueryInput = z.input<typeof ListProductsQuery>;
export type ListProductsQuery = z.infer<typeof ListProductsQuery>;

// ---------------------------------------------------------------------------
// Output types (service → caller). Timestamps are ISO strings, as on the wire.
// ---------------------------------------------------------------------------

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ProductSummary = {
  id: string;
  sku: string;
  name: string;
  nameAr: string | null;
  categoryId: string | null;
  unitType: UnitType;
  priceMinor: number;
  /** Present only when the caller has `products.update`. */
  costMinor?: number;
  vatCategory: VatCategory;
  /** Derived: `vatCategory === "STANDARD"`. */
  vatApplicable: boolean;
  hasVariants: boolean;
  variantCount: number;
  isActive: boolean;
  updatedAt: string;
};

export type VariantDetail = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  nameAr: string | null;
  /** `null` = inherits the product price. */
  priceMinor: number | null;
  /** `null` = inherits the product cost. Present only with `products.update`. */
  costMinor?: number | null;
  isActive: boolean;
  updatedAt: string;
};

export type BarcodeDetail = {
  id: string;
  code: string;
  productId: string;
  variantId: string | null;
  isPrimary: boolean;
};

export type ProductDetail = ProductSummary & {
  createdAt: string;
  variants: VariantDetail[];
  barcodes: BarcodeDetail[];
};

export type CatalogItemRef = { productId: string; variantId: string | null };

export type SellableItem = CatalogItemRef & {
  sku: string;
  name: string;
  nameAr: string | null;
  unitType: UnitType;
  /** Resolved variant → product. */
  unitPriceMinor: number;
  costMinor: number;
  vatCategory: VatCategory;
  vatApplicable: boolean;
};

/** A sellable row without cost: what POS search/scan screens may show. */
export type SellableSummary = Omit<SellableItem, "costMinor">;

/**
 * Why a resolved code cannot be sold as-is. `VARIANT_REQUIRED`: the code points
 * at a product with variants and no variant was chosen; the POS shows a picker
 * built from `LookupResult.variants`.
 */
export type LookupNotSellableReason = "PRODUCT_ARCHIVED" | "VARIANT_ARCHIVED" | "VARIANT_REQUIRED";

/** One choice in the `VARIANT_REQUIRED` picker. Never carries cost or stock. */
export type LookupVariantOption = {
  variantId: string;
  sku: string;
  name: string;
  nameAr: string | null;
  unitPriceMinor: number;
  sellable: boolean;
};

/** Scanner lookup result. Never carries cost or stock. */
export type LookupResult = CatalogItemRef & {
  sku: string;
  name: string;
  nameAr: string | null;
  unitType: UnitType;
  unitPriceMinor: number;
  vatCategory: VatCategory;
  vatApplicable: boolean;
  sellable: boolean;
  reason?: LookupNotSellableReason;
  /** Only with `reason: "VARIANT_REQUIRED"`: active variants first, then by sortOrder, name. */
  variants?: LookupVariantOption[];
};
