/**
 * Pure rules for the cross-module seam (T3.5): no DB access, unit-tested in
 * tests/unit/catalog-seam.test.ts. The DB side lives in ./seam.ts.
 * See catalog-api-and-rules.md §4 (LookupResult), §7 and catalog-spec.md R8, R10.
 */
import type {
  LookupNotSellableReason,
  LookupVariantOption,
  OptionGroupView,
  SellableItem,
  SellableSummary,
  UnitType,
  VatCategory,
} from "./schemas";

/** Product columns the seam reads. */
export type SeamProduct = {
  id: string;
  sku: string;
  name: string;
  nameAr: string | null;
  unitType: UnitType;
  priceMinor: number;
  costMinor: number;
  vatCategory: VatCategory;
  vatApplicable: boolean;
  hasVariants: boolean;
  isActive: boolean;
  categoryId?: string | null;
  /** Linked option groups in order (restaurant-cafe-spec R7); absent where a reader did not load them. */
  optionGroups?: {
    group: Omit<OptionGroupView, "choices"> & { isActive: boolean; choices: OptionGroupView["choices"] };
  }[];
};

/** Variant columns the seam reads. `null` price/cost = inherit from the product. */
export type SeamVariant = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  nameAr: string | null;
  priceMinor: number | null;
  costMinor: number | null;
  isActive: boolean;
  sortOrder: number;
};

/**
 * Why a ref cannot be used. Carried as `details.cause` on 422 ITEM_NOT_SELLABLE.
 * - VARIANT_PRODUCT_MISMATCH: the variant belongs to another product.
 * - VARIANT_REQUIRED: product has variants (`hasVariants`, R10) but no variant given.
 * - VARIANT_NOT_ALLOWED: product has no variants but a variant was given.
 */
export type ItemRefViolation =
  "VARIANT_PRODUCT_MISMATCH" | "VARIANT_REQUIRED" | "VARIANT_NOT_ALLOWED" | "PRODUCT_ARCHIVED" | "VARIANT_ARCHIVED";

/**
 * Checks a resolved ref against the variant rule (always) and the active rule
 * (when `requireActive`). Returns the first violation, or null when usable.
 */
export function itemRefViolation(
  product: SeamProduct,
  variant: SeamVariant | null,
  opts: { requireActive: boolean },
): ItemRefViolation | null {
  if (variant && variant.productId !== product.id) return "VARIANT_PRODUCT_MISMATCH";
  if (product.hasVariants && !variant) return "VARIANT_REQUIRED";
  if (!product.hasVariants && variant) return "VARIANT_NOT_ALLOWED";
  if (opts.requireActive) {
    if (!product.isActive) return "PRODUCT_ARCHIVED";
    if (variant && !variant.isActive) return "VARIANT_ARCHIVED";
  }
  return null;
}

/** Reason a scanned code resolves but cannot be sold. Product archive wins over variant archive. */
export function lookupReason(product: SeamProduct, variant: SeamVariant | null): LookupNotSellableReason | null {
  if (!product.isActive) return "PRODUCT_ARCHIVED";
  if (variant && !variant.isActive) return "VARIANT_ARCHIVED";
  if (!variant && product.hasVariants) return "VARIANT_REQUIRED";
  return null;
}

/**
 * Display name of an item. A variant's own name ("Large") is not enough on a
 * receipt, so variant items read "<product> - <variant>". The Arabic name is
 * composed only when either side has one (falling back to the English part).
 */
export function itemNames(
  product: Pick<SeamProduct, "name" | "nameAr">,
  variant: Pick<SeamVariant, "name" | "nameAr"> | null,
): { name: string; nameAr: string | null } {
  if (!variant) return { name: product.name, nameAr: product.nameAr };
  const name = `${product.name} - ${variant.name}`;
  const nameAr =
    product.nameAr === null && variant.nameAr === null
      ? null
      : `${product.nameAr ?? product.name} - ${variant.nameAr ?? variant.name}`;
  return { name, nameAr };
}

/** Effective price: variant price, else the product price (C-3). */
export function effectivePrice(product: Pick<SeamProduct, "priceMinor">, variant: SeamVariant | null): number {
  return variant?.priceMinor ?? product.priceMinor;
}

/** Full row for other modules (includes cost) — the SaleItem snapshot source. */
export function toSellableItem(product: SeamProduct, variant: SeamVariant | null): SellableItem {
  return {
    ...toSellableSummary(product, variant),
    costMinor: variant?.costMinor ?? product.costMinor,
  };
}

/** Cost-free row for POS screens. */
export function toSellableSummary(product: SeamProduct, variant: SeamVariant | null): SellableSummary {
  return {
    productId: product.id,
    variantId: variant?.id ?? null,
    sku: variant?.sku ?? product.sku,
    ...itemNames(product, variant),
    unitType: product.unitType,
    unitPriceMinor: effectivePrice(product, variant),
    vatCategory: product.vatCategory,
    vatApplicable: product.vatApplicable,
    ...(product.categoryId !== undefined && { categoryId: product.categoryId }),
    ...optionGroupsOf(product),
  };
}

/** Active groups that still have a choice; nothing for an item without any. */
function optionGroupsOf(product: SeamProduct): { optionGroups?: OptionGroupView[] } {
  const groups = (product.optionGroups ?? []).flatMap(({ group: { isActive, ...group } }) =>
    isActive && group.choices.length > 0 ? [group] : [],
  );
  return groups.length > 0 ? { optionGroups: groups } : {};
}

/** Picker order: active first, then sortOrder, name, id. */
export function compareVariantOptions(a: SeamVariant, b: SeamVariant): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Picker rows for a product with variants (raw variant names: the picker sits under the product). */
export function variantOptions(product: SeamProduct, variants: SeamVariant[]): LookupVariantOption[] {
  return [...variants].sort(compareVariantOptions).map((v) => ({
    variantId: v.id,
    sku: v.sku,
    name: v.name,
    nameAr: v.nameAr,
    unitPriceMinor: effectivePrice(product, v),
    sellable: product.isActive && v.isActive,
  }));
}
