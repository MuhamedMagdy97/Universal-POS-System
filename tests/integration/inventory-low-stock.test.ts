import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { createSale } from "@/modules/sales";
import { openShift } from "@/modules/registers";
import {
  createMember,
  createProduct,
  createTenant,
  createVariant,
  expectAppError,
  expectReconciled,
  testDb,
} from "./helpers";

/** Reorder points and the low-stock list (docs/planning/low-stock/low-stock-spec.md). */
let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let manager: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Low Stock");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
  cashier = await createMember(db, orgId, "CASHIER");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const ref = (productId: string, variantId: string | null = null) => ({ productId, variantId });

async function stocked(qty: number) {
  const product = await createProduct(db, orgId);
  await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty }] });
  return product;
}

const lowIds = async (ctx: TenantContext = admin, branch = branchId) =>
  (await inventory.listLowStock(ctx, { branchId: branch })).rows.map((row) => row.productId);

describe("setReorderPoint", () => {
  it("sets, audits, and leaves on-hand and the last-change time alone", async () => {
    const product = await stocked(5);
    const before = await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId: product.id } });
    expect(await inventory.setReorderPoint(manager, { branchId, ref: ref(product.id), reorderPoint: 3 })).toEqual({
      reorderPoint: 3,
    });
    const after = await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId: product.id } });
    expect(after).toMatchObject({ qty: 5, reorderPoint: 3, updatedAt: before.updatedAt });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "inventory.reorder_point.set", entityId: after.id },
    });
    expect(audit.metadata).toMatchObject({ branchId, before: null, after: 3 });
  });

  it("creates the balance row for an item with no stock yet (qty 0 stays reconciled)", async () => {
    const product = await createProduct(db, orgId);
    await inventory.setReorderPoint(admin, { branchId, ref: ref(product.id), reorderPoint: 0 });
    expect(await lowIds()).toContain(product.id);
    await expectReconciled(db, orgId);
  });

  it("is a no-op for the same value and clears with null", async () => {
    const product = await stocked(1);
    await inventory.setReorderPoint(admin, { branchId, ref: ref(product.id), reorderPoint: 2 });
    await inventory.setReorderPoint(admin, { branchId, ref: ref(product.id), reorderPoint: 2 });
    expect(
      await db.auditEvent.count({
        where: {
          orgId,
          action: "inventory.reorder_point.set",
          metadata: { path: ["ref", "productId"], equals: product.id },
        },
      }),
    ).toBe(1);
    expect(await lowIds()).toContain(product.id);
    await inventory.setReorderPoint(admin, { branchId, ref: ref(product.id), reorderPoint: null });
    expect(await lowIds()).not.toContain(product.id);
  });

  it("refuses a Cashier (403) and audits the denial", async () => {
    const product = await stocked(1);
    await expectAppError(inventory.setReorderPoint(cashier, { branchId, ref: ref(product.id), reorderPoint: 1 }), 403);
    expect(
      await db.auditEvent.count({
        where: { orgId, actorUserId: cashier.userId, action: "inventory.permission.denied" },
      }),
    ).toBe(1);
  });

  it("rejects negative points and another org's item or branch", async () => {
    const product = await stocked(1);
    await expect(
      inventory.setReorderPoint(admin, { branchId, ref: ref(product.id), reorderPoint: -1 }),
    ).rejects.toThrow();
    const other = await createTenant(db, "Low Stock Other");
    const foreign = await createProduct(db, other.org.id);
    await expectAppError(inventory.setReorderPoint(admin, { branchId, ref: ref(foreign.id), reorderPoint: 1 }), 404);
    await expectAppError(
      inventory.setReorderPoint(admin, { branchId: other.branchA.id, ref: ref(product.id), reorderPoint: 1 }),
      404,
    );
  });
});

describe("listLowStock", () => {
  it("lists an item once a sale or an adjustment takes it to the point, per branch", async () => {
    const sold = await stocked(5);
    const adjusted = await stocked(5);
    for (const p of [sold, adjusted]) {
      await inventory.setReorderPoint(admin, { branchId, ref: ref(p.id), reorderPoint: 3 });
    }
    expect(await lowIds()).not.toContain(sold.id);

    await openShift(cashier, { branchId, registerId: tenant.register.id, openingFloatMinor: 0 });
    await createSale(
      cashier,
      {
        branchId,
        registerId: tenant.register.id,
        lines: [{ ref: ref(sold.id), qty: 2 }],
        payments: [{ method: "CASH", amountMinor: 2000 }],
      },
      `low-${Date.now()}`,
    );
    await inventory.adjustStock(admin, {
      branchId,
      ref: ref(adjusted.id),
      adjustmentReason: "DAMAGED",
      qtyDelta: -3,
      expectedOnHand: 5,
    });

    const { rows } = await inventory.listLowStock(admin, { branchId });
    expect(rows.find((r) => r.productId === sold.id)).toMatchObject({ qty: 3, reorderPoint: 3 });
    expect(rows.find((r) => r.productId === adjusted.id)).toMatchObject({ qty: 2, reorderPoint: 3 });
    // Sorted by shortfall: the adjusted item (short by 1) comes before the sold one (short by 0).
    expect(rows.findIndex((r) => r.productId === adjusted.id)).toBeLessThan(
      rows.findIndex((r) => r.productId === sold.id),
    );
    expect(await lowIds(admin, tenant.branchB.id)).not.toContain(sold.id);
    expect(await inventory.countLowStock(admin, branchId)).toBe(rows.length);
  });

  it("lists variants and hides archived items with no stock", async () => {
    const product = await createProduct(db, orgId);
    const variant = await createVariant(db, orgId, product.id);
    await inventory.setReorderPoint(admin, { branchId, ref: ref(product.id, variant.id), reorderPoint: 1 });
    const row = (await inventory.listLowStock(admin, { branchId })).rows.find((r) => r.variantId === variant.id);
    expect(row).toMatchObject({ productId: product.id, variantName: variant.name, sku: variant.sku, qty: 0 });

    await db.productVariant.update({ where: { id: variant.id }, data: { isActive: false } });
    expect((await inventory.listLowStock(admin, { branchId })).rows.some((r) => r.variantId === variant.id)).toBe(
      false,
    );
  });

  it("is tenant-isolated and needs inventory.read", async () => {
    const other = await createTenant(db, "Low Stock Iso");
    const outsider = await createMember(db, other.org.id, "ADMIN");
    await expectAppError(inventory.listLowStock(outsider, { branchId }), 404);
    expect(await lowIds(outsider, other.branchA.id)).toEqual([]);
    await expectAppError(inventory.listLowStock(cashier, { branchId }), 403);
  });

  it("exports CSV with a BOM, formula-safe names and an audit row", async () => {
    const product = await createProduct(db, orgId);
    await db.product.update({ where: { id: product.id }, data: { name: "=SUM(A1)" } });
    await inventory.setReorderPoint(admin, { branchId, ref: ref(product.id), reorderPoint: 4 });
    const { filename, body } = await inventory.exportLowStockCsv(admin, { branchId }, "en");
    expect(filename).toBe(`low-stock_${branchId}.csv`);
    expect(body.startsWith("﻿Item,SKU,On hand,Reorder point,Short by\r\n")).toBe(true);
    expect(body).toContain(`'=SUM(A1),${product.sku},0,4,4\r\n`);
    expect(await db.auditEvent.count({ where: { orgId, action: "inventory.low_stock.exported" } })).toBe(1);
  });
});
