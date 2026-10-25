import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import {
  createCategory,
  createMember,
  createProduct,
  createTenant,
  detailsOf,
  expectAppError,
  shortUpper,
  testDb,
  uniqueCode,
} from "./helpers";

/** Product CSV import (docs/planning/catalog-import/catalog-import-spec.md). */
let db: Db;
let orgId: string;
let admin: TenantContext;
let cashier: TenantContext;
let otherAdmin: TenantContext;
let otherOrgId: string;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Import");
  orgId = tenant.org.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
  const other = await createTenant(db, "Import Other");
  otherOrgId = other.org.id;
  otherAdmin = await createMember(db, otherOrgId, "ADMIN");
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

const csv = (...lines: string[]) => `﻿${lines.join("\r\n")}\r\n`;

describe("previewProductImport", () => {
  it("reports per-row errors and writes nothing", async () => {
    const taken = await createProduct(db, orgId);
    const category = await createCategory(db, orgId, `Drinks ${shortUpper()}`);
    const sku = `IM-${shortUpper()}`;
    const preview = await catalog.previewProductImport(
      admin,
      csv(
        "name,sku,price,category,vatCategory",
        `Cola,${sku.toLowerCase()},12.50,${category.name.toUpperCase()},zero_rated`,
        `,BAD SKU,abc,Nope,`,
        `Again,${sku},1,,`,
        `Taken,${taken.sku},1,,WHATEVER`,
      ),
    );

    expect(preview.validCount).toBe(1);
    expect(preview.errorCount).toBe(3);
    const [ok, bad, dup, clash] = preview.rows;
    expect(ok).toEqual({ line: 2, name: "Cola", sku, errors: [] });
    expect(bad?.errors).toEqual(
      expect.arrayContaining([
        { column: "price", code: "invalidAmount" },
        { column: "category", code: "categoryNotFound" },
        { column: "name", code: "required" },
        { column: "sku", code: "skuInvalid" },
      ]),
    );
    expect(dup?.errors).toEqual([{ column: "sku", code: "duplicateInFile" }]);
    expect(clash?.errors).toEqual(
      expect.arrayContaining([
        { column: "vatCategory", code: "invalid" },
        { column: "sku", code: "skuTaken" },
      ]),
    );
    expect(await db.product.count({ where: { orgId, sku } })).toBe(0);
  });

  it("refuses a bad header, an empty file and more than 1000 rows", async () => {
    await expectAppError(catalog.previewProductImport(admin, csv("name,price")), 422, "CSV_MISSING_COLUMN");
    await expectAppError(catalog.previewProductImport(admin, csv("name,sku,price,colour")), 422, "CSV_UNKNOWN_COLUMN");
    await expectAppError(catalog.previewProductImport(admin, csv("name,sku,price")), 422, "CSV_EMPTY");
    await expectAppError(catalog.previewProductImport(admin, 'name,sku,price\n"open'), 422, "CSV_MALFORMED");
    const rows = Array.from({ length: catalog.MAX_IMPORT_ROWS + 1 }, (_, i) => `P${i},S-${i},1`);
    const err = await expectAppError(
      catalog.previewProductImport(admin, csv("name,sku,price", ...rows)),
      422,
      "CSV_TOO_MANY_ROWS",
    );
    expect(detailsOf(err).max).toBe(1000);
  });

  it("does not see another tenant's SKUs, barcodes or categories", async () => {
    const theirs = await createProduct(db, otherOrgId);
    const theirCategory = await createCategory(db, otherOrgId, `Theirs ${shortUpper()}`);
    const preview = await catalog.previewProductImport(
      admin,
      csv("name,sku,price,category", `Mine,${theirs.sku},1,${theirCategory.name}`),
    );
    expect(preview.rows[0]?.errors).toEqual([{ column: "category", code: "categoryNotFound" }]);
  });
});

