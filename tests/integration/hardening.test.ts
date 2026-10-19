import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db";
import type { Role } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getAuth } from "@/lib/auth/auth";
import { RATE_LIMITS, windowStartOf } from "@/lib/rate-limit";
import * as receiptRoute from "@/app/api/sales/[saleId]/receipt/route";
import * as settingsRoute from "@/app/api/org/receipt/route";
import * as inventory from "@/modules/inventory";
import { getReceiptSettings, updateReceiptSettings } from "@/modules/org";
import { closeShift, getZReport, openShift } from "@/modules/registers";
import { createSale, getReceipt, refundSale, voidSale } from "@/modules/sales";
import {
  createMember,
  createProduct,
  createTenant,
  expectAppError,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/** T10 hardening: printable receipts and reprints, receipt settings, Z-report, and the API rate limit. */

const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let owner: TenantContext;
let manager: TenantContext;
let cashier: TenantContext;
let cashier2: TenantContext;
let outsider: TenantContext;

const KEY = () => `key-${uniqueCode()}`;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Hardening");
  other = await createTenant(db, "Hardening Other");
  owner = await createMember(db, tenant.org.id, "OWNER");
  manager = await createMember(db, tenant.org.id, "MANAGER");
  cashier = await createMember(db, tenant.org.id, "CASHIER");
  cashier2 = await createMember(db, tenant.org.id, "CASHIER");
  outsider = await createMember(db, other.org.id, "OWNER");
});

afterAll(async () => {
  await expectReconciled(db, tenant.org.id);
  await db.$disconnect();
});

async function openTill() {
  const register = await db.register.create({
    data: { orgId: tenant.org.id, branchId: tenant.branchA.id, name: `Till ${uniqueCode()}` },
  });
  const shift = await openShift(cashier, {
    branchId: tenant.branchA.id,
    registerId: register.id,
    openingFloatMinor: 500,
  });
  return { registerId: register.id, shiftId: shift.id };
}

async function stocked(qty: number) {
  const product = await createProduct(db, tenant.org.id);
  await db.product.update({ where: { id: product.id }, data: { nameAr: "شاي" } });
  await inventory.recordOpeningBalances(owner, {
    branchId: tenant.branchA.id,
    lines: [{ ref: { productId: product.id, variantId: null }, qty }],
  });
  return product;
}

async function sell(registerId: string, productId: string, qty: number, tenderedMinor: number) {
  const { sale } = await createSale(
    cashier,
    {
      branchId: tenant.branchA.id,
      registerId,
      lines: [{ ref: { productId, variantId: null }, qty }],
      payments: [{ method: "CASH", amountMinor: tenderedMinor }],
    },
    KEY(),
  );
  return sale;
}

const reprints = (saleId: string) =>
  db.auditEvent.count({ where: { orgId: tenant.org.id, action: "sale.receipt.reprinted", entityId: saleId } });

