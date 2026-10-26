import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import { createMember, createTenant, detailsOf, expectAppError, shortUpper, testDb, uniqueCode } from "./helpers";

/** Cross-module seam (T3.5): lookupCode, searchSellable, getSellableItems, getItemsForHistory, assertStockable. */
let db: Db;
let orgId: string;
let otherOrgId: string;
let admin: TenantContext;
let cashier: TenantContext;
let reporting: TenantContext;
let otherAdmin: TenantContext;

const sku = (prefix = "SM") => `${prefix}-${shortUpper()}`;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Seam");
  const other = await createTenant(db, "SeamOther");
  orgId = tenant.org.id;
  otherOrgId = other.org.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
  reporting = await createMember(db, orgId, "REPORTING");
  otherAdmin = await createMember(db, otherOrgId, "ADMIN");
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

/** Simple product (no variants) with one barcode. */
async function simpleProduct(opts: { priceMinor?: number; costMinor?: number; name?: string } = {}) {
  const code = uniqueCode();
  const product = await catalog.createProduct(admin, {
    sku: sku(),
    name: opts.name ?? "Simple Item",
    nameAr: "منتج",
    priceMinor: opts.priceMinor ?? 1500,
    costMinor: opts.costMinor ?? 900,
    vatCategory: "STANDARD",
    barcodes: [code],
  });
  return { product, code };
}

/** Product with two variants: one inherits price/cost, one overrides. Product-level barcode too. */
async function variantProduct(name = "Shirt") {
  const productCode = uniqueCode();
  const product = await catalog.createProduct(admin, {
    sku: sku("SH"),
    name,
    priceMinor: 2000,
    costMinor: 1200,
    vatCategory: "ZERO_RATED",
    barcodes: [productCode],
  });
  const largeCode = uniqueCode();
  const large = await catalog.createVariant(admin, product.id, {
    sku: sku("L"),
    name: "Large",
    nameAr: "كبير",
    priceMinor: 2500,
    costMinor: 1300,
    barcodes: [largeCode],
  });
  const small = await catalog.createVariant(admin, product.id, { sku: sku("S"), name: "Small" });
  await db.productVariant.update({ where: { id: large.id }, data: { sortOrder: 2 } });
  await db.productVariant.update({ where: { id: small.id }, data: { sortOrder: 1 } });
  return { product, productCode, large, largeCode, small };
}