describe("importProducts", () => {
  it("creates every row in one transaction with audit rows", async () => {
    const category = await createCategory(db, orgId, `Snacks ${shortUpper()}`);
    const [a, b] = [`IM-${shortUpper()}`, `IM-${shortUpper()}`];
    const code = uniqueCode();
    const result = await catalog.importProducts(
      admin,
      csv(
        "Name,SKU,Barcode,Price,Category,nameAr",
        `"Chips, salted",${a},${code},5.25,${category.name},شيبس`,
        `Nuts,${b},,7,,`,
      ),
      { requestId: "req-import" },
    );
    expect(result).toEqual({ created: 2 });

    const chips = await db.product.findFirstOrThrow({ where: { orgId, sku: a }, include: { barcodes: true } });
    expect(chips).toMatchObject({
      name: "Chips, salted",
      nameAr: "شيبس",
      priceMinor: 525,
      categoryId: category.id,
      vatCategory: "STANDARD",
      vatApplicable: true,
    });
    expect(chips.barcodes.map((x) => x.code)).toEqual([code]);
    expect(await db.product.count({ where: { orgId, sku: b, categoryId: null, priceMinor: 700 } })).toBe(1);

    const events = await db.auditEvent.findMany({ where: { orgId, requestId: "req-import" } });
    expect(events.filter((e) => e.action === "catalog.product.created")).toHaveLength(2);
    expect(events.filter((e) => e.action === "catalog.barcode.added")).toHaveLength(1);
    expect(events.find((e) => e.action === "catalog.product.imported")?.metadata).toEqual({ created: 2 });
    // Another tenant's catalog is untouched and cannot see the new SKUs.
    expect(await db.product.count({ where: { orgId: otherOrgId, sku: { in: [a, b] } } })).toBe(0);
    const theirs = await catalog.previewProductImport(otherAdmin, csv("name,sku,price", `X,${a},1`));
    expect(theirs.errorCount).toBe(0);
  });

  it("imports weighed products priced per kg (weighed-selling-spec W4)", async () => {
    const [kg, each] = [`IM-${shortUpper()}`, `IM-${shortUpper()}`];
    const preview = await catalog.previewProductImport(
      admin,
      csv("name,sku,price,unit", `Rice,${kg},45,KG`, `Pen,X-${each},3,litre`),
    );
    expect(preview.rows[1]?.errors).toEqual([{ column: "unit", code: "invalid" }]);
    await catalog.importProducts(admin, csv("name,sku,price,unit", `Rice,${kg},45,kg`, `Pen,${each},3,each`));
    expect(await db.product.findFirstOrThrow({ where: { orgId, sku: kg } })).toMatchObject({
      unitType: "KG",
      priceMinor: 4500,
    });
    expect((await db.product.findFirstOrThrow({ where: { orgId, sku: each } })).unitType).toBe("EACH");
  });

  it("refuses the whole file when any row has an error", async () => {
    const good = `IM-${shortUpper()}`;
    await expectAppError(
      catalog.importProducts(admin, csv("name,sku,price", `Good,${good},1`, `Bad,${good}-2,-1`)),
      422,
      "CSV_HAS_ERRORS",
    );
    expect(await db.product.count({ where: { orgId, sku: good } })).toBe(0);
  });

  it("requires products.create and audits the denial", async () => {
    const file = csv("name,sku,price", `Nope,IM-${shortUpper()},1`);
    await expectAppError(catalog.previewProductImport(cashier, file), 403);
    await expectAppError(catalog.importProducts(cashier, file), 403);
    const denied = await db.auditEvent.findFirst({
      where: { orgId, actorUserId: cashier.userId, action: "catalog.permission.denied" },
    });
    expect(denied?.metadata).toMatchObject({ permission: "products.create", operation: "import" });
  });

  it("refuses a shop whose catalog is synced from the inventory system", async () => {
    const shop = await createTenant(db, "Import Linked");
    const owner = await createMember(db, shop.org.id, "OWNER");
    await db.organization.update({ where: { id: shop.org.id }, data: { inventorySource: "EXTERNAL" } });
    const file = csv("name,sku,price", `Linked,IM-${shortUpper()},1`);
    await expectAppError(catalog.previewProductImport(owner, file), 409, "MANAGED_BY_INVENTORY");
    await expectAppError(catalog.importProducts(owner, file), 409, "MANAGED_BY_INVENTORY");
    expect(await db.product.count({ where: { orgId: shop.org.id } })).toBe(0);
  });

  it("imports 1000 rows within the transaction timeout", async () => {
    const shop = await createTenant(db, "Import Bulk");
    const owner = await createMember(db, shop.org.id, "OWNER");
    const rows = Array.from(
      { length: catalog.MAX_IMPORT_ROWS },
      (_, i) => `Item ${i},BULK-${i},1.5,${uniqueCode()}${i}`,
    );
    const result = await catalog.importProducts(owner, csv("name,sku,price,barcode", ...rows));
    expect(result.created).toBe(1000);
    expect(await db.product.count({ where: { orgId: shop.org.id } })).toBe(1000);
  }, 120_000);
});
