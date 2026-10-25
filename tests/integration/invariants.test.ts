import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { createPurchaseOrder, createSupplier, orderPurchaseOrder, receivePurchaseOrder } from "@/modules/purchasing";
import { addCashMovement, closeShift, getZReport, openShift, type ShiftCloseSummary } from "@/modules/registers";
import { getReport, type ReportRow } from "@/modules/reports";
import { createSale, refundSale, voidSale, type SaleDetail } from "@/modules/sales";
import { createMember, createProduct, createTenant, testDb, uniqueCode } from "./helpers";
import { backdate } from "./reports-fixture";

/**
 * Financial + inventory invariants (release checklist, Phase 14). One fully known day of trading
 * in a fresh shop, built through the real services, then every figure checked against numbers
 * worked out by hand. Run once for an EG shop (14% VAT) and once for an SA shop (15% VAT).
 *
 * Day D = 2026-04-15 (Cairo UTC+2, Riyadh UTC+3: every time below is the same local day).
 * Prices include VAT. Items (price EG / SA, cost):
 *   P1 114.00 / 115.00, cost 60.00, raised to 70.00 by the receipt
 *   P2  57.00 /  57.50, cost 30.00
 *   P3  20.00 zero-rated, no cost (unknown)
 *   P4  10.00, cost 5.00 (its VAT does not divide evenly: rounding cases)
 * Branch A, till T1, float 500.00:
 *   opening   A: P1 10, P2 20, P3 5, P4 10 · B: P2 5
 *   S1        P1×2 cash (tendered 300.00)                     cost snapshot 60.00
 *   receipt   PO: P1×6 @ 70.00 + P2×10 @ 30.00 = 720.00 → P1 cost 70.00
 *   S2        P1×1 + P2×2, card 100.00 + cash (tendered 200.00) cost snapshot 70.00
 *   S3        P3×1 + P4×3, wallet
 *   S4        P2×1 cash, voided
 *   S5        P2×1, card 20.00 + wallet rest
 *   R1        refund one P4 from S3, cash
 *   R2        refund the P1 from S2, card
 *   cash      pay-in 50.00, pay-out 20.00, drop 300.00
 *   adjust    A P3 −1 DAMAGED
 *   transfer  A → B P2×4
 *   close     counted 0.50 short
 */

const DAY = "2026-04-15";

type Country = {
  country: "EG" | "SA";
  vatRateBp: number;
  p1: number;
  p2: number;
  expect: {
    sales: Record<"s1" | "s2" | "s3" | "s5", Pick<SaleDetail, "totalMinor" | "vatMinor" | "changeMinor">>;
    refunds: { r1: { totalMinor: number; vatMinor: number }; r2: { totalMinor: number; vatMinor: number } };
    shift: Partial<ShiftCloseSummary> & Record<string, number>;
    summary: ReportRow;
    payments: ReportRow[];
    vat: { rows: ReportRow[]; totals: Record<string, number> };
    profit: { p1: ReportRow; p2: ReportRow; p3: ReportRow; p4: ReportRow; totals: Record<string, number> };
  };
};

