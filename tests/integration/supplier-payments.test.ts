import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import {
  createPurchaseOrder,
  createSupplier,
  getSupplierStatement,
  orderPurchaseOrder,
  receivePurchaseOrder,
  recordSupplierPayment,
  returnToSupplier,
  reverseSupplierPayment,
  type PoDetail,
} from "@/modules/purchasing";
import { exportReportCsv, getReport } from "@/modules/reports";
import { addDays, todayIn } from "@/modules/reports/timezone";
import { createMember, createProduct, createTenant, expectAppError, testDb, uniqueCode } from "./helpers";

/** Supplier payments and balances (supplier-payments-spec.md): balance, idempotency, reversal, scope, report. */

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let orgId: string;
let admin: TenantContext;
let manager: TenantContext;
let branchAdmin: TenantContext;
const today = todayIn("Africa/Cairo");

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Supplier payments");
  orgId = tenant.org.id;
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
  branchAdmin = await createMember(db, orgId, "ADMIN");
  await db.membership.update({ where: { id: branchAdmin.membershipId }, data: { allBranches: false } });
  await db.membershipBranch.create({
    data: { orgId, membershipId: branchAdmin.membershipId, branchId: tenant.branchA.id },
  });
});

afterAll(async () => {
  await db.$disconnect();
});

const KEY = () => `pay-${uniqueCode()}`;

async function supplier() {
  return createSupplier(admin, { name: `Supplier ${uniqueCode()}` });
}

/** A PO from `supplierId` at branch A, `qty` × `costMinor`, fully received. */
async function received(supplierId: string, qty: number, costMinor: number, branchId = tenant.branchA.id) {
  const p = await createProduct(db, orgId);
  const draft = await createPurchaseOrder(admin, {
    branchId,
    supplierId,
    lines: [{ ref: { productId: p.id }, qty, unitCostMinor: costMinor }],
  });
  const po = await orderPurchaseOrder(admin, draft.id);
  return (await receivePurchaseOrder(admin, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty }] }))
    .po as PoDetail;
}

