import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { createProduct, createTenant, shortUpper, testDb } from "./helpers";

/**
 * Invariants added by the catalog_hardening migration
 * (docs/planning/phase-6/catalog-data-model.md §2–§5). They run against the real
 * PostgreSQL schema, so they prove the database itself rejects bad rows.
 */
let db: Db;
let tenantA: Awaited<ReturnType<typeof createTenant>>;
let tenantB: Awaited<ReturnType<typeof createTenant>>;

beforeAll(async () => {
  db = testDb();
  tenantA = await createTenant(db, "Catalog A");
  tenantB = await createTenant(db, "Catalog B");
});

afterAll(async () => {
  await db.$disconnect();
});

const sku = (prefix = "SKU") => `${prefix}-${shortUpper()}`;
const code = () => `C${Date.now()}${shortUpper()}`;

async function createVariant(orgId: string, productId: string, variantSku = sku("VAR")) {
  return db.productVariant.create({ data: { orgId, productId, sku: variantSku, name: `Variant ${variantSku}` } });
}

async function createCategory(orgId: string, name: string, parentId?: string) {
  return db.category.create({ data: { orgId, name, parentId } });
}

describe("new columns and defaults", () => {
  it("defaults the new catalog and org columns", async () => {
    const product = await createProduct(db, tenantA.org.id);
    expect(product).toMatchObject({ hasVariants: false, vatCategory: "STANDARD", vatApplicable: true });
    const variant = await createVariant(tenantA.org.id, product.id);
    expect(variant.sortOrder).toBe(0);
    const barcode = await db.barcode.create({ data: { orgId: tenantA.org.id, code: code(), productId: product.id } });
    expect(barcode.isPrimary).toBe(false);
    expect(barcode.updatedAt).toBeInstanceOf(Date);
    const category = await createCategory(tenantA.org.id, `Cat ${randomUUID()}`);
    expect(category.sortOrder).toBe(0);
    expect(tenantA.org.pricesIncludeVat).toBe(true);
  });
});

describe("SKU format", () => {
  it.each([
    ["lower-case", "sku-lower"],
    ["leading/trailing spaces", " SKU-PAD "],
    ["empty", ""],
    ["longer than 64 chars", "X".repeat(65)],
  ])("rejects a product SKU that is %s", async (_label, badSku) => {
    await expect(
      db.product.create({ data: { orgId: tenantA.org.id, sku: badSku, name: "Bad SKU", priceMinor: 100 } }),
    ).rejects.toThrow();
  });

  it("accepts a 64-char upper-case SKU", async () => {
    const longSku = `L${shortUpper()}`.padEnd(64, "9");
    await expect(createProduct(db, tenantA.org.id, longSku)).resolves.toMatchObject({ sku: longSku });
  });

  it("rejects a lower-case variant SKU", async () => {
    const product = await createProduct(db, tenantA.org.id);
    await expect(createVariant(tenantA.org.id, product.id, "var-lower")).rejects.toThrow();
  });
});

describe("product name", () => {
  it("rejects a blank product name", async () => {
    await expect(
      db.product.create({ data: { orgId: tenantA.org.id, sku: sku(), name: "   ", priceMinor: 100 } }),
    ).rejects.toThrow();
  });
});

describe("VAT category", () => {
  it("keeps vatApplicable consistent with vatCategory", async () => {
    const base = { orgId: tenantA.org.id, name: "VAT test", priceMinor: 100 };
    await expect(
      db.product.create({ data: { ...base, sku: sku(), vatApplicable: false, vatCategory: "STANDARD" } }),
    ).rejects.toThrow();
    await expect(
      db.product.create({ data: { ...base, sku: sku(), vatApplicable: true, vatCategory: "EXEMPT" } }),
    ).rejects.toThrow();
    await expect(
      db.product.create({ data: { ...base, sku: sku(), vatApplicable: false, vatCategory: "ZERO_RATED" } }),
    ).resolves.toMatchObject({ vatCategory: "ZERO_RATED" });
  });
});

describe("barcode code format", () => {
  it.each([
    ["contains a space", "622 123"],
    ["contains non-ASCII", "٦٢٢١٢٣"],
    ["longer than 64 chars", "1".repeat(65)],
    ["empty", ""],
  ])("rejects a code that %s", async (_label, badCode) => {
    const product = await createProduct(db, tenantA.org.id);
    await expect(
      db.barcode.create({ data: { orgId: tenantA.org.id, code: badCode, productId: product.id } }),
    ).rejects.toThrow();
  });
});

describe("primary barcode", () => {
  it("allows one primary per product without variants", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const data = { orgId: tenantA.org.id, productId: product.id, isPrimary: true };
    await db.barcode.create({ data: { ...data, code: code() } });
    // variantId NULL must still collide (NULLS NOT DISTINCT).
    await expect(db.barcode.create({ data: { ...data, code: code() } })).rejects.toThrow();
    // Non-primary codes are unlimited.
    await db.barcode.create({ data: { ...data, code: code(), isPrimary: false } });
  });

  it("allows one primary per variant, independent of the product-level primary", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const variant = await createVariant(tenantA.org.id, product.id);
    const base = { orgId: tenantA.org.id, productId: product.id, isPrimary: true };
    await db.barcode.create({ data: { ...base, code: code() } });
    await db.barcode.create({ data: { ...base, variantId: variant.id, code: code() } });
    await expect(db.barcode.create({ data: { ...base, variantId: variant.id, code: code() } })).rejects.toThrow();
  });
});

