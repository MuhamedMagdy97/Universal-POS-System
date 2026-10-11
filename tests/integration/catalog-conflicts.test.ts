import { ZodError } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import { createMember, createTenant, detailsOf, expectAppError, shortUpper, testDb, uniqueCode } from "./helpers";

/**
 * Uniqueness conflicts at the service layer (C-17…C-21, C-25): Prisma P2002 —
 * including the `sku_namespace` trigger — becomes 409 CONFLICT with
 * `{ reason, field, existingId }`, never a 500.
 */
let db: Db;
let tenantA: Awaited<ReturnType<typeof createTenant>>;
let tenantB: Awaited<ReturnType<typeof createTenant>>;
let adminA: TenantContext;
let adminB: TenantContext;

const sku = (prefix = "C") => `${prefix}-${shortUpper()}`;

beforeAll(async () => {
  db = testDb();
  tenantA = await createTenant(db, "Conflicts A");
  tenantB = await createTenant(db, "Conflicts B");
  adminA = await createMember(db, tenantA.org.id, "ADMIN");
  adminB = await createMember(db, tenantB.org.id, "OWNER");
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

describe("SKU (C-17, C-21, C-25)", () => {
  it("rejects a second product with the same SKU (any case) with field sku and existingId", async () => {
    const first = await catalog.createProduct(adminA, { sku: sku(), name: "First", priceMinor: 100 });
    const err = await expectAppError(
      catalog.createProduct(adminA, { sku: first.sku.toLowerCase(), name: "Second", priceMinor: 100 }),
      409,
      "SKU_TAKEN",
    );
    expect(err.code).toBe("CONFLICT");
    expect(detailsOf(err)).toMatchObject({ field: "sku", existingId: first.id, existingType: "product" });
  });

  it("rejects renaming a product onto an existing SKU", async () => {
    const first = await catalog.createProduct(adminA, { sku: sku(), name: "First", priceMinor: 100 });
    const second = await catalog.createProduct(adminA, { sku: sku(), name: "Second", priceMinor: 100 });
    const err = await expectAppError(
      catalog.updateProduct(adminA, second.id, { sku: first.sku, expectedUpdatedAt: second.updatedAt }),
      409,
      "SKU_TAKEN",
    );
    expect(detailsOf(err).existingId).toBe(first.id);
  });

  it("rejects a variant that reuses a product SKU (sku_namespace trigger)", async () => {
    const product = await catalog.createProduct(adminA, { sku: sku(), name: "Owner", priceMinor: 100 });
    const other = await catalog.createProduct(adminA, { sku: sku(), name: "Parent", priceMinor: 100 });
    const err = await expectAppError(
      catalog.createVariant(adminA, other.id, { sku: product.sku, name: "Clash" }),
      409,
      "SKU_TAKEN",
    );
    expect(detailsOf(err)).toMatchObject({ field: "sku", existingId: product.id, existingType: "product" });
    // The failed variant did not flip hasVariants on.
    expect((await catalog.getProduct(adminA, other.id)).hasVariants).toBe(false);
  });

  it("rejects a product that reuses a variant SKU (C-21)", async () => {
    const parent = await catalog.createProduct(adminA, { sku: sku(), name: "Parent", priceMinor: 100 });
    const variant = await catalog.createVariant(adminA, parent.id, { sku: sku("V"), name: "V" });
    const err = await expectAppError(
      catalog.createProduct(adminA, { sku: variant.sku, name: "Clash", priceMinor: 100 }),
      409,
      "SKU_TAKEN",
    );
    expect(detailsOf(err)).toMatchObject({
      existingId: variant.id,
      existingType: "variant",
      existingProductId: parent.id,
    });
  });

  it("keeps the SKU of an archived product reserved (C-25)", async () => {
    const product = await catalog.createProduct(adminA, { sku: sku(), name: "Old", priceMinor: 100 });
    await catalog.archiveProduct(adminA, product.id, { expectedUpdatedAt: product.updatedAt });
    const err = await expectAppError(
      catalog.createProduct(adminA, { sku: product.sku, name: "New", priceMinor: 100 }),
      409,
      "SKU_TAKEN",
    );
    expect(detailsOf(err).existingId).toBe(product.id);
  });

  it("allows the same SKU and barcode in another org (C-9)", async () => {
    const code = uniqueCode();
    const a = await catalog.createProduct(adminA, { sku: sku(), name: "A", priceMinor: 100, barcodes: [code] });
    await expect(
      catalog.createProduct(adminB, { sku: a.sku, name: "B", priceMinor: 100, barcodes: [code] }),
    ).resolves.toMatchObject({ sku: a.sku });
  });
});

describe("barcodes (C-18, C-19)", () => {
  it("names the owning product and the clashing index in barcodes[i]", async () => {
    const code = uniqueCode();
    const p = await catalog.createProduct(adminA, { sku: sku(), name: "P", priceMinor: 100, barcodes: [code] });
    const err = await expectAppError(
      catalog.createProduct(adminA, { sku: sku(), name: "Q", priceMinor: 100, barcodes: [uniqueCode(), code] }),
      409,
      "BARCODE_TAKEN",
    );
    expect(detailsOf(err)).toMatchObject({ field: "barcodes[1]", existingId: p.id, code });
  });

  it("rejects adding a taken code to another product or a variant (field code)", async () => {
    const code = uniqueCode();
    const p = await catalog.createProduct(adminA, { sku: sku(), name: "P", priceMinor: 100, barcodes: [code] });
    const q = await catalog.createProduct(adminA, { sku: sku(), name: "Q", priceMinor: 100 });
    const err = await expectAppError(catalog.addBarcode(adminA, { code, productId: q.id }), 409, "BARCODE_TAKEN");
    expect(detailsOf(err)).toMatchObject({ field: "code", existingId: p.id });

    const variant = await catalog.createVariant(adminA, q.id, { sku: sku("V"), name: "V" });
    await expectAppError(
      catalog.createVariant(adminA, q.id, { sku: sku("V"), name: "W", barcodes: [code] }),
      409,
      "BARCODE_TAKEN",
    );
    await expectAppError(
      catalog.addBarcode(adminA, { code, productId: q.id, variantId: variant.id }),
      409,
      "BARCODE_TAKEN",
    );
  });

  it("rejects the same barcode twice in one payload before the DB (422)", async () => {
    const code = uniqueCode();
    const productSku = sku();
    await expect(
      catalog.createProduct(adminA, { sku: productSku, name: "Twice", priceMinor: 100, barcodes: [code, code] }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await db.product.count({ where: { orgId: tenantA.org.id, sku: productSku } })).toBe(0);
  });
});

describe("concurrency (C-20)", () => {
  it("lets exactly one of several concurrent creates with the same SKU win; the rest get 409", async () => {
    const shared = sku("RACE");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        catalog.createProduct(adminA, { sku: shared, name: `Racer ${i}`, priceMinor: 100 }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(AppError);
      expect((r.reason as AppError).status).toBe(409);
      expect(detailsOf(r.reason as AppError).reason).toBe("SKU_TAKEN");
    }
    expect(await db.product.count({ where: { orgId: tenantA.org.id, sku: shared } })).toBe(1);
    expect(
      await db.auditEvent.count({
        where: {
          orgId: tenantA.org.id,
          action: "catalog.product.created",
          metadata: { path: ["sku"], equals: shared },
        },
      }),
    ).toBe(1);
  });

  it("serialises a product and a variant racing for the same SKU", async () => {
    const parent = await catalog.createProduct(adminA, { sku: sku(), name: "Parent", priceMinor: 100 });
    const shared = sku("XRACE");
    const results = await Promise.allSettled([
      catalog.createProduct(adminA, { sku: shared, name: "As product", priceMinor: 100 }),
      catalog.createVariant(adminA, parent.id, { sku: shared, name: "As variant" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect((rejected?.reason as AppError).status).toBe(409);
  });

  it("lets exactly one of two concurrent identical barcodes win", async () => {
    const product = await catalog.createProduct(adminA, { sku: sku(), name: "Scan race", priceMinor: 100 });
    const code = uniqueCode();
    const results = await Promise.allSettled([
      catalog.addBarcode(adminA, { code, productId: product.id }),
      catalog.addBarcode(adminA, { code, productId: product.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(detailsOf(rejected?.reason as AppError).reason).toBe("BARCODE_TAKEN");
  });
});
