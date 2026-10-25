import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { parseMajor } from "@/lib/money";
import * as catalog from "@/modules/catalog";
import { createMember, createTenant, detailsOf, expectAppError, shortUpper, testDb, uniqueCode } from "./helpers";

/**
 * Catalog services against real Postgres: create/edit, variants, barcodes,
 * categories and their audit rows (C-1…C-4, C-6; catalog-api-and-rules.md §5–§6).
 */
let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let admin: TenantContext;

const sku = (prefix = "P") => `${prefix}-${shortUpper()}`;
const meta = () => ({ requestId: `req-${randomUUID()}` });

async function auditFor(entityId: string) {
  return db.auditEvent.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } });
}

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Catalog Products");
  admin = await createMember(db, tenant.org.id, "ADMIN");
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

describe("create product (C-1)", () => {
  it("stores the price in minor units, lists the product and records an audit event", async () => {
    const m = meta();
    const product = await catalog.createProduct(
      admin,
      {
        sku: sku().toLowerCase(),
        name: "  Tea  ",
        nameAr: "شاي",
        priceMinor: parseMajor("12.50", "EGP"),
        costMinor: 800,
      },
      m,
    );
    expect(product).toMatchObject({
      name: "Tea",
      nameAr: "شاي",
      priceMinor: 1250,
      costMinor: 800,
      unitType: "EACH",
      vatCategory: "STANDARD",
      vatApplicable: true,
      hasVariants: false,
      isActive: true,
      warnings: [],
    });
    expect(product.sku).toBe(product.sku.toUpperCase());

    const page = await catalog.listProducts(admin, { q: product.sku });
    expect(page.items.map((p) => p.id)).toEqual([product.id]);

    const events = await auditFor(product.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      orgId: tenant.org.id,
      actorUserId: admin.userId,
      action: "catalog.product.created",
      entityType: "Product",
      requestId: m.requestId,
    });
    expect(events[0]?.metadata).toMatchObject({ sku: product.sku, priceMinor: 1250, costMinor: 800 });
  });

  it("derives vatApplicable from vatCategory", async () => {
    const product = await catalog.createProduct(admin, {
      sku: sku(),
      name: "Bread",
      priceMinor: 500,
      vatCategory: "ZERO_RATED",
    });
    expect(product).toMatchObject({ vatCategory: "ZERO_RATED", vatApplicable: false });
  });

  it("creates a KG product but refuses variants on it (weighed-selling-spec W4)", async () => {
    const rice = await catalog.createProduct(admin, { sku: sku(), name: "Rice", priceMinor: 4500, unitType: "KG" });
    expect(rice).toMatchObject({ unitType: "KG", priceMinor: 4500 });
    await expectAppError(
      catalog.createVariant(admin, rice.id, { sku: sku(), name: "1 kg bag" }),
      422,
      "UNIT_NOT_SUPPORTED",
    );
  });

  it("rejects unknown keys such as orgId", async () => {
    await expect(
      catalog.createProduct(admin, {
        sku: sku(),
        name: "Forged",
        priceMinor: 100,
        orgId: randomUUID(),
      } as unknown as catalog.CreateProductInput),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("warns when the price is below cost", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Loss", priceMinor: 100, costMinor: 200 });
    expect(product.warnings).toEqual(["PRICE_BELOW_COST"]);
  });

  it("creates initial barcodes in the same transaction and audits them (C-4)", async () => {
    const codes = [uniqueCode(), uniqueCode()];
    const product = await catalog.createProduct(admin, {
      sku: sku(),
      name: "Scanned",
      priceMinor: 100,
      barcodes: codes,
    });
    expect(product.barcodes.map((b) => b.code)).toEqual(codes);
    expect(product.barcodes.every((b) => b.variantId === null)).toBe(true);
    const added = await db.auditEvent.findMany({
      where: {
        orgId: tenant.org.id,
        action: "catalog.barcode.added",
        entityId: { in: product.barcodes.map((b) => b.id) },
      },
    });
    expect(added).toHaveLength(2);
  });
});

describe("update product (C-2)", () => {
  it("changes the price, writes a separate price_changed event and leaves sale snapshots untouched", async () => {
    const product = await catalog.createProduct(admin, {
      sku: sku(),
      name: "Coffee",
      priceMinor: 1000,
      costMinor: 400,
    });

    // A completed sale line snapshotting the old price (written directly: sales services land in T6).
    const shift = await db.registerShift.create({
      data: {
        orgId: tenant.org.id,
        branchId: tenant.branchA.id,
        registerId: tenant.register.id,
        openedById: admin.userId,
        openingFloatMinor: 0,
      },
    });
    const sale = await db.sale.create({
      data: {
        orgId: tenant.org.id,
        branchId: tenant.branchA.id,
        registerId: tenant.register.id,
        shiftId: shift.id,
        cashierId: admin.userId,
        number: `S-${randomUUID().slice(0, 8)}`,
        idempotencyKey: randomUUID(),
        currency: "EGP",
        subtotalMinor: 1000,
        vatMinor: 140,
        totalMinor: 1140,
      },
    });
    const line = await db.saleItem.create({
      data: {
        orgId: tenant.org.id,
        saleId: sale.id,
        productId: product.id,
        skuSnapshot: product.sku,
        nameSnapshot: product.name,
        unitType: "EACH",
        qty: 1,
        unitPriceMinor: 1000,
        vatRateBp: 1400,
        vatMinor: 140,
        lineTotalMinor: 1140,
      },
    });

    const updated = await catalog.updateProduct(admin, product.id, {
      priceMinor: 1500,
      name: "Coffee Large",
      expectedUpdatedAt: product.updatedAt,
    });
    expect(updated).toMatchObject({ priceMinor: 1500, name: "Coffee Large" });
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(product.updatedAt).getTime());

    const listed = await catalog.listProducts(admin, { q: product.sku });
    expect(listed.items[0]?.priceMinor).toBe(1500);

    const events = await auditFor(product.id);
    expect(events.map((e) => e.action)).toEqual([
      "catalog.product.created",
      "catalog.product.updated",
      "catalog.product.price_changed",
    ]);
    expect(events[1]?.metadata).toEqual({ changes: { name: ["Coffee", "Coffee Large"] } });
    expect(events[2]?.metadata).toEqual({ priceMinor: [1000, 1500] });

    const after = await db.saleItem.findUniqueOrThrow({ where: { id: line.id } });
    expect(after).toMatchObject({ unitPriceMinor: 1000, nameSnapshot: "Coffee", skuSnapshot: product.sku });
  });

  it("rejects a stale expectedUpdatedAt with 409 STALE_WRITE and writes nothing", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Juice", priceMinor: 300 });
    await catalog.updateProduct(admin, product.id, { priceMinor: 350, expectedUpdatedAt: product.updatedAt });
    await expectAppError(
      catalog.updateProduct(admin, product.id, { priceMinor: 400, expectedUpdatedAt: product.updatedAt }),
      409,
      "STALE_WRITE",
    );
    const fresh = await catalog.getProduct(admin, product.id);
    expect(fresh.priceMinor).toBe(350);
    expect((await auditFor(product.id)).filter((e) => e.action === "catalog.product.price_changed")).toHaveLength(1);
  });

  it("does not accept unitType on update (immutable)", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Unit", priceMinor: 300 });
    await expect(
      catalog.updateProduct(admin, product.id, {
        unitType: "KG",
        expectedUpdatedAt: product.updatedAt,
      } as unknown as catalog.UpdateProductInput),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("switches vatApplicable with vatCategory and audits it as a non-price change", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Milk", priceMinor: 300 });
    const updated = await catalog.updateProduct(admin, product.id, {
      vatCategory: "EXEMPT",
      expectedUpdatedAt: product.updatedAt,
    });
    expect(updated).toMatchObject({ vatCategory: "EXEMPT", vatApplicable: false, warnings: [] });
    const events = await auditFor(product.id);
    expect(events.at(-1)).toMatchObject({ action: "catalog.product.updated" });
  });

  it("is a no-op (no audit, same updatedAt) when nothing changes", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Same", priceMinor: 300 });
    const result = await catalog.updateProduct(admin, product.id, {
      name: "Same",
      priceMinor: 300,
      expectedUpdatedAt: product.updatedAt,
    });
    expect(result.updatedAt).toBe(product.updatedAt);
    expect(await auditFor(product.id)).toHaveLength(1);
  });

  it("returns 404 for an unknown or malformed id", async () => {
    await expectAppError(catalog.getProduct(admin, randomUUID()), 404);
    await expectAppError(catalog.getProduct(admin, "not-a-uuid"), 404);
    await expectAppError(
      catalog.updateProduct(admin, randomUUID(), { name: "X", expectedUpdatedAt: new Date().toISOString() }),
      404,
    );
  });
});