const EG: Country = {
  country: "EG",
  vatRateBp: 1_400,
  p1: 11_400,
  p2: 5_700,
  expect: {
    sales: {
      // 2 × 114.00 = 228.00; VAT 228.00 − 228.00/1.14 = 28.00; change 300.00 − 228.00.
      s1: { totalMinor: 22_800, vatMinor: 2_800, changeMinor: 7_200 },
      // 114.00 + 2 × 57.00 = 228.00; VAT 14.00 + 14.00; cash due 128.00, change 200.00 − 128.00.
      s2: { totalMinor: 22_800, vatMinor: 2_800, changeMinor: 7_200 },
      // 20.00 (0%) + 3 × 10.00; VAT on 30.00 = 30.00 − round(26.3158) = 30.00 − 26.32 = 3.68.
      s3: { totalMinor: 5_000, vatMinor: 368, changeMinor: 0 },
      // 57.00; VAT 7.00.
      s5: { totalMinor: 5_700, vatMinor: 700, changeMinor: 0 },
    },
    refunds: {
      // One of three P4: 30.00 × 1/3 = 10.00; VAT round(3.68 / 3 = 1.2267) = 1.23.
      r1: { totalMinor: 1_000, vatMinor: 123 },
      // The whole P1 line of S2 (last refund takes the remainder): 114.00, VAT 14.00.
      r2: { totalMinor: 11_400, vatMinor: 1_400 },
    },
    shift: {
      // 500.00 float + cash sales (228.00 S1 + 128.00 S2; S4 voided) + 50.00 − 20.00 − 300.00 − 10.00 refund.
      openingFloatMinor: 50_000,
      cashSalesMinor: 35_600,
      payInMinor: 5_000,
      payOutMinor: 2_000,
      dropMinor: 30_000,
      cashRefundsMinor: 1_000,
      expectedCashMinor: 57_600,
      countedCashMinor: 57_550,
      discrepancyMinor: -50,
    },
    summary: {
      day: DAY,
      // S1 + S2 + S3 + S5 = 228.00 + 228.00 + 50.00 + 57.00 = 563.00; VAT 28.00 + 28.00 + 3.68 + 7.00 = 66.68.
      salesCount: 4,
      discountsMinor: 0,
      grossMinor: 56_300,
      vatMinor: 6_668,
      netMinor: 49_632,
      // R1 10.00 + R2 114.00.
      refundsCount: 2,
      refundsMinor: 12_400,
      voidsCount: 1,
      voidsMinor: 5_700,
      // 563.00 − 124.00.
      netAfterRefundsMinor: 43_900,
      serviceChargeMinor: 0,
    },
    payments: [
      // Cash 228.00 + 128.00 applied (change excluded); refund R1 10.00.
      { method: "CASH", salesCount: 2, salesMinor: 35_600, refundsCount: 1, refundsMinor: 1_000, netMinor: 34_600 },
      // Card 100.00 (S2) + 20.00 (S5); refund R2 114.00.
      {
        method: "CARD_MANUAL",
        salesCount: 2,
        salesMinor: 12_000,
        refundsCount: 1,
        refundsMinor: 11_400,
        netMinor: 600,
      },
      // Wallet 50.00 (S3) + 37.00 (S5).
      { method: "WALLET", salesCount: 2, salesMinor: 8_700, refundsCount: 0, refundsMinor: 0, netMinor: 8_700 },
    ],
    vat: {
      rows: [
        // 14%: lines 228.00 + 114.00 + 114.00 + 30.00 + 57.00 = 543.00, VAT 66.68 → net 476.32.
        // Refunds 10.00 + 114.00 = 124.00, VAT 1.23 + 14.00 = 15.23 → net 108.77. Net VAT 66.68 − 15.23.
        {
          rateBp: 1_400,
          netSalesMinor: 47_632,
          vatSalesMinor: 6_668,
          netRefundsMinor: 10_877,
          vatRefundsMinor: 1_523,
          netVatMinor: 5_145,
        },
        // 0%: P3 20.00.
        { rateBp: 0, netSalesMinor: 2_000, vatSalesMinor: 0, netRefundsMinor: 0, vatRefundsMinor: 0, netVatMinor: 0 },
      ],
      totals: {
        netSalesMinor: 49_632,
        vatSalesMinor: 6_668,
        netRefundsMinor: 10_877,
        vatRefundsMinor: 1_523,
        netVatMinor: 5_145,
      },
    },
    profit: {
      // S1 2 × (100.00 − 60.00) + S2 (100.00 − 70.00) − R2 (100.00 − 70.00) = 80.00 on 200.00 net → 40.00%.
      p1: {
        qtySold: 3,
        qtyRefunded: 1,
        netRevenueMinor: 20_000,
        costMinor: 12_000,
        grossProfitMinor: 8_000,
        marginBp: 4_000,
      },
      // S2 2 × (50.00 − 30.00) + S5 (50.00 − 30.00) = 60.00 on 150.00 → 40.00%.
      p2: {
        qtySold: 3,
        qtyRefunded: 0,
        netRevenueMinor: 15_000,
        costMinor: 9_000,
        grossProfitMinor: 6_000,
        marginBp: 4_000,
      },
      // No cost: 20.00 of revenue shown apart, no margin.
      p3: {
        qtySold: 1,
        netRevenueMinor: 2_000,
        revenueNoCostMinor: 2_000,
        costMinor: 0,
        grossProfitMinor: 0,
        marginBp: null,
      },
      // Net (30.00 − 3.68) − (10.00 − 1.23) = 26.32 − 8.77 = 17.55; cost 3 × 5.00 − 5.00 = 10.00;
      // profit 7.55; margin 755 / 1755 = 43.02%.
      p4: {
        qtySold: 3,
        qtyRefunded: 1,
        netRevenueMinor: 1_755,
        costMinor: 1_000,
        grossProfitMinor: 755,
        marginBp: 4_302,
      },
      // Net 200.00 + 150.00 + 20.00 + 17.55 = 387.55; cost 120.00 + 90.00 + 10.00 = 220.00;
      // profit 147.55 over 367.55 with cost = 40.14%.
      totals: {
        netRevenueMinor: 38_755,
        revenueNoCostMinor: 2_000,
        costMinor: 22_000,
        grossProfitMinor: 14_755,
        marginBp: 4_014,
      },
    },
  },
};

