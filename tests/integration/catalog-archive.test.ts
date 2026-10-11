import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import { createMember, createTenant, detailsOf, expectAppError, shortUpper, testDb, uniqueCode } from "./helpers";

/** Archive instead of delete (C-22, C-24, C-26 per R5, C-27) and the category archive guard. */
let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let admin: TenantContext;

const sku = () => `AR-${shortUpper()}`;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Archive");
  admin = await createMember(db, tenant.org.id, "ADMIN");
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

describe("products (C-22, C-24)", () => {
  it("hides an archived product from the default list and search, lists it under archived, and restores it", async () => {
    const code = uniqueCode();
    const product = await catalog.createProduct(admin, {
      sku: sku(),
      name: "Archivable",
      priceMinor: 100,
      barcodes: [code],
    });

    const archived = await catalog.archiveProduct(admin, product.id, { expectedUpdatedAt: product.updatedAt });
    expect(archived.isActive).toBe(false);

    expect((await catalog.listProducts(admin, { q: product.sku })).items).toEqual([]);
    expect((await catalog.listProducts(admin, { q: code })).items).toEqual([]);
    const archivedList = await catalog.listProducts(admin, { q: product.sku, status: "archived" });
    expect(archivedList.items.map((p) => p.id)).toEqual([product.id]);
    const all = await catalog.listProducts(admin, { q: product.sku, status: "all" });
    expect(all.items.map((p) => p.id)).toEqual([product.id]);
    // Archived products stay readable by id (history, edit screen).
    expect((await catalog.getProduct(admin, product.id)).isActive).toBe(false);

    const restored = await catalog.restoreProduct(admin, product.id, { expectedUpdatedAt: archived.updatedAt });
    expect(restored.isActive).toBe(true);
    expect((await catalog.listProducts(admin, { q: code })).items.map((p) => p.id)).toEqual([product.id]);

    const actions = (
      await db.auditEvent.findMany({ where: { entityId: product.id }, orderBy: { createdAt: "asc" } })
    ).map((e) => e.action);
    expect(actions).toEqual(["catalog.product.created", "catalog.product.archived", "catalog.product.restored"]);
  });

  it("answers 409 ALREADY_ARCHIVED / NOT_ARCHIVED without side effects", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Twice", priceMinor: 100 });
    await expectAppError(
      catalog.restoreProduct(admin, product.id, { expectedUpdatedAt: product.updatedAt }),
      409,
      "NOT_ARCHIVED",
    );
    const archived = await catalog.archiveProduct(admin, product.id, { expectedUpdatedAt: product.updatedAt });
    // A retry with the original timestamp is told the product is already archived.
    await expectAppError(
      catalog.archiveProduct(admin, product.id, { expectedUpdatedAt: product.updatedAt }),
      409,
      "ALREADY_ARCHIVED",
    );
    expect(await db.auditEvent.count({ where: { entityId: product.id, action: "catalog.product.archived" } })).toBe(1);
    expect(archived.isActive).toBe(false);
  });

  it("rejects a stale archive (409 STALE_WRITE)", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Stale", priceMinor: 100 });
    await catalog.updateProduct(admin, product.id, { name: "Stale 2", expectedUpdatedAt: product.updatedAt });
    await expectAppError(
      catalog.archiveProduct(admin, product.id, { expectedUpdatedAt: product.updatedAt }),
      409,
      "STALE_WRITE",
    );
  });

  it("does not archive the variants of an archived product", async () => {
    const product = await catalog.createProduct(admin, { sku: sku(), name: "With variant", priceMinor: 100 });
    const variant = await catalog.createVariant(admin, product.id, { sku: sku(), name: "V" });
    const current = await catalog.getProduct(admin, product.id);
    await catalog.archiveProduct(admin, product.id, { expectedUpdatedAt: current.updatedAt });
    const detail = await catalog.getProduct(admin, product.id);
    expect(detail.variants.find((v) => v.id === variant.id)?.isActive).toBe(true);
  });
});

