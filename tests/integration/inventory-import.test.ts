import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import {
  createMember,
  createProduct,
  createTenant,
  createVariant,
  expectAppError,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/** Stock CSV import (docs/planning/stock-import/stock-import-spec.md). */
let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Stock Import");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
  await getDb().$disconnect();
});

const csv = (...lines: string[]) => `﻿${lines.join("\r\n")}\r\n`;
const onHand = async (productId: string, variantId: string | null = null) =>
  (await db.stockBalance.findFirst({ where: { orgId, branchId, productId, variantId } }))?.qty ?? 0;

describe("opening mode", () => {
  it("previews per-row errors without writing, then applies a clean file once", async () => {
    const a = await createProduct(db, orgId);
    const b = await createProduct(db, orgId);
    const code = uniqueCode();
    await db.barcode.create({ data: { orgId, productId: b.id, code } });
    const opened = await createProduct(db, orgId);
    await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: { productId: opened.id }, qty: 1 }] });
    const parent = await createProduct(db, orgId);
    const variant = await createVariant(db, orgId, parent.id);
    const archived = await createProduct(db, orgId);
    await db.product.update({ where: { id: archived.id }, data: { isActive: false } });

    const preview = await inventory.previewStockImport(admin, {
      branchId,
      mode: "opening",
      csv: csv(
        "SKU,barcode,qty",
        `${a.sku.toLowerCase()},,5`,
        `,${code},٣`,
        `${opened.sku},,2`,
        `${parent.sku},,2`,
        `${archived.sku},,2`,
        `NOPE-${uniqueCode()},,2`,
        `${a.sku},,1`,
        `${variant.sku},,0`,
        `${b.sku},${code}x,1`,
      ),
    });
    expect(preview.validCount).toBe(2);
    const errors = preview.rows.map((row) => row.errors.map((e) => e.code));
    expect(errors).toEqual([
      [],
      [],
      ["openingTaken"],
      ["variantRequired"],
      ["archived"],
      ["itemNotFound"],
      ["duplicateInFile"],
      ["qtyInvalid"],
      ["itemNotFound"],
    ]);
    expect(preview.rows[1]).toMatchObject({ line: 3, code, qty: 3, after: 3, name: b.name });
    expect(await onHand(a.id)).toBe(0);

    const importId = randomUUID();
    const file = csv("sku,qty", `${a.sku},5`, `${b.sku},3`, `${variant.sku},4`);
    await expect(inventory.importStock(admin, { branchId, mode: "opening", csv: file, importId })).resolves.toEqual({
      applied: 3,
      replayed: false,
    });
    expect([await onHand(a.id), await onHand(b.id), await onHand(parent.id, variant.id)]).toEqual([5, 3, 4]);
    const rows = await db.inventoryMovement.findMany({ where: { orgId, refType: "StockImport", refId: importId } });
    expect(rows.map((r) => r.reason)).toEqual(["OPENING_BALANCE", "OPENING_BALANCE", "OPENING_BALANCE"]);

    // A retry with the same id is a no-op that answers the first result; a new id is refused (already opened).
    await expect(inventory.importStock(admin, { branchId, mode: "opening", csv: file, importId })).resolves.toEqual({
      applied: 3,
      replayed: true,
    });
    await expectAppError(
      inventory.importStock(admin, { branchId, mode: "opening", csv: file, importId: randomUUID() }),
      422,
      "CSV_HAS_ERRORS",
    );
    expect(await onHand(a.id)).toBe(5);

    const audit = await db.auditEvent.findFirst({ where: { orgId, action: "inventory.stock.imported" } });
    expect(audit?.metadata).toMatchObject({ branchId, mode: "opening", importId });
    await expectReconciled(db, orgId);
  });
});