describe("lookupCode", () => {
  it("resolves a product barcode with price, VAT and names, never cost", async () => {
    const { product, code } = await simpleProduct();
    const result = await catalog.lookupCode(cashier, code);
    expect(result).toEqual({
      productId: product.id,
      variantId: null,
      sku: product.sku,
      name: "Simple Item",
      nameAr: "منتج",
      unitType: "EACH",
      unitPriceMinor: 1500,
      vatCategory: "STANDARD",
      vatApplicable: true,
      categoryId: null,
      isService: false,
      durationMin: null,
      sellable: true,
    });
    expect(result).not.toHaveProperty("costMinor");
  });

  it("resolves a variant barcode with the variant price and composed name", async () => {
    const { product, large, largeCode } = await variantProduct();
    const result = await catalog.lookupCode(admin, largeCode);
    expect(result).toMatchObject({
      productId: product.id,
      variantId: large.id,
      sku: large.sku,
      name: "Shirt - Large",
      nameAr: "Shirt - كبير",
      unitPriceMinor: 2500,
      vatCategory: "ZERO_RATED",
      vatApplicable: false,
      sellable: true,
    });
    expect(result).not.toHaveProperty("reason");
    expect(result).not.toHaveProperty("costMinor");
  });

  it("falls back to SKU (upper-cased) for products and variants", async () => {
    const { product } = await simpleProduct();
    expect((await catalog.lookupCode(cashier, product.sku.toLowerCase())).productId).toBe(product.id);

    const { small } = await variantProduct();
    const result = await catalog.lookupCode(cashier, small.sku.toLowerCase());
    expect(result.variantId).toBe(small.id);
    // Small inherits the product price (C-3).
    expect(result.unitPriceMinor).toBe(2000);
  });

  it("matches barcodes exactly (no case folding)", async () => {
    const code = `ab${uniqueCode()}`;
    await catalog.createProduct(admin, { sku: sku(), name: "Case", priceMinor: 100, barcodes: [code] });
    await expect(catalog.lookupCode(cashier, code)).resolves.toMatchObject({ sellable: true });
    await expectAppError(catalog.lookupCode(cashier, code.toUpperCase()), 404, "UNKNOWN_CODE");
  });

  it("answers VARIANT_REQUIRED with a picker list for a product-level code", async () => {
    const { product, productCode, large, small } = await variantProduct();
    await db.productVariant.update({ where: { id: small.id }, data: { isActive: false } });

    for (const code of [productCode, product.sku]) {
      const result = await catalog.lookupCode(cashier, code);
      expect(result).toMatchObject({ productId: product.id, variantId: null, sellable: false });
      expect(result.reason).toBe("VARIANT_REQUIRED");
      // Active first (Large), then the archived Small despite its lower sortOrder.
      expect(result.variants).toEqual([
        { variantId: large.id, sku: large.sku, name: "Large", nameAr: "كبير", unitPriceMinor: 2500, sellable: true },
        { variantId: small.id, sku: small.sku, name: "Small", nameAr: null, unitPriceMinor: 2000, sellable: false },
      ]);
      expect(JSON.stringify(result)).not.toContain("costMinor");
    }
  });

  it("resolves archived products and variants with sellable:false and a reason (R8)", async () => {
    const { product, code } = await simpleProduct();
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    await expect(catalog.lookupCode(cashier, code)).resolves.toMatchObject({
      productId: product.id,
      sellable: false,
      reason: "PRODUCT_ARCHIVED",
    });

    const shirt = await variantProduct();
    await db.productVariant.update({ where: { id: shirt.large.id }, data: { isActive: false } });
    await expect(catalog.lookupCode(cashier, shirt.largeCode)).resolves.toMatchObject({
      variantId: shirt.large.id,
      sellable: false,
      reason: "VARIANT_ARCHIVED",
    });

    // Product archive wins over variant archive; no picker on an archived product.
    await db.product.update({ where: { id: shirt.product.id }, data: { isActive: false } });
    await expect(catalog.lookupCode(cashier, shirt.largeCode)).resolves.toMatchObject({ reason: "PRODUCT_ARCHIVED" });
    const productLevel = await catalog.lookupCode(cashier, shirt.productCode);
    expect(productLevel.reason).toBe("PRODUCT_ARCHIVED");
    expect(productLevel.variants).toBeUndefined();
  });

  it("answers 404 UNKNOWN_CODE for unknown, malformed and other-org codes (C-10)", async () => {
    await expectAppError(catalog.lookupCode(cashier, uniqueCode()), 404, "UNKNOWN_CODE");
    await expectAppError(catalog.lookupCode(cashier, "has space"), 404, "UNKNOWN_CODE");
    await expectAppError(catalog.lookupCode(cashier, ""), 404, "UNKNOWN_CODE");

    const foreignCode = uniqueCode();
    const foreign = await catalog.createProduct(otherAdmin, {
      sku: sku("FX"),
      name: "Foreign",
      priceMinor: 100,
      barcodes: [foreignCode],
    });
    await expectAppError(catalog.lookupCode(cashier, foreignCode), 404, "UNKNOWN_CODE");
    await expectAppError(catalog.lookupCode(cashier, foreign.sku), 404, "UNKNOWN_CODE");
  });

  it("requires products.read: Cashier may scan, Reporting may not", async () => {
    const { code } = await simpleProduct();
    await expect(catalog.lookupCode(cashier, code)).resolves.toMatchObject({ sellable: true });
    await expectAppError(catalog.lookupCode(reporting, code), 403);
  });
});

