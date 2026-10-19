import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { applyReceivedCosts } from "@/modules/catalog";
import * as inventory from "@/modules/inventory";
import { openShift } from "@/modules/registers";
import { canRunReport, exportReportCsv, getReport, REPORT_NAMES, type ReportRow } from "@/modules/reports";
import { createSale, getReceipt, refundSale, voidSale } from "@/modules/sales";
import {
  createCategory,
  createMember,
  createProduct,
  createTenant,
  createVariant,
  expectAppError,
  testDb,
} from "./helpers";
import { backdate, createScopedMember } from "./reports-fixture";

/**
 * Profit and margin (profit-margin-spec.md §7). One known history in Cairo (UTC+2 in March):
 *   Day D (2026-03-10):
 *     A  P1×2 at cost 60.00 (price 114.00 incl. 14% VAT → net 100.00 each)
 *     — receipt sets P1's cost to 70.00 —
 *     B  P1×1 at cost 70.00
 *     C  P2×1, cost never entered (0 → unknown)
 *     D  V1 (inherits P3's cost 10.00) + V2 (own cost 15.00), 22.80 each → net 20.00
 *     E  P1×1, voided
 *     F  P2×1 at 23:30 Cairo (still day D)
 *   Day D+1: refund of one P1 from sale A (reverses 60.00 of cost).
 */

const DAY = "2026-03-10";
const DAY1 = "2026-03-11";

let db: Db;
let owner: TenantContext;
let admin: TenantContext;
let orgId: string;
let branchId: string;
let ids: { p1: string; p2: string; p3: string; v1: string; v2: string; categoryId: string };
let saleA: string;

const key = () => `profit-${crypto.randomUUID()}`;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Profit");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  owner = await createMember(db, orgId, "OWNER");
  admin = await createMember(db, orgId, "ADMIN");
  const cashier = await createMember(db, orgId, "CASHIER");
  const manager = await createMember(db, orgId, "MANAGER");

  const category = await createCategory(db, orgId, "Snacks");
  const p1 = await createProduct(db, orgId);
  await db.product.update({
    where: { id: p1.id },
    data: { priceMinor: 11_400, costMinor: 6_000, categoryId: category.id },
  });
  const p2 = await createProduct(db, orgId);
  await db.product.update({ where: { id: p2.id }, data: { priceMinor: 5_000, costMinor: 0 } });
  const p3 = await createProduct(db, orgId);
  await db.product.update({ where: { id: p3.id }, data: { priceMinor: 2_280, costMinor: 1_000 } });
  const v1 = await createVariant(db, orgId, p3.id);
  const v2 = await createVariant(db, orgId, p3.id);
  await db.productVariant.update({ where: { id: v2.id }, data: { costMinor: 1_500 } });
  ids = { p1: p1.id, p2: p2.id, p3: p3.id, v1: v1.id, v2: v2.id, categoryId: category.id };

  const ref = (productId: string, variantId: string | null = null) => ({ productId, variantId });
  await inventory.recordOpeningBalances(owner, {
    branchId,
    lines: [
      { ref: ref(p1.id), qty: 20 },
      { ref: ref(p2.id), qty: 20 },
      { ref: ref(p3.id, v1.id), qty: 20 },
      { ref: ref(p3.id, v2.id), qty: 20 },
    ],
  });
  const registerId = tenant.register.id;
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
  const sell = async (lines: { ref: ReturnType<typeof ref>; qty: number }[], amountMinor: number) =>
    (await createSale(cashier, { branchId, registerId, lines, payments: [{ method: "CASH", amountMinor }] }, key()))
      .sale;

  const a = await sell([{ ref: ref(p1.id), qty: 2 }], 22_800);
  saleA = a.id;
  // The receiving seam (purchasing P2) moves P1's last cost; sale A keeps its own.
  await db.$transaction((tx) =>
    applyReceivedCosts(tx, owner, {
      receiptId: crypto.randomUUID(),
      lines: [{ ref: ref(p1.id), unitCostMinor: 7_000 }],
    }),
  );
  const b = await sell([{ ref: ref(p1.id), qty: 1 }], 11_400);
  const c = await sell([{ ref: ref(p2.id), qty: 1 }], 5_000);
  const d = await sell(
    [
      { ref: ref(p3.id, v1.id), qty: 1 },
      { ref: ref(p3.id, v2.id), qty: 1 },
    ],
    4_560,
  );
  const e = await sell([{ ref: ref(p1.id), qty: 1 }], 11_400);
  await voidSale(manager, e.id, { reason: "Mistake" });
  const f = await sell([{ ref: ref(p2.id), qty: 1 }], 5_000);
  const lineA = await db.saleItem.findFirstOrThrow({ where: { saleId: a.id } });
  const refund = await refundSale(manager, a.id, key(), {
    lines: [{ saleItemId: lineA.id, qty: 1 }],
    method: "CASH",
    reason: "Damaged",
  });

  await backdate(db, [
    ["Sale", a.id, "createdAt", "2026-03-10T08:00:00Z"],
    ["Sale", b.id, "createdAt", "2026-03-10T09:00:00Z"],
    ["Sale", c.id, "createdAt", "2026-03-10T10:00:00Z"],
    ["Sale", d.id, "createdAt", "2026-03-10T11:00:00Z"],
    ["Sale", e.id, "createdAt", "2026-03-10T12:00:00Z"],
    ["Sale", e.id, "voidedAt", "2026-03-10T12:05:00Z"],
    ["Sale", f.id, "createdAt", "2026-03-10T21:30:00Z"],
    ["Refund", refund.refund.id, "createdAt", "2026-03-11T08:00:00Z"],
  ]);
}, 60_000);