describe("variants (C-3)", () => {
  it("creates variants, sets hasVariants in the same transaction and inherits a blank price", async () => {
    const product = await catalog.createProduct(admin, {
      sku: sku(),
      name: "Shirt",
      priceMinor: 9900,
      costMinor: 5000,
    });
    const code = uniqueCode();
    const red = await catalog.createVariant(admin, product.id, {
      sku: sku("V"),
      name: "Red / L",
      barcodes: [code],
    });
    expect(red).toMatchObject({
      productId: product.id,
      priceMinor: null,
      costMinor: null,
      isActive: true,
      warnings: [],
    });

    const blue = await catalog.createVariant(admin, product.id, { sku: sku("V"), name: "Blue / L", priceMinor: 4000 });
    expect(blue.warnings).toEqual(["PRICE_BELOW_COST"]);

    const detail = await catalog.getProduct(admin, product.id);
    expect(detail.hasVariants).toBe(true);
    expect(detail.variantCount).toBe(2);
    expect(detail.variants.map((v) => v.id).sort()).toEqual([red.id, blue.id].sort());
    expect(detail.barcodes).toEqual([expect.objectContaining({ code, variantId: red.id })]);

    const events = await auditFor(red.id);
    expect(events[0]).toMatchObject({ action: "catalog.variant.created", entityType: "ProductVariant" });
    expect(events[0]?.metadata).toMatchObject({ productId: product.id });
  });

  it("updates price and name with separate events; null re-inherits the product price", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Cap", priceMinor: 2000 });
    const variant = await catalog.createVariant(admin, product.id, { sku: sku("V"), name: "Black", priceMinor: 2500 });
    const updated = await catalog.updateVariant(admin, product.id, variant.id, {
      name: "Black / M",
      priceMinor: null,
      expectedUpdatedAt: variant.updatedAt,
    });
    expect(updated).toMatchObject({ name: "Black / M", priceMinor: null });
    const actions = (await auditFor(variant.id)).map((e) => e.action);
    expect(actions).toEqual(["catalog.variant.created", "catalog.variant.updated", "catalog.variant.price_changed"]);

    await expectAppError(
      catalog.updateVariant(admin, product.id, variant.id, { name: "Late", expectedUpdatedAt: variant.updatedAt }),
      409,
      "STALE_WRITE",
    );
  });

  it("answers 404 when the variant belongs to another product", async () => {
    const a = await catalog.createProduct(admin, { sku: sku(), name: "A", priceMinor: 100 });
    const b = await catalog.createProduct(admin, { sku: sku(), name: "B", priceMinor: 100 });
    const variant = await catalog.createVariant(admin, a.id, { sku: sku("V"), name: "Only A" });
    await expectAppError(
      catalog.updateVariant(admin, b.id, variant.id, { name: "X", expectedUpdatedAt: variant.updatedAt }),
      404,
    );
    await expectAppError(
      catalog.archiveVariant(admin, b.id, variant.id, { expectedUpdatedAt: variant.updatedAt }),
      404,
    );
  });

  it("keeps hasVariants on after the last variant is archived, and restores it", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Socks", priceMinor: 100 });
    const variant = await catalog.createVariant(admin, product.id, { sku: sku("V"), name: "One size" });
    const archived = await catalog.archiveVariant(admin, product.id, variant.id, {
      expectedUpdatedAt: variant.updatedAt,
    });
    expect(archived.isActive).toBe(false);
    const detail = await catalog.getProduct(admin, product.id);
    expect(detail).toMatchObject({ hasVariants: true, variantCount: 0 });
    await expectAppError(
      catalog.archiveVariant(admin, product.id, variant.id, { expectedUpdatedAt: archived.updatedAt }),
      409,
      "ALREADY_ARCHIVED",
    );
    const restored = await catalog.restoreVariant(admin, product.id, variant.id, {
      expectedUpdatedAt: archived.updatedAt,
    });
    expect(restored.isActive).toBe(true);
    const actions = (await auditFor(variant.id)).map((e) => e.action);
    expect(actions).toEqual(["catalog.variant.created", "catalog.variant.archived", "catalog.variant.restored"]);
  });
});

