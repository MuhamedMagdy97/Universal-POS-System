import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import {
  allocateSupplierPayment,
  createPurchaseOrder,
  createSupplier,
  getSupplierStatement,
  listSupplierInvoices,
  orderPurchaseOrder,
  receivePurchaseOrder,
  recordSupplierInvoice,
  recordSupplierPayment,
  returnToSupplier,
  reverseSupplierPayment,
  voidSupplierInvoice,
  type PoDetail,
} from "@/modules/purchasing";
import { openShift } from "@/modules/registers";
import { exportReportCsv, getReport } from "@/modules/reports";
import { addDays, todayIn } from "@/modules/reports/timezone";
import { createSale } from "@/modules/sales";
import { createMember, createProduct, createTenant, expectAppError, testDb, uniqueCode } from "./helpers";

/**
 * Supplier invoices, credit notes, allocation and input VAT (supplier-invoices-spec.md): balance
 * effects, idempotency, void, caps, isolation, reports. The test org is Egyptian: VAT 14%.
 */

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let orgId: string;
let admin: TenantContext;
let manager: TenantContext;
const today = todayIn("Africa/Cairo");

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Supplier invoices");
  orgId = tenant.org.id;
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
});

afterAll(async () => {
  await db.$disconnect();
});

const KEY = () => `inv-${uniqueCode()}`;

async function supplier(ctx = admin) {
  return createSupplier(ctx, { name: `Supplier ${uniqueCode()}` });
}

/** A PO from `supplierId`, `qty` × `costMinor`, fully received; returns the PO and its receipt id. */
async function received(supplierId: string, qty: number, costMinor: number, ctx = admin, org = tenant) {
  const p = await createProduct(db, org.org.id);
  const draft = await createPurchaseOrder(ctx, {
    branchId: org.branchA.id,
    supplierId,
    lines: [{ ref: { productId: p.id }, qty, unitCostMinor: costMinor }],
  });
  const po = await orderPurchaseOrder(ctx, draft.id);
  const result = await receivePurchaseOrder(ctx, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty }] });
  return { po: result.po as PoDetail, receiptId: result.receiptId };
}

const invoice = (supplierId: string, body: Record<string, unknown>, ctx = admin) =>
  recordSupplierInvoice(ctx, supplierId, KEY(), {
    kind: "INVOICE",
    number: `INV-${uniqueCode()}`,
    issuedOn: today,
    ...body,
  });