const SA: Country = {
  country: "SA",
  vatRateBp: 1_500,
  p1: 11_500,
  p2: 5_750,
  expect: {
    sales: {
      // 2 × 115.00 = 230.00; VAT 230.00 − 200.00 = 30.00; change 300.00 − 230.00.
      s1: { totalMinor: 23_000, vatMinor: 3_000, changeMinor: 7_000 },
      // 115.00 + 2 × 57.50 = 230.00; VAT 15.00 + 15.00; cash due 130.00, change 200.00 − 130.00.
      s2: { totalMinor: 23_000, vatMinor: 3_000, changeMinor: 7_000 },
      // 20.00 (0%) + 30.00; VAT 30.00 − round(26.0870) = 30.00 − 26.09 = 3.91.
      s3: { totalMinor: 5_000, vatMinor: 391, changeMinor: 0 },
      // 57.50; VAT 7.50.
      s5: { totalMinor: 5_750, vatMinor: 750, changeMinor: 0 },
    },
    refunds: {
      // 30.00 × 1/3 = 10.00; VAT round(3.91 / 3 = 1.3033) = 1.30.
      r1: { totalMinor: 1_000, vatMinor: 130 },
      r2: { totalMinor: 11_500, vatMinor: 1_500 },
    },
    shift: {
      // 500.00 + (230.00 + 130.00) + 50.00 − 20.00 − 300.00 − 10.00.
      openingFloatMinor: 50_000,
      cashSalesMinor: 36_000,
      payInMinor: 5_000,
      payOutMinor: 2_000,
      dropMinor: 30_000,
      cashRefundsMinor: 1_000,
      expectedCashMinor: 58_000,
      countedCashMinor: 57_950,
      discrepancyMinor: -50,
    },
    summary: {
      day: DAY,
      // 230.00 + 230.00 + 50.00 + 57.50 = 567.50; VAT 30.00 + 30.00 + 3.91 + 7.50 = 71.41.
      salesCount: 4,
      discountsMinor: 0,
      grossMinor: 56_750,
      vatMinor: 7_141,
      netMinor: 49_609,
      // 10.00 + 115.00.
      refundsCount: 2,
      refundsMinor: 12_500,
      voidsCount: 1,
      voidsMinor: 5_750,
      netAfterRefundsMinor: 44_250,
      serviceChargeMinor: 0,
    },
    payments: [
      { method: "CASH", salesCount: 2, salesMinor: 36_000, refundsCount: 1, refundsMinor: 1_000, netMinor: 35_000 },
      // 100.00 + 20.00 − 115.00.
      {
        method: "CARD_MANUAL",
        salesCount: 2,
        salesMinor: 12_000,
        refundsCount: 1,
        refundsMinor: 11_500,
        netMinor: 500,
      },
      // 50.00 + 37.50.
      { method: "WALLET", salesCount: 2, salesMinor: 8_750, refundsCount: 0, refundsMinor: 0, netMinor: 8_750 },
    ],
    vat: {
      rows: [
        // 15%: 230.00 + 115.00 + 115.00 + 30.00 + 57.50 = 547.50, VAT 71.41 → net 476.09.
        // Refunds 125.00, VAT 1.30 + 15.00 = 16.30 → net 108.70. Net VAT 71.41 − 16.30.
        {
          rateBp: 1_500,
          netSalesMinor: 47_609,
          vatSalesMinor: 7_141,
          netRefundsMinor: 10_870,
          vatRefundsMinor: 1_630,
          netVatMinor: 5_511,
        },
        { rateBp: 0, netSalesMinor: 2_000, vatSalesMinor: 0, netRefundsMinor: 0, vatRefundsMinor: 0, netVatMinor: 0 },
      ],
      totals: {
        netSalesMinor: 49_609,
        vatSalesMinor: 7_141,
        netRefundsMinor: 10_870,
        vatRefundsMinor: 1_630,
        netVatMinor: 5_511,
      },
    },
    profit: {
      p1: {
        qtySold: 3,
        qtyRefunded: 1,
        netRevenueMinor: 20_000,
        costMinor: 12_000,
        grossProfitMinor: 8_000,
        marginBp: 4_000,
      },
      p2: {
        qtySold: 3,
        qtyRefunded: 0,
        netRevenueMinor: 15_000,
        costMinor: 9_000,
        grossProfitMinor: 6_000,
        marginBp: 4_000,
      },
      p3: {
        qtySold: 1,
        netRevenueMinor: 2_000,
        revenueNoCostMinor: 2_000,
        costMinor: 0,
        grossProfitMinor: 0,
        marginBp: null,
      },
      // Net 26.09 − 8.70 = 17.39; cost 10.00; profit 7.39; margin 739 / 1739 = 42.50%.
      p4: {
        qtySold: 3,
        qtyRefunded: 1,
        netRevenueMinor: 1_739,
        costMinor: 1_000,
        grossProfitMinor: 739,
        marginBp: 4_250,
      },
      // Net 200.00 + 150.00 + 20.00 + 17.39 = 387.39; profit 147.39 over 367.39 = 40.12%.
      totals: {
        netRevenueMinor: 38_739,
        revenueNoCostMinor: 2_000,
        costMinor: 22_000,
        grossProfitMinor: 14_739,
        marginBp: 4_012,
      },
    },
  },
};