describe("barcodes (C-4)", () => {
  it("adds and removes a product barcode with audit events", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Soap", priceMinor: 100 });
    const code = uniqueCode();
    const barcode = await catalog.addBarcode(admin, { code, productId: product.id });
    // The item's first barcode is its primary.
    expect(barcode).toMatchObject({ code, productId: product.id, variantId: null, isPrimary: true });

    await catalog.removeBarcode(admin, barcode.id);
    expect(await db.barcode.findUnique({ where: { id: barcode.id } })).toBeNull();
    const actions = (await auditFor(barcode.id)).map((e) => e.action);
    expect(actions).toEqual(["catalog.barcode.added", "catalog.barcode.primary_changed", "catalog.barcode.removed"]);

    // The code is reusable after removal.
    await expect(catalog.addBarcode(admin, { code, productId: product.id })).resolves.toMatchObject({ code });
    await expectAppError(catalog.removeBarcode(admin, randomUUID()), 404);
  });

  it("requires a variant on a product with variants (422 VARIANT_REQUIRED)", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Shoe", priceMinor: 100 });
    await catalog.createVariant(admin, product.id, { sku: sku("V"), name: "42" });
    await expectAppError(
      catalog.addBarcode(admin, { code: uniqueCode(), productId: product.id }),
      422,
      "VARIANT_REQUIRED",
    );
  });

  it("rejects a variant of another product (422 VARIANT_PRODUCT_MISMATCH)", async () => {
    const a = await catalog.createProduct(admin, { sku: sku(), name: "A", priceMinor: 100 });
    const b = await catalog.createProduct(admin, { sku: sku(), name: "B", priceMinor: 100 });
    const variantOfA = await catalog.createVariant(admin, a.id, { sku: sku("V"), name: "A1" });
    await expectAppError(
      catalog.addBarcode(admin, { code: uniqueCode(), productId: b.id, variantId: variantOfA.id }),
      422,
      "VARIANT_PRODUCT_MISMATCH",
    );
  });

  it("moves the primary flag in one transaction", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Label", priceMinor: 100 });
    const first = await catalog.addBarcode(admin, { code: uniqueCode(), productId: product.id, isPrimary: true });
    const second = await catalog.addBarcode(admin, { code: uniqueCode(), productId: product.id, isPrimary: true });
    const rows = await db.barcode.findMany({ where: { productId: product.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.id, r.isPrimary])).toEqual([
      [first.id, false],
      [second.id, true],
    ]);
  });
});

