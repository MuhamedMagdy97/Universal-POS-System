/**
 * Pure: one IMS product (`GET /api/products/{id}`) → the POS catalog shape (integration spec I7–I9).
 * Prices are IMS decimals (strings) → integer minor units, rounded half up at 2 places.
 */
import type { ExternalCategory, ExternalItem, ExternalVariant, NotSellableReason } from "@/modules/catalog/external";
import { MAX_CATEGORY_DEPTH } from "@/modules/catalog/rules";

/** The fields the POS reads from the IMS product detail (IMS `getProduct`, commit d412a6b). */
export type ImsVariant = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string | null;
  status: string;
  sellPrice: string | number | null;
  costPrice: string | number | null;
  barcodeAliases?: { barcode: string }[];
};

export type ImsProduct = {
  id: string;
  name: string;
  type: "simple" | "variant_parent";
  status: string;
  isSerialized: boolean;
  baseUom: string;
  categoryId?: string | null;
  variants: ImsVariant[];
};

/** One row of the IMS `GET /api/categories?includeArchived=true` (flat, tree order, depth ≤ 5). */
export type ImsCategory = {
  id: string;
  parentId: string | null;
  name: string;
  sort: number;
  archived: boolean;
};

export type MapResult = { item: ExternalItem; notes: string[] } | { item: null; notes: string[] };

const BARCODE = /^[\x21-\x7E]{1,64}$/;
const UNITS: Record<string, "EACH" | "KG"> = { each: "EACH", kg: "KG" };

/** "12.345" → { minor: 1235, rounded: true }. Null/blank/invalid → null. */
export function toMinor(value: string | number | null | undefined): { minor: number; rounded: boolean } | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  const minor = Number(match[1]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(minor) || minor > 2_147_483_647) return null;
  return { minor, rounded: /[1-9]/.test(fraction.slice(2)) };
}

function barcodesOf(variant: ImsVariant, notes: string[]): string[] {
  const all = [variant.barcode, ...(variant.barcodeAliases ?? []).map((a) => a.barcode)].filter(
    (code): code is string => typeof code === "string" && code !== "",
  );
  const valid = all.filter((code) => BARCODE.test(code));
  if (valid.length < all.length) notes.push(`BARCODE_INVALID:${variant.sku}`);
  return [...new Set(valid)];
}

function mapVariant(variant: ImsVariant, productReason: NotSellableReason | null, notes: string[]): ExternalVariant {
  const price = toMinor(variant.sellPrice);
  const cost = toMinor(variant.costPrice);
  if (price?.rounded) notes.push(`PRICE_ROUNDED:${variant.sku}`);
  const reason: NotSellableReason | null =
    productReason ?? (variant.status !== "active" ? "STATUS" : price === null ? "NO_PRICE" : null);
  return {
    externalVariantId: variant.id,
    sku: variant.sku.trim().toUpperCase().slice(0, 64),
    name: (variant.name?.trim() || variant.sku).slice(0, 120),
    priceMinor: price?.minor ?? 0,
    costMinor: cost?.minor ?? 0,
    isActive: reason === null,
    notSellableReason: reason,
    barcodes: barcodesOf(variant, notes),
  };
}

export function mapImsProduct(product: ImsProduct): MapResult {
  const notes: string[] = [];
  const unitType = UNITS[product.baseUom.toLowerCase()];
  if (!unitType) notes.push(`UNIT_UNSUPPORTED:${product.baseUom}`);
  const productReason: NotSellableReason | null =
    product.status !== "active" ? "STATUS" : product.isSerialized ? "SERIALIZED" : !unitType ? "UNIT" : null;
  const variants = product.variants.map((v) => mapVariant(v, productReason, notes));
  const base = {
    externalProductId: product.id,
    externalCategoryId: product.categoryId ?? null,
    name: product.name.trim().slice(0, 120) || product.id,
    unitType: unitType ?? "EACH",
  };

  if (product.type === "simple") {
    const [only] = variants;
    if (!only || variants.length > 1) return { item: null, notes: [...notes, `SHAPE_UNSUPPORTED:${product.id}`] };
    return { item: { ...only, ...base, variants: null }, notes };
  }

  // A product with variants has no SKU in the IMS; its POS SKU is derived from the IMS product id.
  // Its own price is only a fallback (each variant carries its price): the cheapest sellable one.
  const prices = variants.filter((v) => v.isActive).map((v) => v.priceMinor);
  return {
    item: {
      ...base,
      sku: `P-${product.id.replace(/-/g, "").toUpperCase()}`,
      priceMinor: prices.length > 0 ? Math.min(...prices) : 0,
      costMinor: 0,
      isActive: productReason === null,
      notSellableReason: productReason,
      externalVariantId: null,
      barcodes: [],
      variants,
    },
    notes,
  };
}

/**
 * IMS categories → POS categories, parents first. The POS tree is at most 3 deep and the IMS 5:
 * a deeper IMS category is not created; it (and its products) fold into its ancestor at the POS's last level.
 * `folded` maps each such IMS id to that ancestor's IMS id.
 */
export function mapImsCategories(rows: ImsCategory[]): {
  categories: ExternalCategory[];
  folded: Map<string, string>;
  notes: string[];
} {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chainOf = (row: ImsCategory): ImsCategory[] => {
    const chain = [row];
    for (let p = byId.get(row.parentId ?? ""); p && chain.length <= 5; p = byId.get(p.parentId ?? "")) chain.unshift(p);
    return chain; // root first
  };
  const categories: ExternalCategory[] = [];
  const folded = new Map<string, string>();
  const notes: string[] = [];
  for (const row of rows) {
    const chain = chainOf(row);
    if (chain.length > MAX_CATEGORY_DEPTH) {
      folded.set(row.id, chain[MAX_CATEGORY_DEPTH - 1].id);
      notes.push(`CATEGORY_FOLDED:${row.id}`);
      continue;
    }
    categories.push({
      externalCategoryId: row.id,
      externalParentId: chain.length > 1 ? chain[chain.length - 2].id : null,
      name: row.name.trim().slice(0, 120) || row.id,
      isActive: !row.archived,
      sortOrder: row.sort,
      depth: chain.length,
    });
  }
  categories.sort((a, b) => a.depth - b.depth);
  return { categories, folded, notes };
}