describe("searchSellable", () => {
  it("returns active items only, expands variants, and never includes cost", async () => {
    const tag = shortUpper();
    const { product: simple } = await simpleProduct({ name: `Alpha ${tag}` });
    const archived = await simpleProduct({ name: `Alpha ${tag} old` });
    await db.product.update({ where: { id: archived.product.id }, data: { isActive: false } });
    const shirt = await variantProduct(`Beta ${tag}`);
    await db.productVariant.update({ where: { id: shirt.small.id }, data: { isActive: false } });

    const rows = await catalog.searchSellable(cashier, tag);
    expect(rows.map((r) => [r.productId, r.variantId])).toEqual([
      [simple.id, null],
      [shirt.product.id, shirt.large.id],
    ]);
    expect(rows[1]).toMatchObject({ name: `Beta ${tag} - Large`, unitPriceMinor: 2500 });
    for (const row of rows) expect(row).not.toHaveProperty("costMinor");
  });

  it("puts an exact barcode hit first and matches variant SKUs", async () => {
    const { product, code } = await simpleProduct({ name: "Zulu barcode item" });
    const rows = await catalog.searchSellable(cashier, code);
    expect(rows[0]).toMatchObject({ productId: product.id, variantId: null });

    const shirt = await variantProduct();
    const bySku = await catalog.searchSellable(cashier, shirt.small.sku.toLowerCase());
    expect(bySku.map((r) => r.variantId)).toEqual([shirt.small.id]);

    // A product-level barcode on a product with variants expands to its active variants.
    const byProductCode = await catalog.searchSellable(cashier, shirt.productCode);
    expect(byProductCode.slice(0, 2).map((r) => r.variantId)).toEqual([shirt.small.id, shirt.large.id]);
  });

  it("escapes LIKE wildcards, applies the limit and validates it", async () => {
    const tag = shortUpper();
    for (let i = 0; i < 3; i += 1) await simpleProduct({ name: `Gamma ${tag} ${i}` });
    expect(await catalog.searchSellable(cashier, `${tag}%`)).toEqual([]);
    expect(await catalog.searchSellable(cashier, tag, 2)).toHaveLength(2);
    expect(await catalog.searchSellable(cashier, tag)).toHaveLength(3);
    await expect(catalog.searchSellable(cashier, tag, 51)).rejects.toThrow();
    await expect(catalog.searchSellable(cashier, "  ")).rejects.toThrow();
  });

  it("is tenant-scoped and requires products.read", async () => {
    const tag = shortUpper();
    await catalog.createProduct(otherAdmin, { sku: sku("FX"), name: `Foreign ${tag}`, priceMinor: 100 });
    expect(await catalog.searchSellable(cashier, tag)).toEqual([]);
    await expectAppError(catalog.searchSellable(reporting, tag), 403);
  });
});

describe("getSellableItems", () => {
  it("returns rows in input order with duplicates, cost, snapshot fields and inherited prices (C-3)", async () => {
    const { product: simple } = await simpleProduct();
    const shirt = await variantProduct();
    const refs = [
      { productId: shirt.product.id, variantId: shirt.small.id },
      { productId: simple.id, variantId: null },
      { productId: shirt.product.id, variantId: shirt.large.id },
      { productId: simple.id, variantId: null },
    ];
    const items = await catalog.getSellableItems(getDb(), orgId, refs);
    expect(items.map((i) => [i.productId, i.variantId])).toEqual(refs.map((r) => [r.productId, r.variantId]));
    expect(items[0]).toEqual({
      productId: shirt.product.id,
      variantId: shirt.small.id,
      sku: shirt.small.sku,
      name: "Shirt - Small",
      nameAr: null,
      unitType: "EACH",
      unitPriceMinor: 2000,
      costMinor: 1200,
      vatCategory: "ZERO_RATED",
      vatApplicable: false,
      categoryId: null,
      isService: false,
      durationMin: null,
    });
    expect(items[1]).toMatchObject({ sku: simple.sku, name: "Simple Item", unitPriceMinor: 1500, costMinor: 900 });
    expect(items[2]).toMatchObject({ unitPriceMinor: 2500, costMinor: 1300 });
    expect(items[3]).toEqual(items[1]);
    expect(await catalog.getSellableItems(getDb(), orgId, [])).toEqual([]);
  });

  it("works inside a transaction", async () => {
    const { product } = await simpleProduct();
    const items = await getDb().$transaction((tx) =>
      catalog.getSellableItems(tx, orgId, [{ productId: product.id, variantId: null }]),
    );
    expect(items[0].productId).toBe(product.id);
  });

  it("answers 422 ITEM_NOT_SELLABLE with the offending index for each rule", async () => {
    const { product: simple } = await simpleProduct();
    const archived = await simpleProduct();
    await db.product.update({ where: { id: archived.product.id }, data: { isActive: false } });
    const shirt = await variantProduct();
    const other = await variantProduct("Other shirt");
    await db.productVariant.update({ where: { id: shirt.small.id }, data: { isActive: false } });
    const ok = { productId: simple.id, variantId: null };

    const cases: [{ productId: string; variantId: string | null }, string][] = [
      [{ productId: archived.product.id, variantId: null }, "PRODUCT_ARCHIVED"],
      [{ productId: shirt.product.id, variantId: shirt.small.id }, "VARIANT_ARCHIVED"],
      [{ productId: shirt.product.id, variantId: other.large.id }, "VARIANT_PRODUCT_MISMATCH"],
      [{ productId: shirt.product.id, variantId: null }, "VARIANT_REQUIRED"],
      [{ productId: simple.id, variantId: shirt.large.id }, "VARIANT_PRODUCT_MISMATCH"],
    ];
    for (const [ref, cause] of cases) {
      const err = await expectAppError(catalog.getSellableItems(getDb(), orgId, [ok, ref]), 422, "ITEM_NOT_SELLABLE");
      expect(detailsOf(err)).toMatchObject({ index: 1, cause });
    }
  });

  it("answers 422 VARIANT_NOT_ALLOWED when a variant is given for a product without variants", async () => {
    // Only reachable with corrupt data (hasVariants=false but a variant row exists).
    const { product } = await simpleProduct();
    const variant = await db.productVariant.create({
      data: { orgId, productId: product.id, sku: sku("NV"), name: "Stray" },
    });
    const err = await expectAppError(
      catalog.getSellableItems(getDb(), orgId, [{ productId: product.id, variantId: variant.id }]),
      422,
      "ITEM_NOT_SELLABLE",
    );
    expect(detailsOf(err)).toMatchObject({ index: 0, cause: "VARIANT_NOT_ALLOWED" });
  });

  it("answers 404 for unknown, malformed and other-org refs", async () => {
    const { product } = await simpleProduct();
    const foreign = await catalog.createProduct(otherAdmin, { sku: sku("FX"), name: "Foreign", priceMinor: 1 });
    const foreignShirt = await catalog.createProduct(otherAdmin, { sku: sku("FX"), name: "F shirt", priceMinor: 1 });
    const foreignVariant = await catalog.createVariant(otherAdmin, foreignShirt.id, { sku: sku("FV"), name: "FV" });
    const ok = { productId: product.id, variantId: null };

    const refs = [
      { productId: foreign.id, variantId: null },
      { productId: "00000000-0000-4000-8000-000000000000", variantId: null },
      { productId: "not-a-uuid", variantId: null },
      { productId: product.id, variantId: foreignVariant.id },
      { productId: product.id, variantId: "nope" },
    ];
    for (const ref of refs) {
      const err = await expectAppError(catalog.getSellableItems(getDb(), orgId, [ok, ref]), 404);
      expect(detailsOf(err)).toMatchObject({ index: 1 });
    }
    // The foreign org itself can resolve its own item.
    await expect(
      catalog.getSellableItems(getDb(), otherOrgId, [{ productId: foreign.id, variantId: null }]),
    ).resolves.toHaveLength(1);
  });
});

