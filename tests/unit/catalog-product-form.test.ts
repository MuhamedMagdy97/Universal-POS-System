import { describe, expect, it } from "vitest";
import type { ProductDetail } from "@/modules/catalog/schemas";
import {
  buildCreatePayload,
  buildUpdatePayload,
  emptyFormState,
  emptyVariantRow,
  formStateFromProduct,
  otherCodesThan,
  priceBelowCost,
} from "@/app/(app)/catalog/_lib/product-form-model";

const messages = { required: "REQ", invalidAmount: "AMT" };
const withCost = { currency: "EGP" as const, canSeeCost: true, messages };
const noCost = { currency: "EGP" as const, canSeeCost: false, messages };

const product: ProductDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  sku: "TEA-1",
  name: "Tea",
  nameAr: null,
  categoryId: null,
  unitType: "EACH",
  priceMinor: 1250,
  costMinor: 800,
  vatCategory: "STANDARD",
  vatApplicable: true,
  hasVariants: true,
  variantCount: 1,
  primaryBarcode: null,
  isActive: true,
  updatedAt: "2026-10-11T10:00:00.000Z",
  createdAt: "2026-10-11T09:00:00.000Z",
  variants: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      productId: "11111111-1111-4111-8111-111111111111",
      sku: "TEA-1-L",
      name: "Large",
      nameAr: "كبير",
      priceMinor: null,
      costMinor: 900,
      isActive: true,
      updatedAt: "2026-10-11T10:05:00.000Z",
    },
  ],
  barcodes: [
    { id: "b1", code: "111", productId: "11111111-1111-4111-8111-111111111111", variantId: null, isPrimary: false },
    {
      id: "b2",
      code: "222",
      productId: "11111111-1111-4111-8111-111111111111",
      variantId: "22222222-2222-4222-8222-222222222222",
      isPrimary: false,
    },
  ],
};

describe("product form model", () => {
  it("builds form state from a product, splitting barcodes per item", () => {
    const state = formStateFromProduct(product, "EGP");
    expect(state).toMatchObject({ sku: "TEA-1", price: "12.50", cost: "8.00", barcodes: ["111"] });
    expect(state.variants[0]).toMatchObject({ price: "", cost: "9.00", barcodes: ["222"], nameAr: "كبير" });
    expect(otherCodesThan(state, "barcodes")).toEqual(["222"]);
  });

  it("puts each item's primary barcode first (first chip = primary)", () => {
    const pid = product.id;
    const state = formStateFromProduct(
      {
        ...product,
        barcodes: [
          { id: "b1", code: "111", productId: pid, variantId: null, isPrimary: false },
          { id: "b3", code: "333", productId: pid, variantId: null, isPrimary: true },
          { id: "b4", code: "444", productId: pid, variantId: null, isPrimary: false },
        ],
      },
      "EGP",
    );
    expect(state.barcodes).toEqual(["333", "111", "444"]);
    const result = buildUpdatePayload(state, product.updatedAt, withCost);
    expect(result.ok && result.payload.barcodes[0]).toBe("333");
  });

  it("requires name, SKU and price before calling the server", () => {
    const result = buildCreatePayload(emptyFormState(), withCost);
    expect(result).toEqual({ ok: false, fields: { name: "REQ", sku: "REQ", priceMinor: "REQ" } });
  });

  it("converts major units and blank variant prices to inherit (null)", () => {
    const state = {
      ...emptyFormState(),
      sku: "a-1",
      name: "Tea",
      price: "١٢٫٥٠",
      cost: "",
      barcodes: ["111"],
      variants: [{ ...emptyVariantRow("k"), sku: "a-1-l", name: "Large", price: "", cost: "3" }],
    };
    const result = buildCreatePayload(state, withCost);
    expect(result).toEqual({
      ok: true,
      payload: {
        product: {
          sku: "a-1",
          name: "Tea",
          nameAr: null,
          categoryId: null,
          priceMinor: 1250,
          costMinor: 0,
          vatCategory: "STANDARD",
          unitType: "EACH",
        },
        barcodes: ["111"],
        variants: [{ sku: "a-1-l", name: "Large", nameAr: null, priceMinor: null, costMinor: 300, barcodes: [] }],
      },
    });
  });

  it("never sends cost for users who cannot see it", () => {
    const state = { ...formStateFromProduct(product, "EGP"), cost: "" };
    const result = buildUpdatePayload(state, product.updatedAt, noCost);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.product).not.toHaveProperty("costMinor");
    expect(result.payload.variants[0]).not.toHaveProperty("costMinor");
    expect(result.payload.product.expectedUpdatedAt).toBe(product.updatedAt);
    expect(result.payload.variants[0]).toMatchObject({
      id: product.variants[0]?.id,
      expectedUpdatedAt: "2026-10-11T10:05:00.000Z",
    });
  });

  it("reports invalid amounts per field", () => {
    const state = {
      ...emptyFormState(),
      sku: "A",
      name: "B",
      price: "12.345",
      variants: [{ ...emptyVariantRow("k"), sku: "C", name: "D", price: "-1" }],
    };
    expect(buildCreatePayload(state, withCost)).toEqual({
      ok: false,
      fields: { priceMinor: "AMT", "variants.0.priceMinor": "AMT" },
    });
  });

  it("warns when an effective price is below cost", () => {
    expect(priceBelowCost({ ...emptyFormState(), price: "5", cost: "6" }, "EGP")).toBe(true);
    expect(priceBelowCost({ ...emptyFormState(), price: "6", cost: "5" }, "EGP")).toBe(false);
    const inherited = {
      ...emptyFormState(),
      price: "6",
      cost: "5",
      variants: [{ ...emptyVariantRow("k"), cost: "7" }],
    };
    expect(priceBelowCost(inherited, "EGP")).toBe(true);
  });
});