const key = () => `inv-${uniqueCode()}`;

/** Builds the day above in a fresh org and returns what the assertions need. */
async function trade(db: Db, cfg: Country) {
  const tenant = await createTenant(db, `Invariants ${cfg.country}`);
  const orgId = tenant.org.id;
  await db.organization.update({
    where: { id: orgId },
    data: { countryCode: cfg.country, currency: cfg.country === "SA" ? "SAR" : "EGP", vatRateBp: cfg.vatRateBp },
  });
  const a = tenant.branchA.id;
  const b = tenant.branchB.id;
  const owner = await createMember(db, orgId, "OWNER");
  const manager = await createMember(db, orgId, "MANAGER");
  const cashier = await createMember(db, orgId, "CASHIER");

  const item = async (priceMinor: number, costMinor: number, zeroRated = false) => {
    const p = await createProduct(db, orgId);
    await db.product.update({
      where: { id: p.id },
      data: { priceMinor, costMinor, ...(zeroRated ? { vatApplicable: false, vatCategory: "ZERO_RATED" } : {}) },
    });
    return { productId: p.id, variantId: null };
  };
  const p1 = await item(cfg.p1, 6_000);
  const p2 = await item(cfg.p2, 3_000);
  const p3 = await item(2_000, 0, true);
  const p4 = await item(1_000, 500);

  await inventory.recordOpeningBalances(owner, {
    branchId: a,
    lines: [
      { ref: p1, qty: 10 },
      { ref: p2, qty: 20 },
      { ref: p3, qty: 5 },
      { ref: p4, qty: 10 },
    ],
  });
  await inventory.recordOpeningBalances(owner, { branchId: b, lines: [{ ref: p2, qty: 5 }] });

  const registerId = tenant.register.id;
  const shift = await openShift(cashier, { branchId: a, registerId, openingFloatMinor: 50_000 });
  const sell = async (lines: { ref: typeof p1; qty: number }[], payments: unknown[]) =>
    (await createSale(cashier, { branchId: a, registerId, lines, payments }, key())).sale;

  const s1 = await sell([{ ref: p1, qty: 2 }], [{ method: "CASH", amountMinor: 30_000 }]);

  const supplier = await createSupplier(owner, { name: `Supplier ${uniqueCode()}` });
  const draft = await createPurchaseOrder(owner, {
    branchId: a,
    supplierId: supplier.id,
    lines: [
      { ref: { productId: p1.productId }, qty: 6, unitCostMinor: 7_000 },
      { ref: { productId: p2.productId }, qty: 10, unitCostMinor: 3_000 },
    ],
  });
  const po = await orderPurchaseOrder(owner, draft.id);
  const received = await receivePurchaseOrder(owner, po.id, key(), {
    lines: po.lines.map((line) => ({ poItemId: line.id, qty: line.qtyOrdered })),
  });

  const s2 = await sell(
    [
      { ref: p1, qty: 1 },
      { ref: p2, qty: 2 },
    ],
    [
      { method: "CARD_MANUAL", amountMinor: 10_000 },
      { method: "CASH", amountMinor: 20_000 },
    ],
  );
  const s3 = await sell(
    [
      { ref: p3, qty: 1 },
      { ref: p4, qty: 3 },
    ],
    [{ method: "WALLET", amountMinor: 5_000 }],
  );
  const s4 = await sell([{ ref: p2, qty: 1 }], [{ method: "CASH", amountMinor: 10_000 }]);
  await voidSale(manager, s4.id, { reason: "Wrong item" });
  const s5 = await sell(
    [{ ref: p2, qty: 1 }],
    [
      { method: "CARD_MANUAL", amountMinor: 2_000 },
      { method: "WALLET", amountMinor: cfg.p2 - 2_000 },
    ],
  );

  const lineOf = async (saleId: string, productId: string) =>
    (await db.saleItem.findFirstOrThrow({ where: { saleId, productId } })).id;
  const r1 = await refundSale(manager, s3.id, key(), {
    lines: [{ saleItemId: await lineOf(s3.id, p4.productId), qty: 1 }],
    method: "CASH",
    reason: "Damaged",
  });
  const r2 = await refundSale(manager, s2.id, key(), {
    lines: [{ saleItemId: await lineOf(s2.id, p1.productId), qty: 1 }],
    method: "CARD_MANUAL",
    reason: "Changed mind",
  });

  await addCashMovement(cashier, shift.id, { type: "PAY_IN", amountMinor: 5_000, reason: "Change float" });
  await addCashMovement(cashier, shift.id, { type: "PAY_OUT", amountMinor: 2_000, reason: "Cleaning" });
  await addCashMovement(cashier, shift.id, { type: "DROP", amountMinor: 30_000, reason: "Safe" });

  // A P3 at this point: 5 opening − 1 sold (S3) = 4.
  await inventory.adjustStock(owner, {
    branchId: a,
    ref: p3,
    adjustmentReason: "DAMAGED",
    qtyDelta: -1,
    expectedOnHand: 4,
  });
  await inventory.transferStock(owner, {
    transferId: randomUUID(),
    fromBranchId: a,
    toBranchId: b,
    lines: [{ ref: p2, qty: 4 }],
  });

  const closed = await closeShift(cashier, shift.id, {
    countedCashMinor: cfg.expect.shift.countedCashMinor,
    discrepancyNote: "Short 0.50",
  });

  await backdate(db, [
    ["RegisterShift", shift.id, "openedAt", "2026-04-15T07:00:00Z"],
    ["RegisterShift", shift.id, "closedAt", "2026-04-15T15:00:00Z"],
    ["Sale", s1.id, "createdAt", "2026-04-15T08:00:00Z"],
    ["GoodsReceipt", received.receiptId, "receivedAt", "2026-04-15T08:30:00Z"],
    ["Sale", s2.id, "createdAt", "2026-04-15T09:00:00Z"],
    ["Sale", s3.id, "createdAt", "2026-04-15T09:30:00Z"],
    ["Sale", s4.id, "createdAt", "2026-04-15T10:00:00Z"],
    ["Sale", s4.id, "voidedAt", "2026-04-15T10:05:00Z"],
    ["Sale", s5.id, "createdAt", "2026-04-15T10:30:00Z"],
    ["Refund", r1.refund.id, "createdAt", "2026-04-15T11:00:00Z"],
    ["Refund", r2.refund.id, "createdAt", "2026-04-15T11:10:00Z"],
  ]);

  return {
    orgId,
    a,
    b,
    owner,
    items: { p1, p2, p3, p4 },
    sales: { s1, s2, s3, s5 },
    refunds: { r1: r1.refund, r2: r2.refund },
    shift: closed,
    supplierId: supplier.id,
  };
}

