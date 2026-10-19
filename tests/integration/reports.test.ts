import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db";
import { canRunReport, getReport, REPORT_NAMES, type ReportRow } from "@/modules/reports";
import { previewShiftCash } from "@/modules/registers";
import { createTenant, createMember, createProduct, expectAppError, testDb } from "./helpers";
import {
  backdate,
  createScopedMember,
  DAY,
  DAY1,
  DAY2,
  seedReportsFixture,
  type ReportsFixture,
} from "./reports-fixture";
import * as inventory from "@/modules/inventory";
import { createSale } from "@/modules/sales";
import { openShift } from "@/modules/registers";

/**
 * The eight reports against one known history (reports-fixture.ts): every number traced to the
 * receipts, refunds and the shift close (acceptance #1), local days (R1) and branch scope.
 */

let db: Db;
let f: ReportsFixture;

beforeAll(async () => {
  db = testDb();
  f = await seedReportsFixture(db);
});

afterAll(async () => {
  await db.$disconnect();
});

const dayA = (report: string, from = DAY, to = from) => getReport(f.owner, report, { branchId: f.branchA, from, to });

const find = (rows: ReportRow[], key: string, value: unknown) => {
  const row = rows.find((r) => r[key] === value);
  if (!row) throw new Error(`no row with ${key}=${String(value)}`);
  return row;
};

describe("sales summary", () => {
  it("matches the day's receipts, refunds and voids", async () => {
    const report = await dayA("sales-summary");
    expect(report.timezone).toBe("Africa/Cairo");
    expect(report.rows).toHaveLength(1);
    const completed = await db.sale.findMany({
      where: { id: { in: [f.sales.s1.id, f.sales.s2.id, f.sales.s3.id, f.sales.s4.id] } },
    });
    const vat = completed.reduce((acc, s) => acc + s.vatMinor, 0);
    expect(report.rows[0]).toEqual({
      day: DAY,
      salesCount: 4,
      discountsMinor: 0,
      grossMinor: 42_480,
      vatMinor: vat,
      netMinor: 42_480 - vat,
      refundsCount: 1,
      refundsMinor: 11_400,
      voidsCount: 1,
      voidsMinor: 5_000,
      netAfterRefundsMinor: 31_080,
    });
    expect(report.totals.grossMinor).toBe(42_480);
  });

  it("puts a refund on its own day and splits days at local midnight (R1)", async () => {
    const report = await dayA("sales-summary", DAY, DAY2);
    expect(report.rows.map((r) => r.day)).toEqual([DAY, DAY1, DAY2]);
    expect(find(report.rows, "day", DAY1)).toMatchObject({ salesCount: 1, grossMinor: 5_000, refundsMinor: 2_280 });
    expect(find(report.rows, "day", DAY2)).toMatchObject({ salesCount: 1, grossMinor: 5_000, refundsMinor: 0 });
    expect(report.totals).toMatchObject({ salesCount: 6, grossMinor: 52_480, refundsMinor: 13_680 });
  });
});

describe("payments", () => {
  it("sums applied amounts per method, never the change", async () => {
    const { rows } = await dayA("payments");
    expect(rows).toEqual([
      { method: "CASH", salesCount: 2, salesMinor: 29_200, refundsCount: 1, refundsMinor: 11_400, netMinor: 17_800 },
      { method: "CARD_MANUAL", salesCount: 2, salesMinor: 11_000, refundsCount: 0, refundsMinor: 0, netMinor: 11_000 },
      { method: "WALLET", salesCount: 1, salesMinor: 2_280, refundsCount: 0, refundsMinor: 0, netMinor: 2_280 },
    ]);
  });
});

