import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { createPurchaseOrder, createSupplier, orderPurchaseOrder, type PoDetail } from "@/modules/purchasing";
import { canRunReport, exportReportCsv, getReport } from "@/modules/reports";
import { createMember, createProduct, createTenant, expectAppError, testDb, uniqueCode } from "./helpers";

/**
 * Purchases received report (T5 P5): per local day (Africa/Cairo) and supplier. Receipts are inserted
 * with fixed times so the day boundary is exact; the receiving flow itself is covered in purchasing.test.ts.
 */

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let admin: TenantContext;
let manager: TenantContext;
let nile: { id: string; name: string };
let delta: { id: string; name: string };

/** Inserts a receipt of `lines` [qty, unitCost] on an ordered PO at `receivedAt`. */
async function receipt(supplierId: string, receivedAt: string, lines: [number, number][], branch = tenant.branchA.id) {
  const products = await Promise.all(lines.map(() => createProduct(db, tenant.org.id)));
  const draft = await createPurchaseOrder(admin, {
    branchId: branch,
    supplierId,
    lines: lines.map(([qty, unitCostMinor], i) => ({ ref: { productId: products[i].id }, qty, unitCostMinor })),
  });
  const po = await orderPurchaseOrder(admin, draft.id);
  const id = randomUUID();
  await db.goodsReceipt.create({
    data: {
      id,
      orgId: tenant.org.id,
      branchId: branch,
      purchaseOrderId: po.id,
      idempotencyKey: randomUUID(),
      requestHash: "fixture",
      receivedById: admin.userId,
      receivedAt: new Date(receivedAt),
    },
  });
  await db.goodsReceiptItem.createMany({
    data: po.lines.map((line) => {
      const index = products.findIndex((p) => p.id === line.productId);
      return {
        orgId: tenant.org.id,
        goodsReceiptId: id,
        poItemId: line.id,
        productId: line.productId,
        variantId: null,
        qtyReceived: lines[index][0],
        unitCostMinor: lines[index][1],
      };
    }),
  });
  return po;
}

/** Inserts a return to the supplier of `qty` of the PO's line costing `unitCostMinor` at `returnedAt` (purchase-returns-spec R12). */
async function supplierReturn(po: PoDetail, returnedAt: string, qty: number, unitCostMinor: number) {
  const id = randomUUID();
  const line = po.lines.find((l) => l.unitCostMinor === unitCostMinor);
  if (!line) throw new Error("line missing");
  await db.purchaseReturn.create({
    data: {
      id,
      orgId: tenant.org.id,
      branchId: po.branch.id,
      purchaseOrderId: po.id,
      seq: 1,
      reason: "DAMAGED",
      idempotencyKey: randomUUID(),
      requestHash: "fixture",
      returnedById: admin.userId,
      returnedAt: new Date(returnedAt),
    },
  });
  await db.purchaseReturnItem.create({
    data: {
      orgId: tenant.org.id,
      purchaseReturnId: id,
      poItemId: line.id,
      productId: line.productId,
      qty,
      unitCostMinor: line.unitCostMinor,
    },
  });
}

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Purchases report");
  admin = await createMember(db, tenant.org.id, "ADMIN");
  manager = await createMember(db, tenant.org.id, "MANAGER");
  nile = await createSupplier(admin, { name: `Nile ${uniqueCode()}` });
  delta = await createSupplier(admin, { name: `Delta ${uniqueCode()}` });
  // 2026-03-10 in Cairo (UTC+2): two Nile receipts and one Delta receipt.
  const nileFirst = await receipt(nile.id, "2026-03-10T08:00:00Z", [
    [10, 150],
    [2, 1000],
  ]);
  await receipt(nile.id, "2026-03-10T21:30:00Z", [[1, 99]]); // 23:30 Cairo, still the 10th
  const deltaFirst = await receipt(delta.id, "2026-03-10T09:00:00Z", [[4, 250]]);
  // 22:30 UTC on the 10th is 00:30 on the 11th in Cairo.
  await receipt(delta.id, "2026-03-10T22:30:00Z", [[3, 100]]);
  // Another branch, same day.
  await receipt(nile.id, "2026-03-10T10:00:00Z", [[5, 10]], tenant.branchB.id);
  // Returns on their own day: one Delta unit the same day, two Nile units (cost 150) on the 11th,
  // a day Nile delivered nothing.
  await supplierReturn(deltaFirst, "2026-03-10T12:00:00Z", 1, 250);
  await supplierReturn(nileFirst, "2026-03-11T10:00:00Z", 2, 150);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("purchases report", () => {
  it("sums receipts, units and value per local day and supplier", async () => {
    const result = await getReport(admin, "purchases", {
      branchId: tenant.branchA.id,
      from: "2026-03-10",
      to: "2026-03-11",
    });
    expect(
      result.rows.map((r) => [
        r.day,
        r.supplierName,
        r.receiptsCount,
        r.units,
        r.valueMinor,
        r.returnedUnits,
        r.returnedValueMinor,
        r.netValueMinor,
      ]),
    ).toEqual([
      ["2026-03-10", delta.name, 1, 4, 1000, 1, 250, 750],
      ["2026-03-10", nile.name, 2, 13, 3599, 0, 0, 3599],
      ["2026-03-11", delta.name, 1, 3, 300, 0, 0, 300],
      ["2026-03-11", nile.name, 0, 0, 0, 2, 300, -300],
    ]);
    expect(result.totals).toEqual({
      receiptsCount: 4,
      units: 20,
      valueMinor: 4899,
      returnedUnits: 3,
      returnedValueMinor: 550,
      netValueMinor: 4349,
    });
  });

  it("covers every branch in scope when no branch is given", async () => {
    const result = await getReport(admin, "purchases", { from: "2026-03-10", to: "2026-03-10" });
    expect(result.totals).toEqual({
      receiptsCount: 4,
      units: 22,
      valueMinor: 4649,
      returnedUnits: 1,
      returnedValueMinor: 250,
      netValueMinor: 4399,
    });
  });

  it("exports CSV with a total line", async () => {
    const { body } = await exportReportCsv(admin, "purchases", { from: "2026-03-11", to: "2026-03-11" });
    expect(body).toContain(delta.name);
    expect(body).toContain("3.00");
    // The Nile row of the 11th has only a return: net is negative.
    expect(body).toContain("-3.00");
  });

  it("is refused to a manager (no purchases.manage), audited, and hidden from the picker", async () => {
    expect(canRunReport(manager, "purchases")).toBe(false);
    expect(canRunReport(manager, "sales-summary")).toBe(true);
    expect(canRunReport(admin, "purchases")).toBe(true);
    await expectAppError(getReport(manager, "purchases", { from: "2026-03-10", to: "2026-03-10" }), 403);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId: tenant.org.id, actorUserId: manager.userId, action: "reports.permission.denied" },
    });
    expect(event.metadata).toMatchObject({ permission: "purchases.manage", operation: "report.purchases" });
  });
});