const pay = (supplierId: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
  recordSupplierPayment(admin, supplierId, KEY(), { amountMinor, method: "BANK_TRANSFER", paidOn: today, ...extra });

const balance = async (supplierId: string) => (await getSupplierStatement(admin, supplierId)).balanceMinor;
const docOf = async (supplierId: string, id: string) =>
  (await listSupplierInvoices(admin, supplierId)).invoices.find((doc) => doc.id === id);

describe("supplier invoices", () => {
  it("replaces the receipt's cost by the invoice total, then a payment allocated to it settles it", async () => {
    const s = await supplier();
    const { receiptId } = await received(s.id, 10, 1_000); // 10,000 at cost
    expect((await listSupplierInvoices(admin, s.id)).uninvoicedReceipts.map((r) => r.id)).toEqual([receiptId]);

    const { invoiceId, created } = await invoice(s.id, {
      number: "A-1",
      dueOn: addDays(today, 30),
      netMinor: 10_000,
      vatMinor: 1_400,
      goodsReceiptIds: [receiptId],
    });
    expect(created).toBe(true);
    expect(await balance(s.id)).toBe(11_400);
    const list = await listSupplierInvoices(admin, s.id);
    expect(list.uninvoicedReceipts).toEqual([]);
    expect(list.vatRateBp).toBe(1_400);
    expect(await docOf(s.id, invoiceId)).toMatchObject({
      totalMinor: 11_400,
      coveredMinor: 10_000,
      openMinor: 11_400,
      status: "OPEN",
    });

    const statement = await getSupplierStatement(admin, s.id, { from: today, to: today });
    expect(statement.entries.map((e) => [e.kind, e.amountMinor, e.balanceMinor])).toEqual([
      ["RECEIPT", 10_000, 10_000],
      ["INVOICE", 11_400, 11_400],
    ]);

    const { paymentId } = await pay(s.id, 11_400, { allocations: [{ invoiceId, amountMinor: 11_400 }] });
    expect(await balance(s.id)).toBe(0);
    expect(await docOf(s.id, invoiceId)).toMatchObject({ paidMinor: 11_400, openMinor: 0, status: "PAID" });
    expect((await listSupplierInvoices(admin, s.id)).unallocatedPayments).toEqual([]);

    const recorded = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "purchasing.supplier_invoice.recorded", entityId: invoiceId },
    });
    expect(recorded.metadata).toMatchObject({ number: "A-1", vatMinor: 1_400, goodsReceiptIds: [receiptId] });
    const paid = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "purchasing.supplier_payment.recorded", entityId: paymentId },
    });
    expect(paid.metadata).toMatchObject({ allocations: [{ invoiceId, amountMinor: 11_400 }] });

    // A reversed payment's allocation stops counting: the invoice is open again.
    await reverseSupplierPayment(admin, s.id, paymentId, KEY(), { reason: "Bounced" });
    expect(await docOf(s.id, invoiceId)).toMatchObject({ paidMinor: 0, status: "OPEN" });
    await expectAppError(
      allocateSupplierPayment(admin, s.id, paymentId, KEY(), { allocations: [{ invoiceId, amountMinor: 1 }] }),
      409,
      "PAYMENT_ALREADY_REVERSED",
    );
  });

  it("caps input VAT at the shop rate plus 1.00, allows less, and checks dates and links", async () => {
    const s = await supplier();
    await expectAppError(invoice(s.id, { netMinor: 10_000, vatMinor: 1_501 }), 422, "VAT_ABOVE_RATE");
    expect((await invoice(s.id, { netMinor: 10_000, vatMinor: 1_500 })).created).toBe(true);
    expect((await invoice(s.id, { netMinor: 10_000, vatMinor: 0 })).created).toBe(true);
    await expectAppError(
      invoice(s.id, { netMinor: 1, vatMinor: 0, issuedOn: addDays(today, 1) }),
      422,
      "INVOICE_DATE_IN_FUTURE",
    );
    await expectAppError(
      invoice(s.id, { netMinor: 1, vatMinor: 0, dueOn: addDays(today, -1) }),
      422,
      "DUE_BEFORE_ISSUE",
    );
    await expectAppError(invoice(s.id, { netMinor: 0, vatMinor: 0 }), 422, "TOTAL_NOT_POSITIVE");
    await expectAppError(
      invoice(s.id, { kind: "CREDIT_NOTE", netMinor: 1, vatMinor: 0, dueOn: today }),
      422,
      "INVALID_DOCUMENT_LINK",
    );
    await expectAppError(
      invoice(s.id, { netMinor: 1, vatMinor: 0, purchaseReturnId: randomUUID() }),
      422,
      "INVALID_DOCUMENT_LINK",
    );
  });

  it("is idempotent; a number is unique per supplier until voided; a receipt is on one live invoice", async () => {
    const s = await supplier();
    const other = await supplier();
    const { receiptId } = await received(s.id, 1, 5_000);
    const key = KEY();
    const body = {
      kind: "INVOICE",
      number: "X-9",
      issuedOn: today,
      netMinor: 5_000,
      vatMinor: 700,
      goodsReceiptIds: [receiptId],
    };
    const first = await recordSupplierInvoice(admin, s.id, key, body);
    expect(await recordSupplierInvoice(admin, s.id, key, body)).toEqual({ invoiceId: first.invoiceId, created: false });
    await expectAppError(recordSupplierInvoice(admin, s.id, key, { ...body, vatMinor: 699 }), 409);

    await expectAppError(invoice(s.id, { number: "x-9", netMinor: 1, vatMinor: 0 }), 409, "INVOICE_NUMBER_TAKEN");
    expect((await invoice(other.id, { number: "X-9", netMinor: 1, vatMinor: 0 })).created).toBe(true);
    expect((await invoice(s.id, { kind: "CREDIT_NOTE", number: "X-9", netMinor: 1, vatMinor: 0 })).created).toBe(true);
    await expectAppError(
      invoice(s.id, { netMinor: 5_000, vatMinor: 700, goodsReceiptIds: [receiptId] }),
      409,
      "RECEIPT_ALREADY_INVOICED",
    );
    // Another supplier's receipt is not found.
    await expectAppError(invoice(other.id, { netMinor: 1, vatMinor: 0, goodsReceiptIds: [receiptId] }), 404);

    // Void: idempotent, frees the number and the receipt, undoes the balance effect on the void day.
    const before = await balance(s.id);
    expect(await voidSupplierInvoice(admin, s.id, first.invoiceId, { reason: "Wrong VAT" })).toEqual({
      invoiceId: first.invoiceId,
      created: true,
    });
    expect(await voidSupplierInvoice(admin, s.id, first.invoiceId, { reason: "Again" })).toEqual({
      invoiceId: first.invoiceId,
      created: false,
    });
    expect(await balance(s.id)).toBe(before - 700);
    const again = await invoice(s.id, { number: "X-9", netMinor: 5_000, vatMinor: 700, goodsReceiptIds: [receiptId] });
    expect(again.created).toBe(true);
    expect(await balance(s.id)).toBe(before);
    const kinds = (await getSupplierStatement(admin, s.id, { from: today, to: today })).entries.map((e) => e.kind);
    expect(kinds).toContain("INVOICE_VOID");
    expect(
      await db.auditEvent.count({
        where: { orgId, action: "purchasing.supplier_invoice.voided", entityId: first.invoiceId },
      }),
    ).toBe(1);
  });

  it("allocates within open amounts and what is left on the payment; a void releases the allocation", async () => {
    const s = await supplier();
    const a = await invoice(s.id, { number: "OLD", netMinor: 1_000, vatMinor: 0, dueOn: addDays(today, 5) });
    const b = await invoice(s.id, { number: "NEW", netMinor: 2_000, vatMinor: 0, dueOn: addDays(today, 10) });
    await expectAppError(
      pay(s.id, 500, { allocations: [{ invoiceId: a.invoiceId, amountMinor: 600 }] }),
      422,
      "ALLOCATION_EXCEEDS_PAYMENT",
    );
    await expectAppError(
      pay(s.id, 5_000, { allocations: [{ invoiceId: a.invoiceId, amountMinor: 1_001 }] }),
      409,
      "AMOUNT_EXCEEDS_OPEN",
    );
    expect(await db.supplierPayment.count({ where: { orgId, supplierId: s.id } })).toBe(0);

    // A deposit, allocated later.
    const { paymentId } = await pay(s.id, 2_500);
    expect(
      (await listSupplierInvoices(admin, s.id)).unallocatedPayments.map((p) => [p.id, p.unallocatedMinor]),
    ).toEqual([[paymentId, 2_500]]);
    const key = KEY();
    const body = {
      allocations: [
        { invoiceId: a.invoiceId, amountMinor: 1_000 },
        { invoiceId: b.invoiceId, amountMinor: 1_000 },
      ],
    };
    expect((await allocateSupplierPayment(admin, s.id, paymentId, key, body)).created).toBe(true);
    expect((await allocateSupplierPayment(admin, s.id, paymentId, key, body)).created).toBe(false);
    await expectAppError(
      allocateSupplierPayment(admin, s.id, paymentId, KEY(), {
        allocations: [{ invoiceId: b.invoiceId, amountMinor: 501 }],
      }),
      409,
      "AMOUNT_EXCEEDS_UNALLOCATED",
    );
    expect(await docOf(s.id, a.invoiceId)).toMatchObject({ status: "PAID" });
    expect(await docOf(s.id, b.invoiceId)).toMatchObject({ openMinor: 1_000, status: "OPEN" });

    await voidSupplierInvoice(admin, s.id, a.invoiceId, { reason: "Duplicate" });
    const after = await listSupplierInvoices(admin, s.id);
    expect(after.unallocatedPayments.map((p) => p.unallocatedMinor)).toEqual([1_500]);
    await expectAppError(
      allocateSupplierPayment(admin, s.id, paymentId, KEY(), {
        allocations: [{ invoiceId: a.invoiceId, amountMinor: 1 }],
      }),
      409,
      "INVOICE_VOIDED",
    );
  });

  it("shows an unpaid invoice past its due date as overdue", async () => {
    const s = await supplier();
    const { invoiceId } = await invoice(s.id, {
      issuedOn: addDays(today, -40),
      dueOn: addDays(today, -10),
      netMinor: 1_000,
      vatMinor: 140,
    });
    expect(await docOf(s.id, invoiceId)).toMatchObject({ status: "OVERDUE", openMinor: 1_140 });
  });

  it("credits a return with a credit note that reduces an invoice", async () => {
    const s = await supplier();
    const { po, receiptId } = await received(s.id, 10, 1_000);
    const ret = await returnToSupplier(admin, po.id, KEY(), {
      reason: "DAMAGED",
      lines: [{ poItemId: po.lines[0].id, qty: 2 }],
    });
    const inv = await invoice(s.id, { netMinor: 10_000, vatMinor: 1_400, goodsReceiptIds: [receiptId] });
    expect((await listSupplierInvoices(admin, s.id)).uncreditedReturns.map((r) => r.id)).toEqual([ret.returnId]);
    const cn = await invoice(s.id, {
      kind: "CREDIT_NOTE",
      netMinor: 2_000,
      vatMinor: 280,
      purchaseReturnId: ret.returnId,
      appliesToInvoiceId: inv.invoiceId,
    });
    expect(await balance(s.id)).toBe(11_400 - 2_280);
    expect(await docOf(s.id, inv.invoiceId)).toMatchObject({ creditedMinor: 2_280, openMinor: 9_120 });
    expect((await listSupplierInvoices(admin, s.id)).uncreditedReturns).toEqual([]);
    await expectAppError(
      invoice(s.id, { kind: "CREDIT_NOTE", netMinor: 1, vatMinor: 0, purchaseReturnId: ret.returnId }),
      409,
      "RETURN_ALREADY_CREDITED",
    );
    await expectAppError(
      invoice(s.id, { kind: "CREDIT_NOTE", netMinor: 9_121, vatMinor: 0, appliesToInvoiceId: inv.invoiceId }),
      409,
      "AMOUNT_EXCEEDS_OPEN",
    );
    await voidSupplierInvoice(admin, s.id, cn.invoiceId, { reason: "Wrong" });
    // Without its credit note the return counts at cost again (I4, I7).
    expect(await balance(s.id)).toBe(11_400 - 2_000);
  });

  it("never edits or deletes a document, link or allocation; a void is set once", async () => {
    const s = await supplier();
    const { receiptId } = await received(s.id, 1, 100);
    const { invoiceId } = await invoice(s.id, { netMinor: 100, vatMinor: 14, goodsReceiptIds: [receiptId] });
    await pay(s.id, 114, { allocations: [{ invoiceId, amountMinor: 114 }] });
    await expect(
      db.supplierInvoice.update({ where: { id: invoiceId }, data: { vatMinor: 0, totalMinor: 100 } }),
    ).rejects.toThrow();
    await expect(db.supplierInvoice.delete({ where: { id: invoiceId } })).rejects.toThrow();
    await expect(db.supplierInvoiceReceipt.deleteMany({ where: { invoiceId } })).rejects.toThrow();
    await expect(
      db.supplierPaymentAllocation.updateMany({ where: { invoiceId }, data: { amountMinor: 1 } }),
    ).rejects.toThrow();
    await voidSupplierInvoice(admin, s.id, invoiceId, { reason: "Test" });
    await expect(
      db.supplierInvoice.update({ where: { id: invoiceId }, data: { voidReason: "Changed" } }),
    ).rejects.toThrow();
  });

  it("refuses a manager (403) and hides another org's supplier, receipt, invoice and payment (404)", async () => {
    const s = await supplier();
    const { receiptId } = await received(s.id, 1, 100);
    const { invoiceId } = await invoice(s.id, { netMinor: 100, vatMinor: 14 });
    const { paymentId } = await pay(s.id, 50);
    await expectAppError(listSupplierInvoices(manager, s.id), 403);
    await expectAppError(invoice(s.id, { netMinor: 1, vatMinor: 0 }, manager), 403);

    const other = await createTenant(db, "Supplier invoices other");
    const otherAdmin = await createMember(db, other.org.id, "ADMIN");
    const otherSupplier = await supplier(otherAdmin);
    await expectAppError(listSupplierInvoices(otherAdmin, s.id), 404);
    await expectAppError(invoice(s.id, { netMinor: 1, vatMinor: 0 }, otherAdmin), 404);
    await expectAppError(
      invoice(otherSupplier.id, { netMinor: 1, vatMinor: 0, goodsReceiptIds: [receiptId] }, otherAdmin),
      404,
    );
    await expectAppError(voidSupplierInvoice(otherAdmin, otherSupplier.id, invoiceId, { reason: "x" }), 404);
    await expectAppError(
      allocateSupplierPayment(otherAdmin, otherSupplier.id, paymentId, KEY(), {
        allocations: [{ invoiceId, amountMinor: 1 }],
      }),
      404,
    );
    const { invoiceId: theirs } = await invoice(otherSupplier.id, { netMinor: 10, vatMinor: 0 }, otherAdmin);
    await expectAppError(
      allocateSupplierPayment(admin, s.id, paymentId, KEY(), { allocations: [{ invoiceId: theirs, amountMinor: 1 }] }),
      404,
    );
    expect(await db.supplierInvoice.count({ where: { orgId: other.org.id, supplierId: s.id } })).toBe(0);
  });
});