describe("products and categories", () => {
  it("lists products top first, refunds deducted, voids excluded", async () => {
    const { rows } = await dayA("products");
    expect(rows[0]).toMatchObject({
      productId: f.products.p1.id,
      qtySold: 3,
      qtyRefunded: 1,
      grossMinor: 34_200,
      refundsMinor: 11_400,
      netMinor: 22_800,
    });
    expect(find(rows, "productId", f.products.p2.id)).toMatchObject({ qtySold: 1, grossMinor: 5_000 });
    const variant = find(rows, "variantId", f.products.v3.id);
    expect(variant).toMatchObject({ sku: f.products.v3.sku, qtySold: 1, grossMinor: 2_280 });
    expect(String(variant.name)).toContain(" — ");
  });

  it("shows a refund of an earlier sale on the refund day", async () => {
    const { rows } = await dayA("products", DAY1);
    expect(find(rows, "variantId", f.products.v3.id)).toMatchObject({
      qtySold: 0,
      qtyRefunded: 1,
      refundsMinor: 2_280,
      netMinor: -2_280,
    });
  });

  it("groups by current category, uncategorized as one row", async () => {
    const { rows, totals } = await dayA("categories");
    expect(rows).toEqual([
      expect.objectContaining({ categoryId: f.category.id, name: "Drinks", netMinor: 22_800 }),
      expect.objectContaining({ categoryId: null, qtySold: 3, grossMinor: 8_280, netMinor: 8_280 }),
    ]);
    expect(totals.netMinor).toBe(31_080);
  });
});

describe("VAT", () => {
  it("splits by rate and nets refunds, matching line VAT", async () => {
    const { rows, totals } = await dayA("vat");
    const lines = await db.saleItem.findMany({
      where: { saleId: { in: [f.sales.s1.id, f.sales.s2.id, f.sales.s3.id, f.sales.s4.id] } },
    });
    const lineVat = lines.reduce((acc, l) => acc + l.vatMinor, 0);
    expect(rows.map((r) => r.rateBp)).toEqual([1400, 0]);
    expect(find(rows, "rateBp", 0)).toEqual({
      rateBp: 0,
      netSalesMinor: 1_000,
      vatSalesMinor: 0,
      netRefundsMinor: 0,
      vatRefundsMinor: 0,
      netVatMinor: 0,
    });
    expect(totals.vatSalesMinor).toBe(lineVat);
    expect(totals.vatRefundsMinor).toBe(1_400);
    expect(totals.netVatMinor).toBe(lineVat - 1_400);
    const summary = await dayA("sales-summary");
    expect(summary.totals.vatMinor).toBe(totals.vatSalesMinor);
  });
});

describe("cashiers", () => {
  it("counts sales by cashier and refunds by who processed them", async () => {
    const { rows } = await dayA("cashiers");
    expect(find(rows, "userId", f.cashier.userId)).toMatchObject({
      salesCount: 4,
      grossMinor: 42_480,
      averageMinor: 10_620,
      refundsCount: 0,
    });
    expect(find(rows, "userId", f.manager.userId)).toMatchObject({
      salesCount: 0,
      refundsCount: 1,
      refundsMinor: 11_400,
    });
  });
});

describe("shifts", () => {
  it("reproduces the stored close of a closed shift", async () => {
    const { rows } = await dayA("shifts");
    expect(rows).toHaveLength(1);
    const row = find(rows, "shiftId", f.shift1.id);
    expect(row).toMatchObject({
      shiftId: f.shift1.id,
      status: "CLOSED",
      openingFloatMinor: 10_000,
      cashSalesMinor: 29_200,
      payInMinor: 2_000,
      payOutMinor: 1_500,
      dropMinor: 5_000,
      cashRefundsMinor: 11_400,
      expectedCashMinor: f.shift1.expectedCashMinor,
      countedCashMinor: 23_200,
      discrepancyMinor: -100,
      discrepancyNote: "Short",
    });
    const formula = 10_000 + 29_200 + 2_000 - 1_500 - 5_000 - 11_400;
    expect(f.shift1.expectedCashMinor).toBe(formula);
  });

  it("shows an open shift's live expected cash, as the till's preview", async () => {
    const { rows } = await dayA("shifts", DAY1);
    const row = find(rows, "shiftId", f.shift2.id);
    const preview = await previewShiftCash(f.cashier, f.shift2.id);
    expect(row).toMatchObject({
      status: "OPEN",
      cashSalesMinor: preview.cashSalesMinor,
      expectedCashMinor: preview.expectedCashMinor,
      countedCashMinor: null,
      discrepancyMinor: null,
    });
  });
});

describe("refunds and voids", () => {
  it("lists each refund and void, newest first", async () => {
    const { rows } = await dayA("refunds-voids");
    expect(rows.map((r) => [r.kind, r.saleNumber, r.totalMinor])).toEqual([
      ["REFUND", f.sales.s1.number, 11_400],
      ["VOID", f.sales.s5.number, 5_000],
    ]);
    expect(rows[1]).toMatchObject({ method: null, reason: "Wrong item" });
    const next = await dayA("refunds-voids", DAY1);
    expect(next.rows[0]).toMatchObject({ kind: "REFUND", method: "WALLET", reference: "W-77", registerName: "Till 1" });
  });
});

