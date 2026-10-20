import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { createCustomer, getCustomer, listCustomers, updateCustomer } from "@/modules/customers";
import * as inventory from "@/modules/inventory";
import { openShift } from "@/modules/registers";
import { exportReportCsv, getReport, todayIn } from "@/modules/reports";
import { createSale, getReceipt, refundSale, voidSale } from "@/modules/sales";
import { createMember, createProduct, createTenant, detailsOf, expectAppError, testDb } from "./helpers";

/** Customer records (docs/planning/customers/customers-spec.md): CRUD, isolation, sales, idempotency, history, report. */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let owner: TenantContext;
let manager: TenantContext;
let cashier: TenantContext;
let reporting: TenantContext;
let other: { owner: TenantContext; orgId: string };

const KEY = () => `cust-${randomUUID()}`;
// Unique Egyptian mobiles per run: 010 + 8 random digits.
const mobile = () => `010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Customers");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  manager = await createMember(db, orgId, "MANAGER");
  cashier = await createMember(db, orgId, "CASHIER");
  reporting = await createMember(db, orgId, "REPORTING");
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
  const otherTenant = await createTenant(db, "Customers Other");
  other = { owner: await createMember(db, otherTenant.org.id, "OWNER"), orgId: otherTenant.org.id };
});

afterAll(async () => {
  await db.$disconnect();
});

async function stocked(qty = 20) {
  const product = await createProduct(db, orgId);
  await inventory.recordOpeningBalances(owner, {
    branchId,
    lines: [{ ref: { productId: product.id, variantId: null }, qty }],
  });
  return product;
}

function saleBody(productId: string, qty: number, customerId?: string) {
  return {
    branchId,
    registerId,
    lines: [{ ref: { productId, variantId: null }, qty }],
    ...(customerId ? { customerId } : {}),
    payments: [{ method: "CASH" as const, amountMinor: qty * 1000 }],
  };
}

describe("customer records", () => {
  it("lets a cashier add a customer with the phone in E.164, audited, and finds them by local digits or name", async () => {
    const phone = mobile();
    const customer = await createCustomer(cashier, {
      name: "Mona Adel",
      phone: `${phone.slice(0, 4)} ${phone.slice(4)}`,
    });
    expect(customer).toMatchObject({ name: "Mona Adel", phone: `+2${phone}`, isActive: true, taxNumber: null });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "customer.created", entityId: customer.id },
    });
    expect(audit.metadata).toEqual({ name: "Mona Adel" });

    expect((await listCustomers(cashier, { q: phone.slice(0, 7) })).map((c) => c.id)).toContain(customer.id);
    expect((await listCustomers(cashier, { q: "mona ad" })).map((c) => c.id)).toContain(customer.id);
  });

  it("refuses a bad phone (422) and a phone already taken (409 with the existing id)", async () => {
    await expectAppError(createCustomer(owner, { name: "Bad", phone: "12345" }), 422, "INVALID_PHONE");
    const phone = mobile();
    const first = await createCustomer(owner, { name: "First", phone });
    const err = await expectAppError(
      createCustomer(owner, { name: "Second", phone: `+2${phone}` }),
      409,
      "PHONE_TAKEN",
    );
    expect(detailsOf(err).customerId).toBe(first.id);
    // The same phone in another shop is fine.
    await expect(createCustomer(other.owner, { name: "Elsewhere", phone })).resolves.toMatchObject({
      phone: `+2${phone}`,
    });
  });

  it("lets managers edit and archive (field names audited, no values); cashiers and reporting may not", async () => {
    const customer = await createCustomer(owner, { name: "Karim", phone: mobile() });
    await expectAppError(updateCustomer(cashier, customer.id, { name: "Hacked" }), 403);
    const denied = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "customers.permission.denied", actorUserId: cashier.userId },
    });
    expect(denied.metadata).toMatchObject({ permission: "customers.manage", operation: "customer.update" });
    await expectAppError(createCustomer(reporting, { name: "No", phone: mobile() }), 403);

    const edited = await updateCustomer(manager, customer.id, { taxNumber: "300-123-456", note: "B2B" });
    expect(edited).toMatchObject({ taxNumber: "300-123-456", note: "B2B" });
    const updated = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "customer.updated", entityId: customer.id },
    });
    expect(updated.metadata).toEqual({ fields: ["taxNumber", "note"] });

    await updateCustomer(manager, customer.id, { isActive: false });
    expect((await listCustomers(manager, { q: "Karim" })).map((c) => c.id)).not.toContain(customer.id);
    expect((await listCustomers(manager, { q: "Karim", includeArchived: "true" })).map((c) => c.id)).toContain(
      customer.id,
    );
    expect(await db.auditEvent.count({ where: { orgId, action: "customer.archived", entityId: customer.id } })).toBe(1);
  });

  it("keeps every tenant to its own customers", async () => {
    const mine = await createCustomer(owner, { name: "Private Person", phone: mobile() });
    await expectAppError(getCustomer(other.owner, mine.id), 404);
    await expectAppError(updateCustomer(other.owner, mine.id, { name: "Stolen" }), 404);
    expect((await listCustomers(other.owner, { q: "Private Person" })).map((c) => c.id)).not.toContain(mine.id);
    // Another shop's customer cannot go on this shop's sale.
    const theirs = await createCustomer(other.owner, { name: "Theirs", phone: mobile() });
    const product = await stocked();
    await expectAppError(createSale(cashier, saleBody(product.id, 1, theirs.id), KEY()), 404);
    // The database refuses it too (composite foreign key).
    const sale = await createSale(cashier, saleBody(product.id, 1), KEY());
    await expect(
      db.sale.update({ where: { id: sale.sale.id }, data: { customerId: theirs.id, customerName: "x" } }),
    ).rejects.toThrow();
  });
});

describe("a sale with a customer", () => {
  it("snapshots the customer on the sale and its receipts; refunds and voids keep it; history and report add up", async () => {
    const customer = await createCustomer(cashier, { name: "Hala Co.", phone: mobile() });
    await updateCustomer(owner, customer.id, { taxNumber: "310123456700003" });
    const product = await stocked();

    const { sale } = await createSale(cashier, saleBody(product.id, 3, customer.id), KEY());
    expect(sale.customer).toEqual({
      id: customer.id,
      name: "Hala Co.",
      phone: customer.phone,
      taxNumber: "310123456700003",
    });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { orgId, action: "sale.created", entityId: sale.id } });
    expect((audit.metadata as Record<string, unknown>).customerId).toBe(customer.id);

    // A later rename never changes the printed slip.
    await updateCustomer(owner, customer.id, { name: "Hala Trading" });
    const receipt = await getReceipt(cashier, sale.id, { kind: "SALE", copy: false });
    expect(receipt.customer).toEqual({ name: "Hala Co.", taxNumber: "310123456700003" });

    const item = await db.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
    const { refund } = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: item.id, qty: 1 }],
      method: "CASH",
      reason: "Damaged",
    });
    const refundSlip = await getReceipt(manager, sale.id, { kind: "REFUND", refundId: refund.id, copy: false });
    expect(refundSlip.customer).toEqual({ name: "Hala Co.", taxNumber: "310123456700003" });

    const voided = await createSale(cashier, saleBody(product.id, 1, customer.id), KEY());
    await voidSale(manager, voided.sale.id, { reason: "Mistake" });
    const voidSlip = await getReceipt(manager, voided.sale.id, { kind: "VOID", copy: false });
    // Sold after the rename, so it carries the new name.
    expect(voidSlip.customer?.name).toBe("Hala Trading");
    // A walk-in sale stays walk-in.
    const walkIn = await createSale(cashier, saleBody(product.id, 1), KEY());
    expect(walkIn.sale.customer).toBeNull();
    expect((await getReceipt(cashier, walkIn.sale.id, { kind: "SALE", copy: false })).customer).toBeNull();

    const detail = await getCustomer(cashier, customer.id);
    expect(detail.totals).toEqual({
      salesCount: 1,
      salesMinor: 3000,
      refundsCount: 1,
      refundsMinor: refund.totalMinor,
      netMinor: 3000 - refund.totalMinor,
    });
    expect(detail.sales.map((s) => [s.number, s.status])).toEqual([
      [voided.sale.number, "VOIDED"],
      [sale.number, "COMPLETED"],
    ]);
    expect(detail.refunds.map((r) => r.saleNumber)).toEqual([sale.number]);

    const day = todayIn("Africa/Cairo");
    const report = await getReport(owner, "customers", { from: day, to: day });
    const row = report.rows.find((r) => r.customerId === customer.id);
    expect(row).toEqual({
      customerId: customer.id,
      name: "Hala Trading",
      phone: customer.phone,
      salesCount: 1,
      grossMinor: 3000,
      refundsCount: 1,
      refundsMinor: refund.totalMinor,
      netMinor: 3000 - refund.totalMinor,
    });
    // Walk-in sales are not a row.
    expect(report.rows.every((r) => typeof r.customerId === "string")).toBe(true);
    const csv = await exportReportCsv(owner, "customers", { from: day, to: day });
    expect(csv.body).toContain("Hala Trading");
    expect(csv.body).toContain(`'${customer.phone}`);
    // The report needs customers.read on top of reports.view; a cashier has neither.
    await expectAppError(getReport(cashier, "customers", { from: day, to: day }), 403);
  });

  it("hashes the customer into the idempotency check", async () => {
    const a = await createCustomer(owner, { name: "A", phone: mobile() });
    const b = await createCustomer(owner, { name: "B", phone: mobile() });
    const product = await stocked();
    const key = KEY();
    const first = await createSale(cashier, saleBody(product.id, 1, a.id), key);
    const replay = await createSale(cashier, saleBody(product.id, 1, a.id), key);
    expect(replay).toMatchObject({ created: false, sale: { id: first.sale.id, customer: { id: a.id } } });
    await expectAppError(createSale(cashier, saleBody(product.id, 1, b.id), key), 409);
    await expectAppError(createSale(cashier, saleBody(product.id, 1), key), 409);
  });

  it("refuses an archived customer (409) but keeps their history readable", async () => {
    const customer = await createCustomer(owner, { name: "Gone", phone: mobile() });
    await updateCustomer(owner, customer.id, { isActive: false });
    const product = await stocked();
    await expectAppError(createSale(cashier, saleBody(product.id, 1, customer.id), KEY()), 409, "CUSTOMER_INACTIVE");
    // History of an archived customer stays readable.
    await expect(getCustomer(manager, customer.id)).resolves.toMatchObject({ isActive: false });
  });
});