describe("getItemsForHistory", () => {
  it("accepts archived items but keeps the variant rule and tenant scope", async () => {
    const archived = await simpleProduct();
    await db.product.update({ where: { id: archived.product.id }, data: { isActive: false } });
    const shirt = await variantProduct();
    await db.productVariant.update({ where: { id: shirt.large.id }, data: { isActive: false } });

    const items = await catalog.getItemsForHistory(getDb(), orgId, [
      { productId: archived.product.id, variantId: null },
      { productId: shirt.product.id, variantId: shirt.large.id },
    ]);
    expect(items.map((i) => i.unitPriceMinor)).toEqual([1500, 2500]);

    const err = await expectAppError(
      catalog.getItemsForHistory(getDb(), orgId, [{ productId: shirt.product.id, variantId: null }]),
      422,
      "ITEM_NOT_SELLABLE",
    );
    expect(detailsOf(err)).toMatchObject({ cause: "VARIANT_REQUIRED" });
    await expectAppError(
      catalog.getItemsForHistory(getDb(), otherOrgId, [{ productId: archived.product.id, variantId: null }]),
      404,
    );
  });
});

describe("assertStockable", () => {
  it("passes for active items and throws the getSellableItems errors otherwise", async () => {
    const { product } = await simpleProduct();
    const shirt = await variantProduct();
    await expect(assertOk({ productId: product.id, variantId: null })).resolves.toBeUndefined();
    await expect(assertOk({ productId: shirt.product.id, variantId: shirt.large.id })).resolves.toBeUndefined();

    await expectAppError(assertOk({ productId: shirt.product.id, variantId: null }), 422, "ITEM_NOT_SELLABLE");
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    const err = await expectAppError(assertOk({ productId: product.id, variantId: null }), 422, "ITEM_NOT_SELLABLE");
    expect(detailsOf(err)).toMatchObject({ cause: "PRODUCT_ARCHIVED", index: 0 });
    await expectAppError(
      catalog.assertStockable(getDb(), otherOrgId, { productId: shirt.product.id, variantId: shirt.large.id }),
      404,
    );
  });
});

function assertOk(ref: { productId: string; variantId: string | null }) {
  return catalog.assertStockable(getDb(), orgId, ref);
}