afterAll(async () => {
  await db.$disconnect();
});

const run = (report: string, from = DAY, to = from, ctx = owner) => getReport(ctx, report, { branchId, from, to });

const row = (rows: ReportRow[], keyName: string, value: unknown) => {
  const found = rows.find((r) => r[keyName] === value);
  if (!found) throw new Error(`no row with ${keyName}=${String(value)}`);
  return found;
};

describe("cost snapshot at checkout (M1, M2)", () => {
  it("stores each line's cost at the moment of sale, 0 as unknown, variants inheriting", async () => {
    const lines = await db.saleItem.findMany({
      where: { orgId },
      select: { variantId: true, productId: true, unitCostMinor: true, saleId: true },
    });
    expect(lines.find((l) => l.saleId === saleA)?.unitCostMinor).toBe(6_000);
    const p1Costs = lines.filter((l) => l.productId === ids.p1).map((l) => l.unitCostMinor);
    expect(p1Costs.sort()).toEqual([6_000, 7_000, 7_000]);
    expect(lines.filter((l) => l.productId === ids.p2).map((l) => l.unitCostMinor)).toEqual([null, null]);
    expect(lines.find((l) => l.variantId === ids.v1)?.unitCostMinor).toBe(1_000);
    expect(lines.find((l) => l.variantId === ids.v2)?.unitCostMinor).toBe(1_500);
  });

  it("never returns cost from the sale, receipt or refund payloads (M10)", async () => {
    const receipt = await getReceipt(owner, saleA, { kind: "SALE", copy: true });
    expect(JSON.stringify(receipt)).not.toMatch(/cost/i);
    const { registerId } = await db.sale.findFirstOrThrow({ where: { id: saleA } });
    const created = await createSale(
      owner,
      {
        branchId,
        registerId,
        lines: [{ ref: { productId: ids.p1, variantId: null }, qty: 1 }],
        payments: [{ method: "CASH", amountMinor: 11_400 }],
      },
      key(),
    );
    expect(JSON.stringify(created)).not.toMatch(/cost/i);
  });

  it("keeps SaleItem append-only with the new column", async () => {
    await expect(
      db.$executeRaw`UPDATE "SaleItem" SET "unitCostMinor" = 1 WHERE "saleId" = ${saleA}::uuid`,
    ).rejects.toThrow();
  });
});