describe("adjustment mode", () => {
  it("applies signed changes with reasons and refuses rows that break the adjustment rules", async () => {
    const a = await createProduct(db, orgId);
    const b = await createProduct(db, orgId);
    await inventory.recordOpeningBalances(admin, {
      branchId,
      lines: [
        { ref: { productId: a.id }, qty: 10 },
        { ref: { productId: b.id }, qty: 2 },
      ],
    });

    const bad = await inventory.previewStockImport(admin, {
      branchId,
      mode: "adjustment",
      csv: csv(
        "sku,qty,reason,note",
        `${a.sku},-3,damaged,`,
        `${b.sku},-5,COUNT_CORRECTION,`,
        `${a.sku},+1,FOUND,`,
        `${b.sku},2,Damaged,`,
        `${b.sku},1,other,`,
        `${b.sku},1,broken,`,
      ),
    });
    expect(bad.rows.map((row) => row.errors.map((e) => e.code))).toEqual([
      [],
      ["insufficientStock"],
      ["duplicateInFile"],
      ["direction", "duplicateInFile"],
      ["noteRequired", "duplicateInFile"],
      ["reasonInvalid", "duplicateInFile"],
    ]);
    expect(bad.rows[0]).toMatchObject({ qty: -3, after: 7 });

    const importId = randomUUID();
    const result = await inventory.importStock(admin, {
      branchId,
      mode: "adjustment",
      importId,
      csv: csv("sku,qty,reason,note", `${a.sku},-3,Lost or stolen,`, `${b.sku},4,OTHER,found in back room`),
    });
    expect(result).toEqual({ applied: 2, replayed: false });
    expect([await onHand(a.id), await onHand(b.id)]).toEqual([7, 6]);
    const rows = await db.inventoryMovement.findMany({
      where: { orgId, refType: "StockImport", refId: importId },
      orderBy: { qtyDelta: "asc" },
    });
    expect(rows.map((r) => [r.reason, r.adjustmentReason, r.qtyDelta, r.note])).toEqual([
      ["ADJUSTMENT", "LOST_OR_STOLEN", -3, null],
      ["ADJUSTMENT", "OTHER", 4, "found in back room"],
    ]);
    await expectReconciled(db, orgId);
  });

  it("re-checks under the lock: stock sold after the preview refuses the whole file", async () => {
    const a = await createProduct(db, orgId);
    const b = await createProduct(db, orgId);
    await inventory.recordOpeningBalances(admin, {
      branchId,
      lines: [
        { ref: { productId: a.id }, qty: 3 },
        { ref: { productId: b.id }, qty: 3 },
      ],
    });
    const file = csv("sku,qty,reason", `${a.sku},-1,DAMAGED`, `${b.sku},-3,DAMAGED`);
    expect((await inventory.previewStockImport(admin, { branchId, mode: "adjustment", csv: file })).errorCount).toBe(0);
    await inventory.adjustStock(admin, {
      branchId,
      ref: { productId: b.id },
      adjustmentReason: "DAMAGED",
      qtyDelta: -1,
      expectedOnHand: 3,
    });
    await expectAppError(
      inventory.importStock(admin, { branchId, mode: "adjustment", csv: file, importId: randomUUID() }),
      422,
      "CSV_HAS_ERRORS",
    );
    expect([await onHand(a.id), await onHand(b.id)]).toEqual([3, 2]);
  });
});

describe("file and access rules", () => {
  it("refuses a file with no item column or with another mode's columns", async () => {
    await expectAppError(
      inventory.previewStockImport(admin, { branchId, mode: "opening", csv: csv("qty", "1") }),
      422,
      "CSV_MISSING_COLUMN",
    );
    await expectAppError(
      inventory.previewStockImport(admin, { branchId, mode: "opening", csv: csv("sku,qty,reason", "A,1,FOUND") }),
      422,
      "CSV_UNKNOWN_COLUMN",
    );
    await expectAppError(
      inventory.previewStockImport(admin, { branchId, mode: "adjustment", csv: csv("sku,qty", "A,1") }),
      422,
      "CSV_MISSING_COLUMN",
    );
  });

  it("requires inventory.adjust and audits the denied confirm", async () => {
    const file = csv("sku,qty", "A,1");
    await expectAppError(inventory.previewStockImport(cashier, { branchId, mode: "opening", csv: file }), 403);
    await expectAppError(
      inventory.importStock(cashier, { branchId, mode: "opening", csv: file, importId: randomUUID() }),
      403,
    );
    const denied = await db.auditEvent.findFirst({
      where: { orgId, actorUserId: cashier.userId, action: "inventory.permission.denied" },
    });
    expect(denied?.metadata).toMatchObject({ permission: "inventory.adjust", operation: "import" });
  });

  it("refuses another org's branch and a shop whose stock lives in the inventory system", async () => {
    const other = await createTenant(db, "Stock Import Other");
    const file = csv("sku,qty", "A,1");
    await expectAppError(
      inventory.previewStockImport(admin, { branchId: other.branchA.id, mode: "opening", csv: file }),
      404,
    );

    const owner = await createMember(db, other.org.id, "OWNER");
    const product = await createProduct(db, other.org.id);
    await db.organization.update({ where: { id: other.org.id }, data: { inventorySource: "EXTERNAL" } });
    const linked = csv("sku,qty", `${product.sku},1`);
    const input = { branchId: other.branchA.id, mode: "opening" as const, csv: linked };
    await expectAppError(inventory.previewStockImport(owner, input), 409, "MANAGED_BY_INVENTORY");
    await expectAppError(
      inventory.importStock(owner, { ...input, importId: randomUUID() }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    expect(await db.inventoryMovement.count({ where: { orgId: other.org.id } })).toBe(0);
  });

  it("applies 1000 opening rows within the transaction timeout", async () => {
    const shop = await createTenant(db, "Stock Import Bulk");
    const owner = await createMember(db, shop.org.id, "OWNER");
    const prefix = `BULK-${uniqueCode()}`;
    await db.product.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({
        orgId: shop.org.id,
        sku: `${prefix}-${i}`,
        name: `Bulk ${i}`,
        priceMinor: 100,
      })),
    });
    const rows = Array.from({ length: 1000 }, (_, i) => `${prefix}-${i},${i + 1}`);
    const result = await inventory.importStock(owner, {
      branchId: shop.branchA.id,
      mode: "opening",
      csv: csv("sku,qty", ...rows),
      importId: randomUUID(),
    });
    expect(result.applied).toBe(1000);
    await expectReconciled(db, shop.org.id);
  }, 120_000);
});