describe("barcode variant must belong to the barcode's product", () => {
  it("rejects a variant of another product in the same org", async () => {
    const productA = await createProduct(db, tenantA.org.id);
    const productB = await createProduct(db, tenantA.org.id);
    const variantOfB = await createVariant(tenantA.org.id, productB.id);
    await expect(
      db.barcode.create({
        data: { orgId: tenantA.org.id, code: code(), productId: productA.id, variantId: variantOfB.id },
      }),
    ).rejects.toThrow();
    await expect(
      db.barcode.create({
        data: { orgId: tenantA.org.id, code: code(), productId: productB.id, variantId: variantOfB.id },
      }),
    ).resolves.toMatchObject({ variantId: variantOfB.id });
  });

  it("rejects a variant from another tenant", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const foreignProduct = await createProduct(db, tenantB.org.id);
    const foreignVariant = await createVariant(tenantB.org.id, foreignProduct.id);
    await expect(
      db.barcode.create({
        data: { orgId: tenantA.org.id, code: code(), productId: product.id, variantId: foreignVariant.id },
      }),
    ).rejects.toThrow();
  });

  it("rejects moving a barcode to another product while keeping its variant", async () => {
    const productA = await createProduct(db, tenantA.org.id);
    const productB = await createProduct(db, tenantA.org.id);
    const variantOfA = await createVariant(tenantA.org.id, productA.id);
    const barcode = await db.barcode.create({
      data: { orgId: tenantA.org.id, code: code(), productId: productA.id, variantId: variantOfA.id },
    });
    await expect(db.barcode.update({ where: { id: barcode.id }, data: { productId: productB.id } })).rejects.toThrow();
  });
});

describe("category sibling names", () => {
  it("rejects a case-insensitive duplicate among root categories", async () => {
    const name = `Drinks ${randomUUID()}`;
    await createCategory(tenantA.org.id, name);
    await expect(createCategory(tenantA.org.id, name.toUpperCase())).rejects.toThrow();
    // Same name in another tenant is fine.
    await expect(createCategory(tenantB.org.id, name)).resolves.toMatchObject({ name });
  });

  it("rejects a duplicate under the same parent but allows it under another parent", async () => {
    const parent1 = await createCategory(tenantA.org.id, `Parent ${randomUUID()}`);
    const parent2 = await createCategory(tenantA.org.id, `Parent ${randomUUID()}`);
    await createCategory(tenantA.org.id, "Soft drinks", parent1.id);
    await expect(createCategory(tenantA.org.id, "soft DRINKS", parent1.id)).rejects.toThrow();
    await expect(createCategory(tenantA.org.id, "Soft drinks", parent2.id)).resolves.toMatchObject({
      parentId: parent2.id,
    });
  });
});

describe("one SKU namespace across products and variants", () => {
  it("rejects a variant that reuses a product SKU", async () => {
    const product = await createProduct(db, tenantA.org.id);
    await expect(createVariant(tenantA.org.id, product.id, product.sku)).rejects.toThrow(/sku_namespace/);
  });

  it("rejects a product that reuses a variant SKU", async () => {
    const owner = await createProduct(db, tenantA.org.id);
    const variant = await createVariant(tenantA.org.id, owner.id);
    await expect(createProduct(db, tenantA.org.id, variant.sku)).rejects.toThrow(/sku_namespace/);
  });

  it("rejects renaming a variant SKU onto a product SKU", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const variant = await createVariant(tenantA.org.id, product.id);
    await expect(db.productVariant.update({ where: { id: variant.id }, data: { sku: product.sku } })).rejects.toThrow(
      /sku_namespace/,
    );
  });

  it("reports the collision as a unique violation", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const error: unknown = await createVariant(tenantA.org.id, product.id, product.sku).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "P2002" });
  });

  it("allows the same SKU in another tenant", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const foreignProduct = await createProduct(db, tenantB.org.id);
    await expect(createVariant(tenantB.org.id, foreignProduct.id, product.sku)).resolves.toMatchObject({
      sku: product.sku,
    });
  });

  it("lets exactly one of two concurrent writers claim a SKU", async () => {
    for (let round = 0; round < 5; round++) {
      const shared = sku("RACE");
      const owner = await createProduct(db, tenantA.org.id);
      // Each writer holds its transaction open after the insert, so without the
      // advisory lock both cross-table checks would pass.
      const results = await Promise.allSettled([
        db.$transaction(async (tx) => {
          await tx.product.create({ data: { orgId: tenantA.org.id, sku: shared, name: "Racer", priceMinor: 1 } });
          await tx.$queryRaw`SELECT pg_sleep(0.2)::text`;
        }),
        db.$transaction(async (tx) => {
          await tx.productVariant.create({
            data: { orgId: tenantA.org.id, productId: owner.id, sku: shared, name: "Racer" },
          });
          await tx.$queryRaw`SELECT pg_sleep(0.2)::text`;
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const [products, variants] = await Promise.all([
        db.product.count({ where: { orgId: tenantA.org.id, sku: shared } }),
        db.productVariant.count({ where: { orgId: tenantA.org.id, sku: shared } }),
      ]);
      expect(products + variants).toBe(1);
    }
  });
});