describe("categories (C-6)", () => {
  it("creates a category, assigns products and filters by it", async () => {
    const category = await catalog.createCategory(admin, { name: `Drinks ${shortUpper()}`, nameAr: "مشروبات" });
    const inCat = await Promise.all(
      [1, 2].map((n) =>
        catalog.createProduct(admin, { sku: sku(), name: `Drink ${n}`, priceMinor: 100, categoryId: category.id }),
      ),
    );
    const outside = await catalog.createProduct(admin, { sku: sku(), name: "Other", priceMinor: 100 });
    const moved = await catalog.updateProduct(admin, outside.id, {
      categoryId: category.id,
      expectedUpdatedAt: outside.updatedAt,
    });
    expect(moved.categoryId).toBe(category.id);

    const page = await catalog.listProducts(admin, { categoryId: category.id, limit: 100 });
    expect(page.items.map((p) => p.id).sort()).toEqual([...inCat.map((p) => p.id), outside.id].sort());
    expect((await auditFor(category.id))[0]).toMatchObject({ action: "catalog.category.created" });
  });

  it("returns the whole tree with depth", async () => {
    const root = await catalog.createCategory(admin, { name: `Root ${shortUpper()}` });
    const child = await catalog.createCategory(admin, { name: "Child", parentId: root.id });
    await catalog.createCategory(admin, { name: "Grandchild", parentId: child.id });
    const tree = await catalog.listCategories(admin);
    const node = tree.find((n) => n.id === root.id);
    expect(node?.depth).toBe(1);
    expect(node?.children[0]).toMatchObject({ id: child.id, depth: 2 });
    expect(node?.children[0]?.children[0]).toMatchObject({ name: "Grandchild", depth: 3 });
  });

  it("enforces max depth 3, including when re-parenting a subtree (422 CATEGORY_TOO_DEEP)", async () => {
    const l1 = await catalog.createCategory(admin, { name: `L1 ${shortUpper()}` });
    const l2 = await catalog.createCategory(admin, { name: "L2", parentId: l1.id });
    const l3 = await catalog.createCategory(admin, { name: "L3", parentId: l2.id });
    await expectAppError(catalog.createCategory(admin, { name: "L4", parentId: l3.id }), 422, "CATEGORY_TOO_DEEP");

    const other = await catalog.createCategory(admin, { name: `Other ${shortUpper()}` });
    const otherChild = await catalog.createCategory(admin, { name: "Kid", parentId: other.id });
    // Moving `other` (height 2) under l2 (depth 2) would reach depth 4.
    await expectAppError(
      catalog.updateCategory(admin, other.id, { parentId: l2.id, expectedUpdatedAt: other.updatedAt }),
      422,
      "CATEGORY_TOO_DEEP",
    );
    // Under l1 it fits (depth 3).
    const moved = await catalog.updateCategory(admin, other.id, {
      parentId: l1.id,
      expectedUpdatedAt: other.updatedAt,
    });
    expect(moved.parentId).toBe(l1.id);
    expect(otherChild.parentId).toBe(other.id);
  });

  it("rejects cycles (422 CATEGORY_CYCLE)", async () => {
    const a = await catalog.createCategory(admin, { name: `A ${shortUpper()}` });
    const b = await catalog.createCategory(admin, { name: "B", parentId: a.id });
    await expectAppError(
      catalog.updateCategory(admin, a.id, { parentId: b.id, expectedUpdatedAt: a.updatedAt }),
      422,
      "CATEGORY_CYCLE",
    );
    await expectAppError(
      catalog.updateCategory(admin, a.id, { parentId: a.id, expectedUpdatedAt: a.updatedAt }),
      422,
      "CATEGORY_CYCLE",
    );
  });

  it("rejects sibling names case-insensitively (409 NAME_TAKEN with existingId) and audits renames", async () => {
    const name = `Snacks ${shortUpper()}`;
    const first = await catalog.createCategory(admin, { name });
    const err = await expectAppError(catalog.createCategory(admin, { name: name.toLowerCase() }), 409, "NAME_TAKEN");
    expect(detailsOf(err)).toMatchObject({ field: "name", existingId: first.id });

    const second = await catalog.createCategory(admin, { name: `${name} 2` });
    const renameErr = await expectAppError(
      catalog.updateCategory(admin, second.id, { name: name.toUpperCase(), expectedUpdatedAt: second.updatedAt }),
      409,
      "NAME_TAKEN",
    );
    expect(detailsOf(renameErr).existingId).toBe(first.id);

    const renamed = await catalog.updateCategory(admin, second.id, {
      name: `${name} B`,
      expectedUpdatedAt: second.updatedAt,
    });
    const events = await auditFor(second.id);
    expect(events.at(-1)).toMatchObject({ action: "catalog.category.updated" });
    expect(events.at(-1)?.metadata).toMatchObject({ changes: { name: [`${name} 2`, renamed.name] } });
  });

  it("rejects assigning an archived category (422 CATEGORY_INACTIVE)", async () => {
    const category = await catalog.createCategory(admin, { name: `Old ${shortUpper()}` });
    await catalog.archiveCategory(admin, category.id, { expectedUpdatedAt: category.updatedAt });
    await expectAppError(
      catalog.createProduct(admin, { sku: sku(), name: "X", priceMinor: 1, categoryId: category.id }),
      422,
      "CATEGORY_INACTIVE",
    );
    await expectAppError(
      catalog.createCategory(admin, { name: "Kid", parentId: category.id }),
      422,
      "CATEGORY_INACTIVE",
    );
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Y", priceMinor: 1 });
    await expectAppError(
      catalog.updateProduct(admin, product.id, { categoryId: category.id, expectedUpdatedAt: product.updatedAt }),
      422,
      "CATEGORY_INACTIVE",
    );
  });
});

describe("audit atomicity", () => {
  it("leaves no product, barcode or audit row when a later statement of the write fails", async () => {
    const takenCode = uniqueCode();
    await catalog.createProduct(admin, { sku: sku(), name: "Owner", priceMinor: 1, barcodes: [takenCode] });
    const freshCode = uniqueCode();
    const loserSku = sku();
    // The product insert and the first barcode succeed inside the tx; the second barcode clashes.
    await expectAppError(
      catalog.createProduct(admin, { sku: loserSku, name: "Loser", priceMinor: 1, barcodes: [freshCode, takenCode] }),
      409,
      "BARCODE_TAKEN",
    );
    expect(await db.product.count({ where: { orgId: tenant.org.id, sku: loserSku } })).toBe(0);
    expect(await db.barcode.count({ where: { orgId: tenant.org.id, code: freshCode } })).toBe(0);
    const audits = await db.auditEvent.count({
      where: { orgId: tenant.org.id, metadata: { path: ["sku"], equals: loserSku } },
    });
    const barcodeAudits = await db.auditEvent.count({
      where: { orgId: tenant.org.id, metadata: { path: ["code"], equals: freshCode } },
    });
    expect(audits + barcodeAudits).toBe(0);
  });
});