describe("scope", () => {
  it("never shows a branch-limited manager another branch's numbers (R5)", async () => {
    const scoped = await createScopedMember(db, f.orgId, "MANAGER", [f.branchA]);
    // Purchases and profit need a second grant, so a manager is refused before any branch check (T5 P5, P12 M7).
    for (const report of REPORT_NAMES.filter((name) => canRunReport(scoped, name))) {
      await expectAppError(getReport(scoped, report, { branchId: f.branchB, from: DAY, to: DAY }), 404);
    }
    const mine = await getReport(scoped, "sales-summary", { from: DAY, to: DAY });
    expect(mine.rows[0]).toMatchObject({ salesCount: 4, grossMinor: 42_480 });
    const shifts = await getReport(scoped, "shifts", { from: DAY, to: DAY });
    expect(shifts.rows.map((r) => r.shiftId)).toEqual([f.shift1.id]);
  });

  it("covers all branches in scope when no branch is given, never another org", async () => {
    const all = await getReport(f.owner, "sales-summary", { from: DAY, to: DAY });
    expect(all.rows[0]).toMatchObject({ salesCount: 5, grossMinor: 42_480 + 11_400 });
    const b = await getReport(f.owner, "sales-summary", { branchId: f.branchB, from: DAY, to: DAY });
    expect(b.rows[0]).toMatchObject({ salesCount: 1, grossMinor: 11_400 });
  });

  it("refuses roles without reports.view and bad input", async () => {
    await expectAppError(getReport(f.cashier, "sales-summary", {}), 403);
    const denied = await db.auditEvent.findFirst({
      where: { orgId: f.orgId, actorUserId: f.cashier.userId, action: "reports.permission.denied" },
    });
    expect(denied).not.toBeNull();
    await expectAppError(getReport(f.owner, "profit", {}), 404);
    await expectAppError(getReport(f.owner, "vat", { from: "2026-03-10", to: "2026-03-01" }), 422, "RANGE_INVERTED");
    await expectAppError(getReport(f.owner, "vat", { from: "2025-01-01", to: "2026-03-01" }), 422, "RANGE_TOO_LONG");
    await expectAppError(getReport(f.owner, "vat", { branchId: f.otherOrgId }), 404);
    await expect(getReport(f.owner, "vat", { extra: "1" })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("Riyadh day boundary (R1)", () => {
  it("splits days at midnight Riyadh time", async () => {
    const t = await createTenant(db, "Riyadh");
    await db.organization.update({
      where: { id: t.org.id },
      data: { countryCode: "SA", currency: "SAR", vatRateBp: 1500 },
    });
    const owner = await createMember(db, t.org.id, "OWNER");
    const product = await createProduct(db, t.org.id);
    const ref = { productId: product.id, variantId: null };
    await inventory.recordOpeningBalances(owner, { branchId: t.branchA.id, lines: [{ ref, qty: 5 }] });
    await openShift(owner, { branchId: t.branchA.id, registerId: t.register.id, openingFloatMinor: 0 });
    const sell = async (createdAt: string) => {
      const { sale } = await createSale(
        owner,
        {
          branchId: t.branchA.id,
          registerId: t.register.id,
          lines: [{ ref, qty: 1 }],
          payments: [{ method: "CASH", amountMinor: 1_000 }],
        },
        `riyadh-${createdAt}`,
      );
      await backdate(db, [["Sale", sale.id, "createdAt", createdAt]]);
    };
    await sell("2026-03-10T20:59:00Z"); // 23:59 Riyadh, the 10th
    await sell("2026-03-10T21:00:00Z"); // 00:00 Riyadh, the 11th
    const report = await getReport(owner, "sales-summary", { from: DAY, to: DAY1 });
    expect(report.timezone).toBe("Asia/Riyadh");
    expect(report.currency).toBe("SAR");
    expect(report.rows.map((r) => [r.day, r.salesCount])).toEqual([
      [DAY, 1],
      [DAY1, 1],
    ]);
  });
});
