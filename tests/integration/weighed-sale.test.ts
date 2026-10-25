import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { enrolOfflineDevice, updateOfflineSettings } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { exportReportCsv, getReport, todayIn } from "@/modules/reports";
import { createSale, getTillSnapshot, refundSale, voidSale } from "@/modules/sales";
import { buildOfflineSale, searchSnapshot } from "@/app/(app)/pos/_lib/offline";
import type { CartLine } from "@/app/(app)/pos/_lib/till";
import { createMember, createProduct, createTenant, expectReconciled, testDb } from "./helpers";

/**
 * Weighed selling (weighed-selling-spec W1–W3, W8, W10). Tomatoes at EGP 120.00 per kg (VAT included, 14%), cost
 * 80.00 per kg; quantities in grams. Sale 1: 750 g with a 5.00 line discount plus two pieces, and 10% off the sale:
 *   shelf 90.00 + 20.00; after line discount 85.00 + 20.00; sale discount 10.50 split 8.50 / 2.00;
 *   lines 76.50 (VAT 9.39) and 18.00 (VAT 2.21); total 94.50.
 * Refund of 250 g: 76.50 × 250 / 750 = 25.50 (VAT 3.13). Sale 2 (1 kg) is voided.
 */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let owner: TenantContext;
let cashier: TenantContext;
let tomatoes: string;
let pens: string;

const KEY = () => `kg-${crypto.randomUUID()}`;
const ref = (productId: string) => ({ productId, variantId: null });
const onHand = async (productId: string) =>
  (await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId, variantId: null } })).qty;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Weighed");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  tomatoes = (await createProduct(db, orgId, "KG-TOMATO")).id;
  await db.product.update({
    where: { id: tomatoes },
    data: { unitType: "KG", name: "Tomatoes", priceMinor: 12_000, costMinor: 8_000 },
  });
  pens = (await createProduct(db, orgId, "KG-PEN")).id;
  await inventory.recordOpeningBalances(owner, {
    branchId,
    lines: [
      { ref: ref(tomatoes), qty: 10_000 },
      { ref: ref(pens), qty: 10 },
    ],
  });
  // The test discounts 14% in all; let the cashier give that (discounts-spec DC8).
  await db.organization.update({ where: { id: orgId }, data: { maxCashierDiscountBp: 2_000 } });
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("a weighed sale", () => {
  it("prices grams per kg with discounts and VAT, moves stock in grams, refunds part of the weight", async () => {
    const { sale } = await createSale(
      cashier,
      {
        branchId,
        registerId,
        lines: [
          { ref: ref(tomatoes), qty: 750, discount: { kind: "AMOUNT", amountMinor: 500 } },
          { ref: ref(pens), qty: 2 },
        ],
        discount: { kind: "PERCENT", percentBp: 1000 },
        payments: [{ method: "CASH", amountMinor: 9_450 }],
      },
      KEY(),
    );
    expect(sale).toMatchObject({ totalMinor: 9_450, vatMinor: 1_160, discountMinor: 1_550 });
    const line = await db.saleItem.findFirstOrThrow({ where: { orgId, saleId: sale.id, productId: tomatoes } });
    expect(line).toMatchObject({
      unitType: "KG",
      qty: 750,
      unitPriceMinor: 12_000,
      lineTotalMinor: 7_650,
      vatMinor: 939,
    });
    expect(await onHand(tomatoes)).toBe(9_250);

    const { refund } = await refundSale(owner, sale.id, KEY(), {
      lines: [{ saleItemId: line.id, qty: 250 }],
      method: "CASH",
      reason: "Bruised",
    });
    expect(refund).toMatchObject({ totalMinor: 2_550, vatMinor: 313 });
    expect(await onHand(tomatoes)).toBe(9_500);
  });

  it("voids a weighed sale back to stock and leaves it out of profit", async () => {
    const { sale } = await createSale(
      cashier,
      {
        branchId,
        registerId,
        lines: [{ ref: ref(tomatoes), qty: 1_000 }],
        payments: [{ method: "CASH", amountMinor: 12_000 }],
      },
      KEY(),
    );
    expect(sale.totalMinor).toBe(12_000);
    expect(await onHand(tomatoes)).toBe(8_500);
    await voidSale(owner, sale.id, { reason: "Wrong item" });
    expect(await onHand(tomatoes)).toBe(9_500);
  });

  it("costs grams per kg in the profit report", async () => {
    const today = todayIn("Africa/Cairo");
    const { rows } = await getReport(owner, "profit-products", { branchId, from: today, to: today });
    // 750 g at 80.00/kg = 60.00, less the 250 g refunded = 20.00 → 40.00.
    expect(rows.find((row) => row.productId === tomatoes)).toMatchObject({
      qtySold: 750,
      qtyRefunded: 250,
      costMinor: 4_000,
    });
  });
});