describe("receipt settings (H3)", () => {
  it("lets the owner set the six fields, audits the change and prints them", async () => {
    const saved = await updateReceiptSettings(owner, {
      legalName: "Hardening Trading LLC",
      taxNumber: "300-111-222",
      receiptAddress: "1 Nile St, Cairo",
      receiptPhone: "+20 2 1234 5678",
      receiptHeader: "Welcome",
      receiptFooter: "Thank you",
    });
    expect(saved).toMatchObject({ legalName: "Hardening Trading LLC", taxNumber: "300-111-222" });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId: tenant.org.id, action: "settings.receipt.updated" },
    });
    expect(event.metadata).toMatchObject({ taxNumber: { from: null, to: "300-111-222" } });
    expect(await getReceiptSettings(owner)).toMatchObject({ receiptFooter: "Thank you" });
  });

  it("clears a field with an empty string and writes no audit for an unchanged save", async () => {
    await updateReceiptSettings(owner, { receiptHeader: "" });
    expect((await getReceiptSettings(owner)).receiptHeader).toBeNull();
    const before = await db.auditEvent.count({ where: { orgId: tenant.org.id, action: "settings.receipt.updated" } });
    await updateReceiptSettings(owner, { receiptFooter: "Thank you" });
    expect(await db.auditEvent.count({ where: { orgId: tenant.org.id, action: "settings.receipt.updated" } })).toBe(
      before,
    );
  });

  it("refuses managers and cashiers with 403 and audits the attempt", async () => {
    await expectAppError(updateReceiptSettings(manager, { receiptFooter: "x" }), 403);
    await expectAppError(getReceiptSettings(cashier), 403);
    expect(
      await db.auditEvent.count({ where: { orgId: tenant.org.id, action: "settings.permission.denied" } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it("rejects unknown fields and overlong values (ZodError, 422 at the route)", async () => {
    await expect(updateReceiptSettings(owner, { name: "Other" })).rejects.toBeInstanceOf(ZodError);
    await expect(updateReceiptSettings(owner, { taxNumber: "x".repeat(41) })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("receipts (H2, H4)", () => {
  it("builds the sale receipt from the stored sale and the shop fields", async () => {
    const { registerId } = await openTill();
    const product = await stocked(5);
    const sale = await sell(registerId, product.id, 2, 2500);
    const doc = await getReceipt(cashier, sale.id, { kind: "SALE", copy: false });
    expect(doc).toMatchObject({
      kind: "SALE",
      copy: false,
      saleNumber: sale.number,
      currency: "EGP",
      timeZone: "Africa/Cairo",
      shop: {
        name: "Hardening Trading LLC",
        branchName: "Main",
        taxNumber: "300-111-222",
        address: "1 Nile St, Cairo",
        footer: "Thank you",
      },
      subtotalMinor: sale.subtotalMinor,
      vatMinor: sale.vatMinor,
      totalMinor: 2000,
      vatRatesBp: [1400],
      payments: [{ method: "CASH", amountMinor: 2000 }],
      changeMinor: 500,
    });
    expect(doc.lines).toEqual([{ name: product.name, nameAr: "شاي", qty: 2, discountMinor: 0, lineTotalMinor: 2000 }]);
    expect(doc.staffName).toMatch(/^CASHIER/);
    // An original print is not audited.
    expect(await reprints(sale.id)).toBe(0);
  });

  it("marks a reprint as a copy and audits it once per reprint", async () => {
    const { registerId } = await openTill();
    const product = await stocked(5);
    const sale = await sell(registerId, product.id, 1, 1000);
    const doc = await getReceipt(manager, sale.id, { kind: "SALE", copy: true });
    expect(doc.copy).toBe(true);
    await getReceipt(cashier, sale.id, { kind: "SALE", copy: true });
    expect(await reprints(sale.id)).toBe(2);
  });

  it("prints a refund with its own lines, amount, reason and the staff who refunded", async () => {
    const { registerId } = await openTill();
    const product = await stocked(5);
    const sale = await sell(registerId, product.id, 2, 2000);
    const [item] = await db.saleItem.findMany({ where: { saleId: sale.id } });
    const { refund } = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: item.id, qty: 1 }],
      method: "CASH",
      reason: "Damaged",
    });
    const doc = await getReceipt(manager, sale.id, { kind: "REFUND", refundId: refund.id, copy: false });
    expect(doc).toMatchObject({
      kind: "REFUND",
      reason: "Damaged",
      totalMinor: 1000,
      vatMinor: refund.vatMinor,
      subtotalMinor: 1000 - refund.vatMinor,
      payments: [{ method: "CASH", amountMinor: 1000 }],
      changeMinor: 0,
      lines: [{ qty: 1, lineTotalMinor: 1000 }],
    });
    expect(doc.staffName).toMatch(/^MANAGER/);
    await expectAppError(getReceipt(manager, sale.id, { kind: "REFUND", refundId: randomUUID(), copy: false }), 404);
  });

  it("prints a void slip only for a voided sale", async () => {
    const { registerId } = await openTill();
    const product = await stocked(5);
    const sale = await sell(registerId, product.id, 1, 1000);
    await expectAppError(getReceipt(manager, sale.id, { kind: "VOID", copy: false }), 404);
    await voidSale(manager, sale.id, { reason: "Wrong item" });
    const doc = await getReceipt(manager, sale.id, { kind: "VOID", copy: false });
    expect(doc).toMatchObject({ kind: "VOID", reason: "Wrong item", totalMinor: 1000, changeMinor: 0 });
    expect(doc.staffName).toMatch(/^MANAGER/);
  });

  it("lets only the selling cashier or refund and void holders read it; other tenants get 404", async () => {
    const { registerId } = await openTill();
    const product = await stocked(5);
    const sale = await sell(registerId, product.id, 1, 1000);
    await expectAppError(getReceipt(cashier2, sale.id, { kind: "SALE", copy: true }), 403);
    await expectAppError(getReceipt(outsider, sale.id, { kind: "SALE", copy: true }), 404);
    await expectAppError(getReceipt(cashier, "not-a-uuid", { kind: "SALE", copy: false }), 404);
    expect(await reprints(sale.id)).toBe(0);
  });
});

describe("Z-report (H9)", () => {
  it("returns the stored close and the cash terms behind it, only once closed", async () => {
    const { registerId, shiftId } = await openTill();
    const product = await stocked(5);
    await sell(registerId, product.id, 1, 1000);
    await expectAppError(getZReport(cashier, shiftId), 404);
    await closeShift(cashier, shiftId, { countedCashMinor: 1400, discrepancyNote: "Short 100" });
    const report = await getZReport(cashier, shiftId);
    expect(report).toMatchObject({
      openingFloatMinor: 500,
      cashSalesMinor: 1000,
      expectedCashMinor: 1500,
      countedCashMinor: 1400,
      discrepancyMinor: -100,
      discrepancyNote: "Short 100",
      currency: "EGP",
      timeZone: "Africa/Cairo",
    });
    expect(report.openedBy).toMatch(/^CASHIER/);
    await expectAppError(getZReport(outsider, shiftId), 404);
  });
});

// ---------- routes: receipt, settings, rate limit ----------

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function randomIp() {
  const n = () => Math.floor(Math.random() * 250);
  return `10.${n()}.${n()}.${n()}`;
}

async function sessionFor(orgId: string, role: Role) {
  const email = `hardening-${role.toLowerCase()}-${randomUUID()}@example.test`;
  const response = await getAuth().handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": randomIp() },
      body: JSON.stringify({ email, password: PASSWORD, name: role }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed: ${response.status}`);
  const { user } = (await response.json()) as { user: { id: string } };
  const token = response.headers.getSetCookie().find((c) => c.includes("session_token="));
  if (!token) throw new Error("no session cookie returned");
  await db.membership.create({ data: { orgId, userId: user.id, role, allBranches: true } });
  await db.session.updateMany({ where: { userId: user.id }, data: { activeOrganizationId: orgId } });
  return { cookie: token.split(";")[0] ?? "", userId: user.id };
}

function request(path: string, method: string, cookie: string, body?: unknown) {
  return new Request(`${BASE}/api${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const noParams = { params: Promise.resolve({}) };

/** The current rate window, after waiting out its last 5 s so a test never straddles a rollover. */
async function steadyWindow(): Promise<Date> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
  return windowStartOf(new Date());
}

/** Puts `userId` one write short of the limit in the current window. */
async function nearLimit(userId: string): Promise<void> {
  await db.apiRateLimit.create({
    data: { key: `${tenant.org.id}:${userId}:write`, windowStart: await steadyWindow(), count: RATE_LIMITS.write - 1 },
  });
}

describe("routes", () => {
  it("GET /api/sales/{id}/receipt answers the receipt and audits copy=1", async () => {
    const { cookie } = await sessionFor(tenant.org.id, "MANAGER");
    const { registerId } = await openTill();
    const product = await stocked(5);
    const sale = await sell(registerId, product.id, 1, 1000);
    const handler = receiptRoute.GET as Handler;
    const ok = await handler(request(`/sales/${sale.id}/receipt?copy=1`, "GET", cookie), {
      params: Promise.resolve({ saleId: sale.id }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toMatchObject({ kind: "SALE", copy: true, saleNumber: sale.number });
    expect(await reprints(sale.id)).toBe(1);
    const bad = await handler(request(`/sales/${sale.id}/receipt?kind=OTHER`, "GET", cookie), {
      params: Promise.resolve({ saleId: sale.id }),
    });
    expect(bad.status).toBe(422);
  });

  it("PATCH /api/org/receipt saves for an admin and refuses a cashier", async () => {
    const admin = await sessionFor(tenant.org.id, "ADMIN");
    const till = await sessionFor(tenant.org.id, "CASHIER");
    const patch = settingsRoute.PATCH as Handler;
    const saved = await patch(request("/org/receipt", "PATCH", admin.cookie, { receiptPhone: "+20 100" }), noParams);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ receiptPhone: "+20 100" });
    const refused = await patch(request("/org/receipt", "PATCH", till.cookie, { receiptPhone: "x" }), noParams);
    expect(refused.status).toBe(403);
  });

  it("answers 429 with Retry-After past the write limit, audits once, keeps reads open, and resets next window", async () => {
    const admin = await sessionFor(tenant.org.id, "ADMIN");
    const patch = settingsRoute.PATCH as Handler;
    const get = settingsRoute.GET as Handler;
    await nearLimit(admin.userId);
    // The limit-th write passes, the next one is refused.
    expect((await patch(request("/org/receipt", "PATCH", admin.cookie, {}), noParams)).status).toBe(200);
    const limited = await patch(request("/org/receipt", "PATCH", admin.cookie, {}), noParams);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect((await patch(request("/org/receipt", "PATCH", admin.cookie, {}), noParams)).status).toBe(429);
    expect(
      await db.auditEvent.count({
        where: { orgId: tenant.org.id, actorUserId: admin.userId, action: "api.rate_limited" },
      }),
    ).toBe(1);

    // Reads are a separate bucket.
    expect((await get(request("/org/receipt", "GET", admin.cookie), noParams)).status).toBe(200);

    // The next window starts from zero.
    await db.apiRateLimit.updateMany({
      where: { key: `${tenant.org.id}:${admin.userId}:write` },
      data: { windowStart: new Date(Date.now() - 120_000) },
    });
    expect((await patch(request("/org/receipt", "PATCH", admin.cookie, {}), noParams)).status).toBe(200);
  }, 20_000);

  it("a late request from an older window counts in the current one instead of resetting it", async () => {
    const admin = await sessionFor(tenant.org.id, "ADMIN");
    // The stored window is already ahead of this request (another instance moved on first) and full.
    await db.apiRateLimit.create({
      data: {
        key: `${tenant.org.id}:${admin.userId}:write`,
        windowStart: new Date(windowStartOf(new Date()).getTime() + 60_000),
        count: RATE_LIMITS.write,
      },
    });
    const patch = settingsRoute.PATCH as Handler;
    expect((await patch(request("/org/receipt", "PATCH", admin.cookie, {}), noParams)).status).toBe(429);
  });

  it("counts per user: another admin is not limited by the first", { timeout: 20_000 }, async () => {
    const first = await sessionFor(tenant.org.id, "ADMIN");
    const second = await sessionFor(tenant.org.id, "ADMIN");
    await nearLimit(first.userId);
    const patch = settingsRoute.PATCH as Handler;
    expect((await patch(request("/org/receipt", "PATCH", first.cookie, {}), noParams)).status).toBe(200);
    expect((await patch(request("/org/receipt", "PATCH", first.cookie, {}), noParams)).status).toBe(429);
    expect((await patch(request("/org/receipt", "PATCH", second.cookie, {}), noParams)).status).toBe(200);
  });
});