describe("reports with invoices", () => {
  it("Supplier balances matches the statements; Input VAT sums by month next to output VAT", async () => {
    const own = await createTenant(db, "Input VAT report");
    const owner = await createMember(db, own.org.id, "OWNER");
    const cashier = await createMember(db, own.org.id, "CASHIER");
    const s = await supplier(owner);
    const { receiptId } = await received(s.id, 2, 5_000, owner, own); // 10,000 at cost
    const lastMonth = addDays(`${today.slice(0, 8)}01`, -1);
    await recordSupplierInvoice(owner, s.id, KEY(), {
      kind: "INVOICE",
      number: "M-1",
      issuedOn: lastMonth,
      netMinor: 3_000,
      vatMinor: 420,
    });
    await recordSupplierInvoice(owner, s.id, KEY(), {
      kind: "INVOICE",
      number: "M-2",
      issuedOn: today,
      netMinor: 10_000,
      vatMinor: 1_400,
      goodsReceiptIds: [receiptId],
    });
    await recordSupplierInvoice(owner, s.id, KEY(), {
      kind: "CREDIT_NOTE",
      number: "C-1",
      issuedOn: today,
      netMinor: 1_000,
      vatMinor: 140,
    });
    const voided = await recordSupplierInvoice(owner, s.id, KEY(), {
      kind: "INVOICE",
      number: "M-3",
      issuedOn: today,
      netMinor: 500,
      vatMinor: 70,
    });
    await voidSupplierInvoice(owner, s.id, voided.invoiceId, { reason: "Duplicate" });

    // One sale today: 114.00 including 14.00 VAT.
    const p = await createProduct(db, own.org.id);
    await db.product.update({ where: { id: p.id }, data: { priceMinor: 11_400 } });
    await inventory.recordOpeningBalances(owner, {
      branchId: own.branchA.id,
      lines: [{ ref: { productId: p.id, variantId: null }, qty: 5 }],
    });
    await openShift(cashier, { branchId: own.branchA.id, registerId: own.register.id, openingFloatMinor: 0 });
    await createSale(
      cashier,
      {
        branchId: own.branchA.id,
        registerId: own.register.id,
        lines: [{ ref: { productId: p.id, variantId: null }, qty: 1 }],
        payments: [{ method: "CASH", amountMinor: 11_400 }],
      },
      KEY(),
    );

    const from = `${lastMonth.slice(0, 8)}01`;
    const vat = await getReport(owner, "input-vat", { from, to: today });
    expect(vat.rows).toEqual([
      {
        month: lastMonth.slice(0, 7),
        invoicesCount: 1,
        invoiceNetMinor: 3_000,
        invoiceVatMinor: 420,
        creditNetMinor: 0,
        creditVatMinor: 0,
        inputVatMinor: 420,
        outputVatMinor: 0,
        netVatMinor: -420,
      },
      {
        month: today.slice(0, 7),
        invoicesCount: 1,
        invoiceNetMinor: 10_000,
        invoiceVatMinor: 1_400,
        creditNetMinor: 1_000,
        creditVatMinor: 140,
        inputVatMinor: 1_260,
        outputVatMinor: 1_400,
        netVatMinor: 140,
      },
    ]);
    expect(vat.totals).toMatchObject({ inputVatMinor: 1_680, outputVatMinor: 1_400, netVatMinor: -280 });
    const { body } = await exportReportCsv(owner, "input-vat", { from, to: today });
    expect(body).toContain(`${today.slice(0, 7)},1,100.00,14.00,10.00,1.40,12.60,14.00,1.40`);
    await expectAppError(getReport(manager, "input-vat", {}), 403);

    // Balance: last month 3,420 (opening); this month receipt 10,000, invoice +1,400 over the receipt,
    // credit note −1,140, voided invoice +570 then −570.
    const balances = await getReport(owner, "supplier-balances", { from: `${today.slice(0, 8)}01`, to: today });
    const row = balances.rows.find((r) => r.supplierId === s.id);
    expect(row).toMatchObject({
      openingMinor: 3_420,
      receivedMinor: 10_000,
      returnedMinor: 0,
      adjustedMinor: 1_400 - 1_140,
      paidMinor: 0,
      closingMinor: 13_680,
      uninvoicedMinor: 0,
    });
    const statement = await getSupplierStatement(owner, s.id, { from: `${today.slice(0, 8)}01`, to: today });
    expect([statement.openingMinor, statement.closingMinor]).toEqual([3_420, 13_680]);
  });
});
