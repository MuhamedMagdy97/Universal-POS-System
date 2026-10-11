import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import { createMember, createTenant, expectAppError, shortUpper, testDb, uniqueCode } from "./helpers";

/**
 * Tenant isolation and permissions at the service layer (C-8, C-11, C-13–C-15).
 * Route-level 401/403/404 envelopes are covered by catalog-isolation.test.ts (T3.6).
 */
let db: Db;
let tenantA: Awaited<ReturnType<typeof createTenant>>;
let tenantB: Awaited<ReturnType<typeof createTenant>>;
let adminA: TenantContext;
let ownerB: TenantContext;
let managerA: TenantContext;
let cashierA: TenantContext;
let reportingA: TenantContext;
let productB: catalog.ProductDetail;
let variantB: catalog.VariantDetail;
let categoryB: catalog.CategoryDetail;
let barcodeB: catalog.BarcodeDetail;

const sku = () => `ISO-${shortUpper()}`;
const stamp = () => new Date().toISOString();

beforeAll(async () => {
  db = testDb();
  tenantA = await createTenant(db, "Isolation A");
  tenantB = await createTenant(db, "Isolation B");
  adminA = await createMember(db, tenantA.org.id, "ADMIN");
  managerA = await createMember(db, tenantA.org.id, "MANAGER");
  cashierA = await createMember(db, tenantA.org.id, "CASHIER");
  reportingA = await createMember(db, tenantA.org.id, "REPORTING");
  ownerB = await createMember(db, tenantB.org.id, "OWNER");

  categoryB = await catalog.createCategory(ownerB, { name: `B cat ${shortUpper()}` });
  productB = await catalog.createProduct(ownerB, {
    sku: sku(),
    name: "Secret B",
    priceMinor: 100,
    costMinor: 50,
    categoryId: categoryB.id,
  });
  variantB = await catalog.createVariant(ownerB, productB.id, { sku: sku(), name: "B variant", costMinor: 40 });
  barcodeB = await catalog.addBarcode(ownerB, { code: uniqueCode(), productId: productB.id, variantId: variantB.id });
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

describe("other-tenant ids answer 404 (C-8, C-11)", () => {
  it("for reads", async () => {
    await expectAppError(catalog.getProduct(adminA, productB.id), 404);
  });

  it("for product writes", async () => {
    await expectAppError(
      catalog.updateProduct(adminA, productB.id, { name: "Hijack", expectedUpdatedAt: stamp() }),
      404,
    );
    await expectAppError(catalog.archiveProduct(adminA, productB.id, { expectedUpdatedAt: stamp() }), 404);
    await expectAppError(catalog.restoreProduct(adminA, productB.id, { expectedUpdatedAt: stamp() }), 404);
  });

  it("for variants", async () => {
    await expectAppError(catalog.createVariant(adminA, productB.id, { sku: sku(), name: "Inject" }), 404);
    await expectAppError(
      catalog.updateVariant(adminA, productB.id, variantB.id, { name: "X", expectedUpdatedAt: stamp() }),
      404,
    );
    await expectAppError(catalog.archiveVariant(adminA, productB.id, variantB.id, { expectedUpdatedAt: stamp() }), 404);
  });

  it("for categories, including a forged foreign categoryId / parentId", async () => {
    await expectAppError(catalog.updateCategory(adminA, categoryB.id, { name: "X", expectedUpdatedAt: stamp() }), 404);
    await expectAppError(catalog.archiveCategory(adminA, categoryB.id, { expectedUpdatedAt: stamp() }), 404);
    await expectAppError(catalog.createCategory(adminA, { name: "Child", parentId: categoryB.id }), 404);

    const forgedSku = sku();
    await expectAppError(
      catalog.createProduct(adminA, { sku: forgedSku, name: "Forged", priceMinor: 1, categoryId: categoryB.id }),
      404,
    );
    expect(await db.product.count({ where: { sku: forgedSku } })).toBe(0);

    const own = await catalog.createProduct(adminA, { sku: sku(), name: "Own", priceMinor: 1 });
    await expectAppError(
      catalog.updateProduct(adminA, own.id, { categoryId: categoryB.id, expectedUpdatedAt: own.updatedAt }),
      404,
    );
  });

  it("for barcodes", async () => {
    await expectAppError(catalog.addBarcode(adminA, { code: uniqueCode(), productId: productB.id }), 404);
    const own = await catalog.createProduct(adminA, { sku: sku(), name: "Own", priceMinor: 1 });
    await expectAppError(
      catalog.addBarcode(adminA, { code: uniqueCode(), productId: own.id, variantId: variantB.id }),
      404,
    );
    await expectAppError(catalog.removeBarcode(adminA, barcodeB.id), 404);
    expect(await db.barcode.findUnique({ where: { id: barcodeB.id } })).not.toBeNull();
  });

  it("never lists another org's categories", async () => {
    const tree = await catalog.listCategories(adminA, { status: "all" });
    expect(tree.some((c) => c.id === categoryB.id)).toBe(false);
  });
});

describe("permissions (C-13–C-15)", () => {
  it("lets a Cashier and a Manager read but hides cost", async () => {
    const product = await catalog.createProduct(adminA, { sku: sku(), name: "Costly", priceMinor: 100, costMinor: 70 });
    await catalog.createVariant(adminA, product.id, { sku: sku(), name: "V", costMinor: 60 });
    for (const reader of [cashierA, managerA]) {
      const detail = await catalog.getProduct(reader, product.id);
      expect(detail).not.toHaveProperty("costMinor");
      expect(detail.variants[0]).not.toHaveProperty("costMinor");
      const page = await catalog.listProducts(reader, { q: product.sku });
      expect(page.items[0]).not.toHaveProperty("costMinor");
    }
    const asAdmin = await catalog.getProduct(adminA, product.id);
    expect(asAdmin.costMinor).toBe(70);
    expect(asAdmin.variants[0]?.costMinor).toBe(60);
  });

  it("denies Reporting any catalog read (403)", async () => {
    await expectAppError(catalog.listProducts(reportingA), 403);
    await expectAppError(catalog.getProduct(reportingA, productB.id), 403);
    await expectAppError(catalog.listCategories(reportingA), 403);
  });

  it("denies writes to Cashier and Manager (403), changes nothing and audits the attempt", async () => {
    const product = await catalog.createProduct(adminA, { sku: sku(), name: "Locked", priceMinor: 100 });
    for (const actor of [cashierA, managerA]) {
      const deniedSku = sku();
      await expectAppError(catalog.createProduct(actor, { sku: deniedSku, name: "No", priceMinor: 1 }), 403);
      expect(await db.product.count({ where: { sku: deniedSku } })).toBe(0);
      await expectAppError(
        catalog.updateProduct(actor, product.id, { priceMinor: 1, expectedUpdatedAt: product.updatedAt }),
        403,
      );
      await expectAppError(catalog.archiveProduct(actor, product.id, { expectedUpdatedAt: product.updatedAt }), 403);
      await expectAppError(catalog.createCategory(actor, { name: `No ${shortUpper()}` }), 403);
      await expectAppError(catalog.addBarcode(actor, { code: uniqueCode(), productId: product.id }), 403);
      await expectAppError(catalog.removeBarcode(actor, randomUUID()), 403);
      await expectAppError(catalog.createVariant(actor, product.id, { sku: sku(), name: "No" }), 403);

      const denied = await db.auditEvent.findMany({
        where: { orgId: tenantA.org.id, actorUserId: actor.userId, action: "catalog.permission.denied" },
      });
      expect(denied.length).toBe(7);
      expect(denied.map((e) => (e.metadata as { permission?: string }).permission)).toContain("products.update");
    }
    expect((await catalog.getProduct(adminA, product.id)).priceMinor).toBe(100);
  });

  it("checks permission before validating input or looking up ids", async () => {
    await expectAppError(catalog.getProduct(reportingA, "not-a-uuid"), 403);
    await expectAppError(catalog.createProduct(cashierA, {} as unknown as catalog.CreateProductInput), 403);
  });
});
