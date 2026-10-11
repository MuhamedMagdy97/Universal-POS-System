import { describe, expect, it } from "vitest";
import {
  compareVariantOptions,
  effectivePrice,
  itemNames,
  itemRefViolation,
  lookupReason,
  toSellableItem,
  toSellableSummary,
  variantOptions,
  type SeamProduct,
  type SeamVariant,
} from "@/modules/catalog/sellable";

const product = (over: Partial<SeamProduct> = {}): SeamProduct => ({
  id: "p1",
  sku: "P-1",
  name: "Shirt",
  nameAr: null,
  unitType: "EACH",
  priceMinor: 2000,
  costMinor: 1200,
  vatCategory: "STANDARD",
  vatApplicable: true,
  hasVariants: false,
  isActive: true,
  ...over,
});

const variant = (over: Partial<SeamVariant> = {}): SeamVariant => ({
  id: "v1",
  productId: "p1",
  sku: "P-1-L",
  name: "Large",
  nameAr: null,
  priceMinor: null,
  costMinor: null,
  isActive: true,
  sortOrder: 0,
  ...over,
});

describe("itemRefViolation", () => {
  const active = { requireActive: true };
  const history = { requireActive: false };

  it("accepts valid refs", () => {
    expect(itemRefViolation(product(), null, active)).toBeNull();
    expect(itemRefViolation(product({ hasVariants: true }), variant(), active)).toBeNull();
  });

  it("enforces the variant rule regardless of requireActive", () => {
    const withVariants = product({ hasVariants: true });
    for (const opts of [active, history]) {
      expect(itemRefViolation(withVariants, variant({ productId: "p2" }), opts)).toBe("VARIANT_PRODUCT_MISMATCH");
      expect(itemRefViolation(withVariants, null, opts)).toBe("VARIANT_REQUIRED");
      expect(itemRefViolation(product(), variant(), opts)).toBe("VARIANT_NOT_ALLOWED");
    }
  });

  it("rejects archived items only when requireActive", () => {
    const archived = product({ isActive: false, hasVariants: true });
    expect(itemRefViolation(archived, variant({ isActive: false }), active)).toBe("PRODUCT_ARCHIVED");
    expect(itemRefViolation(product({ hasVariants: true }), variant({ isActive: false }), active)).toBe(
      "VARIANT_ARCHIVED",
    );
    expect(itemRefViolation(archived, variant({ isActive: false }), history)).toBeNull();
  });
});

describe("lookupReason", () => {
  it("prefers product archive, then variant archive, then VARIANT_REQUIRED", () => {
    expect(lookupReason(product(), null)).toBeNull();
    expect(lookupReason(product({ isActive: false, hasVariants: true }), null)).toBe("PRODUCT_ARCHIVED");
    expect(lookupReason(product({ hasVariants: true }), variant({ isActive: false }))).toBe("VARIANT_ARCHIVED");
    expect(lookupReason(product({ hasVariants: true }), null)).toBe("VARIANT_REQUIRED");
    expect(lookupReason(product({ hasVariants: true }), variant())).toBeNull();
  });
});

describe("names and prices", () => {
  it("composes variant names and falls back to English for a missing Arabic side", () => {
    expect(itemNames(product({ nameAr: "قميص" }), null)).toEqual({ name: "Shirt", nameAr: "قميص" });
    expect(itemNames(product(), variant())).toEqual({ name: "Shirt - Large", nameAr: null });
    expect(itemNames(product({ nameAr: "قميص" }), variant())).toEqual({
      name: "Shirt - Large",
      nameAr: "قميص - Large",
    });
    expect(itemNames(product(), variant({ nameAr: "كبير" }))).toEqual({
      name: "Shirt - Large",
      nameAr: "Shirt - كبير",
    });
  });

  it("inherits price and cost from the product when the variant has none (C-3)", () => {
    expect(effectivePrice(product(), null)).toBe(2000);
    expect(effectivePrice(product(), variant())).toBe(2000);
    expect(effectivePrice(product(), variant({ priceMinor: 0 }))).toBe(0);
    expect(toSellableItem(product({ hasVariants: true }), variant({ costMinor: 5 }))).toMatchObject({
      sku: "P-1-L",
      variantId: "v1",
      unitPriceMinor: 2000,
      costMinor: 5,
    });
    expect(toSellableItem(product(), null).costMinor).toBe(1200);
  });

  it("never puts cost in a summary", () => {
    expect(toSellableSummary(product(), null)).not.toHaveProperty("costMinor");
  });
});

describe("variant picker", () => {
  it("orders active first, then sortOrder, name, id and resolves prices", () => {
    const rows = [
      variant({ id: "a", name: "XL", sortOrder: 0, isActive: false }),
      variant({ id: "b", name: "M", sortOrder: 2 }),
      variant({ id: "d", name: "S", sortOrder: 1, priceMinor: 1800 }),
      variant({ id: "c", name: "S", sortOrder: 1 }),
    ];
    expect([...rows].sort(compareVariantOptions).map((v) => v.id)).toEqual(["c", "d", "b", "a"]);
    const options = variantOptions(product({ hasVariants: true }), rows);
    expect(options.map((o) => [o.variantId, o.unitPriceMinor, o.sellable])).toEqual([
      ["c", 2000, true],
      ["d", 1800, true],
      ["b", 2000, true],
      ["a", 2000, false],
    ]);
    expect(variantOptions(product({ hasVariants: true, isActive: false }), rows).some((o) => o.sellable)).toBe(false);
  });
});