describe("categories (C-26 per R5)", () => {
  it("allows archiving a category that has active products; they keep it and stay listed", async () => {
    const category = await catalog.createCategory(admin, { name: `Has products ${shortUpper()}` });
    const product = await catalog.createProduct(admin, {
      sku: sku(),
      name: "In category",
      priceMinor: 100,
      categoryId: category.id,
    });
    const archived = await catalog.archiveCategory(admin, category.id, { expectedUpdatedAt: category.updatedAt });
    expect(archived.isActive).toBe(false);

    const detail = await catalog.getProduct(admin, product.id);
    expect(detail).toMatchObject({ categoryId: category.id, isActive: true });
    // Hidden from the default (active) category list, visible under archived.
    expect((await catalog.listCategories(admin)).some((c) => c.id === category.id)).toBe(false);
    expect((await catalog.listCategories(admin, { status: "archived" })).some((c) => c.id === category.id)).toBe(true);
    // Editing other fields of the product does not trip CATEGORY_INACTIVE (the category is not newly assigned).
    await expect(
      catalog.updateProduct(admin, product.id, { name: "Renamed", expectedUpdatedAt: detail.updatedAt }),
    ).resolves.toMatchObject({ categoryId: category.id });

    const restored = await catalog.restoreCategory(admin, category.id, { expectedUpdatedAt: archived.updatedAt });
    expect(restored.isActive).toBe(true);
    const actions = (
      await db.auditEvent.findMany({ where: { entityId: category.id }, orderBy: { createdAt: "asc" } })
    ).map((e) => e.action);
    expect(actions).toEqual(["catalog.category.created", "catalog.category.archived", "catalog.category.restored"]);
  });

  it("blocks archiving while active child categories exist (409 with count)", async () => {
    const parent = await catalog.createCategory(admin, { name: `Parent ${shortUpper()}` });
    const child = await catalog.createCategory(admin, { name: "Child", parentId: parent.id });
    await catalog.createCategory(admin, { name: "Child 2", parentId: parent.id });
    const err = await expectAppError(
      catalog.archiveCategory(admin, parent.id, { expectedUpdatedAt: parent.updatedAt }),
      409,
      "CATEGORY_HAS_ACTIVE_CHILDREN",
    );
    expect(detailsOf(err).count).toBe(2);

    const tree = await catalog.listCategories(admin, { status: "all" });
    const kids = tree.find((n) => n.id === parent.id)?.children ?? [];
    for (const kid of kids) await catalog.archiveCategory(admin, kid.id, { expectedUpdatedAt: kid.updatedAt });
    const archivedParent = await catalog.archiveCategory(admin, parent.id, { expectedUpdatedAt: parent.updatedAt });
    expect(archivedParent.isActive).toBe(false);

    // A child cannot be restored under an archived parent.
    const archivedChild = (await catalog.listCategories(admin, { status: "archived" }))
      .find((n) => n.id === parent.id)
      ?.children.find((n) => n.id === child.id);
    expect(archivedChild).toBeDefined();
    await expectAppError(
      catalog.restoreCategory(admin, child.id, { expectedUpdatedAt: archivedChild?.updatedAt ?? "" }),
      422,
      "CATEGORY_INACTIVE",
    );
  });
});

describe("no delete (C-27)", () => {
  it("exposes no delete for products, variants or categories", () => {
    const exported = Object.keys(catalog);
    expect(exported.filter((name) => /^(delete|remove)(Product|Variant|Category)/.test(name))).toEqual([]);
    expect(exported).toContain("removeBarcode");
  });

  it("the database refuses to delete a product that is still referenced", async () => {
    const product = await catalog.createProduct(admin, {
      sku: sku(),
      name: "Referenced",
      priceMinor: 100,
      barcodes: [uniqueCode()],
    });
    await expect(db.product.delete({ where: { id: product.id } })).rejects.toThrow();
  });
});