let db: Db;

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
});

describe.each([EG, SA])("invariants, $country shop", (cfg) => {
  let t: Awaited<ReturnType<typeof trade>>;
  let owner: TenantContext;
  const run = (report: string) => getReport(owner, report, { branchId: t.a, from: DAY, to: DAY });
  const row = (rows: ReportRow[], keyName: string, value: unknown) => {
    const found = rows.find((r) => r[keyName] === value);
    if (!found) throw new Error(`no row with ${keyName}=${String(value)}`);
    return found;
  };

  beforeAll(async () => {
    t = await trade(db, cfg);
    owner = t.owner;
  }, 60_000);

  it("prices each sale and refund to the hand-computed totals", () => {
    for (const name of ["s1", "s2", "s3", "s5"] as const) {
      expect(t.sales[name], name).toMatchObject(cfg.expect.sales[name]);
    }
    expect(t.refunds.r1).toMatchObject(cfg.expect.refunds.r1);
    expect(t.refunds.r2).toMatchObject(cfg.expect.refunds.r2);
  });

  it("keeps every stock balance equal to its ledger, with the expected on-hand", async () => {
    expect(await inventory.reconcile(db, t.orgId)).toEqual([]);
    const { p1, p2, p3, p4 } = t.items;
    const refs = [p1, p2, p3, p4];
    // A: P1 10 + 6 received − 2 (S1) − 1 (S2) + 1 (R2) = 14
    //    P2 20 + 10 received − 2 (S2) − 1 (S4) + 1 (void) − 1 (S5) − 4 transferred = 23
    //    P3 5 − 1 (S3) − 1 damaged = 3
    //    P4 10 − 3 (S3) + 1 (R1) = 8
    expect(await inventory.getOnHand(db, t.orgId, t.a, refs)).toEqual([14, 23, 3, 8]);
    // B: P2 5 + 4 transferred = 9; nothing else ever stocked there.
    expect(await inventory.getOnHand(db, t.orgId, t.b, refs)).toEqual([0, 9, 0, 0]);
  });

  it("closes the shift at the hand-computed expected cash and difference", async () => {
    const { shift } = cfg.expect;
    expect(t.shift).toMatchObject({
      expectedCashMinor: shift.expectedCashMinor,
      countedCashMinor: shift.countedCashMinor,
      discrepancyMinor: shift.discrepancyMinor,
    });
    // The Z-report and the Shifts report show the same close and the terms behind it.
    expect(await getZReport(owner, t.shift.id)).toMatchObject(shift);
    const { rows } = await run("shifts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(shift);
  });

  it("reports sales, refunds and voids for the day", async () => {
    const { rows } = await run("sales-summary");
    expect(rows).toEqual([cfg.expect.summary]);
  });

  it("reports payments by method, adding up to gross sales", async () => {
    const { rows, totals } = await run("payments");
    expect(rows).toEqual(cfg.expect.payments);
    expect(totals.salesMinor).toBe(cfg.expect.summary.grossMinor);
    expect(totals.refundsMinor).toBe(cfg.expect.summary.refundsMinor);
  });

  it("reports VAT by rate, matching the summary's VAT and net", async () => {
    const { rows, totals } = await run("vat");
    expect(rows).toEqual(cfg.expect.vat.rows);
    expect(totals).toEqual(cfg.expect.vat.totals);
    expect(totals.vatSalesMinor).toBe(cfg.expect.summary.vatMinor);
    expect(totals.netSalesMinor).toBe(cfg.expect.summary.netMinor);
  });

  it("snapshots cost at checkout and reports profit from it", async () => {
    const lines = await db.saleItem.findMany({
      where: { orgId: t.orgId, saleId: { in: [t.sales.s1.id, t.sales.s2.id] }, productId: t.items.p1.productId },
      select: { saleId: true, unitCostMinor: true },
    });
    // S1 sold before the receipt at 60.00, S2 after it at 70.00.
    expect(lines.find((l) => l.saleId === t.sales.s1.id)?.unitCostMinor).toBe(6_000);
    expect(lines.find((l) => l.saleId === t.sales.s2.id)?.unitCostMinor).toBe(7_000);

    const { rows, totals } = await run("profit-products");
    const { p1, p2, p3, p4 } = cfg.expect.profit;
    expect(row(rows, "productId", t.items.p1.productId)).toMatchObject(p1);
    expect(row(rows, "productId", t.items.p2.productId)).toMatchObject(p2);
    expect(row(rows, "productId", t.items.p3.productId)).toMatchObject(p3);
    expect(row(rows, "productId", t.items.p4.productId)).toMatchObject(p4);
    expect(totals).toMatchObject(cfg.expect.profit.totals);
    // Profit's net revenue is the VAT report's net sales less net refunds.
    const { vat } = cfg.expect;
    expect(totals.netRevenueMinor).toBe(vat.totals.netSalesMinor - vat.totals.netRefundsMinor);
    expect((await run("profit-days")).totals).toMatchObject(totals);
    expect((await run("profit-categories")).totals).toEqual(totals);
  });

  it("reports the goods received at their cost", async () => {
    const { rows } = await run("purchases");
    // P1 6 × 70.00 + P2 10 × 30.00 = 720.00 over 16 units.
    expect(rows).toEqual([
      expect.objectContaining({ day: DAY, supplierId: t.supplierId, receiptsCount: 1, units: 16, valueMinor: 72_000 }),
    ]);
  });
});