describe("profit by product", () => {
  it("uses each sale's own cost and leaves voided sales out (M1, M4, M5)", async () => {
    const { rows, totals } = await run("profit-products");
    const p1 = row(rows, "productId", ids.p1);
    // A 2×(100.00 − 60.00) + B (100.00 − 70.00); E voided.
    expect(p1).toMatchObject({
      qtySold: 3,
      qtyRefunded: 0,
      netRevenueMinor: 30_000,
      revenueNoCostMinor: 0,
      costMinor: 19_000,
      grossProfitMinor: 11_000,
      marginBp: 3_667,
    });
    const p2 = row(rows, "productId", ids.p2);
    expect(p2).toMatchObject({ qtySold: 2, costMinor: 0, grossProfitMinor: 0, marginBp: null });
    expect(p2.revenueNoCostMinor).toBe(p2.netRevenueMinor);
    const v1 = row(rows, "variantId", ids.v1);
    expect(v1).toMatchObject({ netRevenueMinor: 2_000, costMinor: 1_000, grossProfitMinor: 1_000, marginBp: 5_000 });
    expect(row(rows, "variantId", ids.v2)).toMatchObject({ costMinor: 1_500, grossProfitMinor: 500, marginBp: 2_500 });
    // Margin of the totals is recomputed, not summed: 12 500 profit over 34 000 revenue with cost.
    expect(totals).toMatchObject({ costMinor: 21_500, grossProfitMinor: 12_500, marginBp: 3_676 });
    expect(rows[0].productId).toBe(ids.p1); // highest profit first
  });

  it("reverses the refunded quantity's cost on the refund's day (M3)", async () => {
    const both = await run("profit-products", DAY, DAY1);
    expect(row(both.rows, "productId", ids.p1)).toMatchObject({
      qtySold: 3,
      qtyRefunded: 1,
      netRevenueMinor: 20_000,
      costMinor: 13_000,
      grossProfitMinor: 7_000,
      marginBp: 3_500,
    });
    const refundDay = await run("profit-days", DAY1);
    expect(refundDay.rows).toEqual([
      expect.objectContaining({
        day: DAY1,
        netRevenueMinor: -10_000,
        costMinor: -6_000,
        grossProfitMinor: -4_000,
        marginBp: null,
      }),
    ]);
  });
});

describe("profit by category and by day", () => {
  it("groups by the product's current category; totals match profit by product", async () => {
    const [byCategory, byProduct] = await Promise.all([run("profit-categories"), run("profit-products")]);
    expect(row(byCategory.rows, "categoryId", ids.categoryId)).toMatchObject({ grossProfitMinor: 11_000 });
    expect(row(byCategory.rows, "categoryId", null)).toMatchObject({ grossProfitMinor: 1_500 });
    expect(byCategory.totals).toEqual(byProduct.totals);
  });

  it("counts a sale at 23:30 Cairo on its local day, with lines without cost", async () => {
    const { rows } = await run("profit-days", DAY, DAY1);
    expect(rows.map((r) => r.day)).toEqual([DAY, DAY1]);
    expect(rows[0]).toMatchObject({ linesNoCost: 2, grossProfitMinor: 12_500 });
  });
});

describe("reconciliation (acceptance #3)", () => {
  it("net revenue equals the VAT report's net sales less net refunds", async () => {
    const [profit, vat] = await Promise.all([run("profit-days", DAY, DAY1), run("vat", DAY, DAY1)]);
    expect(profit.totals.netRevenueMinor).toBe(vat.totals.netSalesMinor - vat.totals.netRefundsMinor);
  });
});

describe("access (M7)", () => {
  it("lets Owner and Admin run the profit reports, nobody else", async () => {
    const profit = REPORT_NAMES.filter((name) => name.startsWith("profit-"));
    expect(profit).toHaveLength(3);
    for (const report of profit) {
      expect((await run(report, DAY, DAY, admin)).rows.length).toBeGreaterThan(0);
      for (const role of ["MANAGER", "REPORTING", "CASHIER"] as const) {
        const member = await createScopedMember(db, orgId, role, [branchId]);
        expect(canRunReport(member, report)).toBe(false);
        await expectAppError(run(report, DAY, DAY, member), 403);
      }
    }
  });
});

describe("CSV", () => {
  it("exports Arabic headers, margin to one decimal and the recomputed total", async () => {
    const { body, filename } = await exportReportCsv(owner, "profit-products", {
      branchId,
      from: DAY,
      to: DAY,
      locale: "ar",
    });
    expect(filename).toBe(`profit-products_${DAY}_${DAY}.csv`);
    expect(body).toContain("إجمالي الربح");
    expect(body).toContain("هامش الربح");
    expect(body).toContain("36.7%");
    const lines = body.trim().split(/\r?\n/);
    expect(lines.at(-1)).toContain("36.8%");
  });
});