const pay = (supplierId: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
  recordSupplierPayment(admin, supplierId, KEY(), { amountMinor, method: "CASH", paidOn: today, ...extra });

const balance = async (supplierId: string) => (await getSupplierStatement(admin, supplierId)).balanceMinor;

describe("supplier payments", () => {
  it("received − returns − payments, with a running balance and an audit row", async () => {
    const s = await supplier();
    const po = await received(s.id, 10, 250); // 2,500
    await returnToSupplier(admin, po.id, KEY(), { reason: "DAMAGED", lines: [{ poItemId: po.lines[0].id, qty: 2 }] });
    const { paymentId, created } = await pay(s.id, 1_000, {
      method: "BANK_TRANSFER",
      reference: "TRX-1",
      purchaseOrderId: po.id,
    });
    expect(created).toBe(true);

    const statement = await getSupplierStatement(admin, s.id, { from: today, to: today });
    expect(statement.openingMinor).toBe(0);
    expect(statement.entries.map((e) => [e.kind, e.amountMinor, e.balanceMinor])).toEqual([
      ["RECEIPT", 2_500, 2_500],
      ["RETURN", 500, 2_000],
      ["PAYMENT", 1_000, 1_000],
    ]);
    expect(statement.closingMinor).toBe(1_000);
    expect(statement.balanceMinor).toBe(1_000);
    const payment = statement.entries[2];
    expect(payment).toMatchObject({ method: "BANK_TRANSFER", reference: "TRX-1", number: po.number });

    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "purchasing.supplier_payment.recorded", entityId: paymentId },
    });
    expect(event.metadata).toMatchObject({ supplierId: s.id, amountMinor: 1_000, method: "BANK_TRANSFER" });
  });

  it("counts receipts from every branch, and opens a later range with the earlier balance", async () => {
    const s = await supplier();
    await received(s.id, 1, 300, tenant.branchA.id);
    await received(s.id, 1, 200, tenant.branchB.id);
    await pay(s.id, 100, { paidOn: addDays(today, -3) });
    expect(await balance(s.id)).toBe(400);

    const earlier = await getSupplierStatement(admin, s.id, { from: addDays(today, -3), to: addDays(today, -1) });
    expect(earlier.openingMinor).toBe(0);
    expect(earlier.closingMinor).toBe(-100);
    const later = await getSupplierStatement(admin, s.id, { from: today, to: today });
    expect(later.openingMinor).toBe(-100);
    expect(later.entries).toHaveLength(2);
    expect(later.closingMinor).toBe(400);
  });

  it("replays the same key and body, and refuses the key with another body", async () => {
    const s = await supplier();
    const key = KEY();
    const body = { amountMinor: 500, method: "CARD", paidOn: today };
    const first = await recordSupplierPayment(admin, s.id, key, body);
    const again = await recordSupplierPayment(admin, s.id, key, body);
    expect(again).toEqual({ paymentId: first.paymentId, created: false });
    await expectAppError(recordSupplierPayment(admin, s.id, key, { ...body, amountMinor: 501 }), 409);

    const [a, b] = await Promise.all([
      recordSupplierPayment(admin, s.id, "race-" + key, body),
      recordSupplierPayment(admin, s.id, "race-" + key, body),
    ]);
    expect(a.paymentId).toBe(b.paymentId);
    expect(await balance(s.id)).toBe(-1_000);
  });

  it("refuses a future date, a zero amount and another supplier's PO", async () => {
    const s = await supplier();
    const other = await supplier();
    const otherPo = await received(other.id, 1, 100);
    await expectAppError(pay(s.id, 100, { paidOn: addDays(today, 1) }), 422, "PAYMENT_DATE_IN_FUTURE");
    await expect(pay(s.id, 0)).rejects.toBeInstanceOf(ZodError);
    await expectAppError(pay(s.id, 100, { purchaseOrderId: otherPo.id }), 404);
    expect(await db.supplierPayment.count({ where: { orgId, supplierId: s.id } })).toBe(0);
  });

  it("reverses a payment once, dated today, never a reversal; replays the reversal key", async () => {
    const s = await supplier();
    await received(s.id, 1, 1_000);
    const { paymentId } = await pay(s.id, 400, { paidOn: addDays(today, -10), reference: "CHQ-9" });
    expect(await balance(s.id)).toBe(600);

    const key = KEY();
    const reversal = await reverseSupplierPayment(admin, s.id, paymentId, key, { reason: "Bounced" });
    expect(reversal.created).toBe(true);
    expect(await reverseSupplierPayment(admin, s.id, paymentId, key, { reason: "Bounced" })).toEqual({
      paymentId: reversal.paymentId,
      created: false,
    });
    expect(await balance(s.id)).toBe(1_000);

    await expectAppError(
      reverseSupplierPayment(admin, s.id, paymentId, KEY(), { reason: "Again" }),
      409,
      "PAYMENT_ALREADY_REVERSED",
    );
    await expectAppError(
      reverseSupplierPayment(admin, s.id, reversal.paymentId, KEY(), { reason: "Undo" }),
      409,
      "PAYMENT_NOT_REVERSIBLE",
    );
    await expect(reverseSupplierPayment(admin, s.id, paymentId, KEY(), { reason: " " })).rejects.toBeInstanceOf(
      ZodError,
    );

    const statement = await getSupplierStatement(admin, s.id, { from: addDays(today, -10), to: today });
    const original = statement.entries.find((e) => e.id === paymentId);
    const row = statement.entries.find((e) => e.id === reversal.paymentId);
    expect(original?.reversed).toBe(true);
    expect(row).toMatchObject({ kind: "REVERSAL", day: today, amountMinor: 400, note: "Bounced", reference: "CHQ-9" });
    expect(
      await db.auditEvent.count({
        where: { orgId, action: "purchasing.supplier_payment.reversed", entityId: reversal.paymentId },
      }),
    ).toBe(1);
  });

  it("lets only one of two concurrent reversals through", async () => {
    const s = await supplier();
    const { paymentId } = await pay(s.id, 300);
    const results = await Promise.allSettled([
      reverseSupplierPayment(admin, s.id, paymentId, KEY(), { reason: "A" }),
      reverseSupplierPayment(admin, s.id, paymentId, KEY(), { reason: "B" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(s.id)).toBe(0);
  });

  it("never updates or deletes a payment row", async () => {
    const s = await supplier();
    const { paymentId } = await pay(s.id, 100);
    await expect(db.supplierPayment.update({ where: { id: paymentId }, data: { amountMinor: 1 } })).rejects.toThrow();
    await expect(db.supplierPayment.delete({ where: { id: paymentId } })).rejects.toThrow();
  });

  it("refuses a manager and a branch-limited admin (audited), and a linked shop's writes", async () => {
    const s = await supplier();
    await expectAppError(getSupplierStatement(manager, s.id), 403);
    await expectAppError(
      recordSupplierPayment(manager, s.id, KEY(), { amountMinor: 1, method: "CASH", paidOn: today }),
      403,
    );
    await expectAppError(getSupplierStatement(branchAdmin, s.id), 403);
    await expectAppError(getReport(branchAdmin, "supplier-balances", {}), 403);
    expect(
      await db.auditEvent.count({
        where: {
          orgId,
          action: "purchasing.permission.denied",
          actorUserId: { in: [manager.userId, branchAdmin.userId] },
        },
      }),
    ).toBe(3);

    await db.organization.update({ where: { id: orgId }, data: { inventorySource: "EXTERNAL" } });
    try {
      await expectAppError(pay(s.id, 100), 409, "MANAGED_BY_INVENTORY");
      expect(await balance(s.id)).toBe(0);
    } finally {
      await db.organization.update({ where: { id: orgId }, data: { inventorySource: "BUILT_IN" } });
    }
  });

  it("hides another org's supplier, PO and payment (404)", async () => {
    const s = await supplier();
    const po = await received(s.id, 1, 100);
    const { paymentId } = await pay(s.id, 50);
    const other = await createTenant(db, "Supplier payments other");
    const otherAdmin = await createMember(db, other.org.id, "ADMIN");
    const otherSupplier = await createSupplier(otherAdmin, { name: `Other ${uniqueCode()}` });

    await expectAppError(getSupplierStatement(otherAdmin, s.id), 404);
    await expectAppError(
      recordSupplierPayment(otherAdmin, s.id, KEY(), { amountMinor: 1, method: "CASH", paidOn: today }),
      404,
    );
    await expectAppError(
      recordSupplierPayment(otherAdmin, otherSupplier.id, KEY(), {
        amountMinor: 1,
        method: "CASH",
        paidOn: today,
        purchaseOrderId: po.id,
      }),
      404,
    );
    await expectAppError(reverseSupplierPayment(otherAdmin, otherSupplier.id, paymentId, KEY(), { reason: "x" }), 404);
    await expectAppError(reverseSupplierPayment(admin, s.id, randomUUID(), KEY(), { reason: "x" }), 404);
    await expectAppError(getSupplierStatement(admin, "not-a-uuid"), 404);
    const otherReport = await getReport(otherAdmin, "supplier-balances", {});
    expect(otherReport.rows.some((row) => row.supplierId === s.id)).toBe(false);
  });
});

describe("Supplier balances report", () => {
  it("matches each supplier's statement, totals the rows and exports CSV", async () => {
    const own = await createTenant(db, "Supplier balances report");
    const owner = await createMember(db, own.org.id, "OWNER");
    const make = (name: string) => createSupplier(owner, { name });
    const [alpha, beta, quiet] = await Promise.all([make("Alpha"), make("Beta"), make("Quiet")]);
    const receive = async (supplierId: string, qty: number, cost: number) => {
      const p = await createProduct(db, own.org.id);
      const draft = await createPurchaseOrder(owner, {
        branchId: own.branchA.id,
        supplierId,
        lines: [{ ref: { productId: p.id }, qty, unitCostMinor: cost }],
      });
      const po = await orderPurchaseOrder(owner, draft.id);
      return (await receivePurchaseOrder(owner, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty }] })).po;
    };
    const po = await receive(alpha.id, 4, 500); // 2,000
    await returnToSupplier(owner, po.id, KEY(), { reason: "OTHER", lines: [{ poItemId: po.lines[0].id, qty: 1 }] });
    const early = await recordSupplierPayment(owner, alpha.id, KEY(), {
      amountMinor: 300,
      method: "CASH",
      paidOn: addDays(today, -5),
    });
    await recordSupplierPayment(owner, alpha.id, KEY(), { amountMinor: 700, method: "CHEQUE", paidOn: today });
    await reverseSupplierPayment(owner, alpha.id, early.paymentId, KEY(), { reason: "Wrong supplier" });
    await recordSupplierPayment(owner, beta.id, KEY(), {
      amountMinor: 250,
      method: "CASH",
      paidOn: addDays(today, -5),
    });

    const report = await getReport(owner, "supplier-balances", { from: today, to: today });
    expect(report.rows).toEqual([
      {
        supplierId: alpha.id,
        supplierName: "Alpha",
        openingMinor: -300,
        receivedMinor: 2_000,
        returnedMinor: 500,
        adjustedMinor: 0,
        paidMinor: 400,
        closingMinor: 800,
        uninvoicedMinor: 2_000,
      },
      // No movement today, but an opening balance (a deposit).
      {
        supplierId: beta.id,
        supplierName: "Beta",
        openingMinor: -250,
        receivedMinor: 0,
        returnedMinor: 0,
        adjustedMinor: 0,
        paidMinor: 0,
        closingMinor: -250,
        uninvoicedMinor: 0,
      },
    ]);
    expect(report.rows.some((row) => row.supplierId === quiet.id)).toBe(false);
    expect(report.totals).toEqual({
      openingMinor: -550,
      receivedMinor: 2_000,
      returnedMinor: 500,
      adjustedMinor: 0,
      paidMinor: 400,
      closingMinor: 550,
      uninvoicedMinor: 2_000,
    });
    for (const row of report.rows) {
      const statement = await getSupplierStatement(owner, row.supplierId as string, { from: today, to: today });
      expect([statement.openingMinor, statement.closingMinor]).toEqual([row.openingMinor, row.closingMinor]);
    }

    const { body } = await exportReportCsv(owner, "supplier-balances", { from: today, to: today });
    expect(body).toContain("Alpha,-3.00,20.00,5.00,0.00,4.00,8.00,20.00");
    expect(body).toContain("Total,-5.50,20.00,5.00,0.00,4.00,5.50,20.00");
  });
});