describe("a weighed item in reports", () => {
  it("shows kg in the products CSV and leaves pieces and grams out of one total", async () => {
    const today = todayIn("Africa/Cairo");
    const report = await getReport(owner, "products", { branchId, from: today, to: today });
    expect(report.rows.find((row) => row.productId === tomatoes)).toMatchObject({ unitType: "KG", qtySold: 750 });
    expect(report.totals).not.toHaveProperty("qtySold");
    const { body } = await exportReportCsv(owner, "products", { branchId, from: today, to: today });
    expect(body).toContain("0.750 kg");
    // Tomatoes and pens share "no category": grams and pieces in one row are MIXED, shown "—" and not totalled.
    const byCategory = await getReport(owner, "categories", { branchId, from: today, to: today });
    expect(byCategory.rows).toMatchObject([{ categoryId: null, unitType: "MIXED" }]);
    expect(byCategory.totals).not.toHaveProperty("qtySold");
    const byDay = await getReport(owner, "profit-days", { branchId, from: today, to: today });
    expect(byDay.rows[0]).toMatchObject({ unitType: "MIXED" });
  });
});

describe("a weighed sale built offline", () => {
  it("prices the same on the device and on replay", async () => {
    await updateOfflineSettings(owner, { allowOfflineSales: true });
    const enrolled = await enrolOfflineDevice(owner, registerId);
    const snap = await getTillSnapshot(cashier, branchId, registerId, null);
    const [found] = searchSnapshot(snap.items, "KG-TOMATO");
    expect(found.unitType).toBe("KG");
    const cart: CartLine[] = [{ ...found, qty: 1_250 }];
    const body = {
      branchId,
      registerId,
      lines: [{ ref: ref(tomatoes), qty: 1_250 }],
      payments: [{ method: "CASH" as const, amountMinor: 20_000 }],
    };
    const built = buildOfflineSale({
      body,
      cart,
      saleDiscount: null,
      plan: { payments: body.payments, changeMinor: 0 },
      snapshot: snap,
      device: enrolled,
      seq: enrolled.lastOfflineSaleNo + 1,
      soldAt: new Date(),
    });
    expect(built.receipt.totalMinor).toBe(15_000);
    const { sale } = await createSale(cashier, built.body, KEY());
    expect(sale.totalMinor).toBe(15_000);
    const row = await db.sale.findUniqueOrThrow({ where: { id: sale.id }, select: { offlineFlags: true } });
    expect(row.offlineFlags).toEqual([]);
  });
});

describe("a sale from price scale labels (W6)", () => {
  it("charges the printed totals, merges two labels of one item and refuses a label below the price", async () => {
    // 437 g at 120.00/kg is 52.44; the scale printed 52.40. 250 g is exactly 30.00.
    const { sale } = await createSale(
      cashier,
      {
        branchId,
        registerId,
        lines: [
          { ref: ref(tomatoes), qty: 437, labels: [{ grams: 437, totalMinor: 5_240 }] },
          { ref: ref(tomatoes), qty: 250, labels: [{ grams: 250, totalMinor: 3_000 }] },
        ],
        payments: [{ method: "CASH", amountMinor: 8_240 }],
      },
      KEY(),
    );
    expect(sale.totalMinor).toBe(8_240);
    const line = await db.saleItem.findFirstOrThrow({ where: { orgId, saleId: sale.id } });
    expect(line).toMatchObject({ qty: 687, lineTotalMinor: 8_240 });

    const refused = createSale(
      cashier,
      {
        branchId,
        registerId,
        lines: [{ ref: ref(tomatoes), qty: 437, labels: [{ grams: 437, totalMinor: 5_230 }] }],
        payments: [{ method: "CASH", amountMinor: 5_230 }],
      },
      KEY(),
    );
    await expect(refused).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "LABEL_MISMATCH" } });
  });
});
