import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { updateReceiptSettings } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { salesSummary } from "@/modules/reports/queries";
import { createSale, getReceipt, refundSale, type SaleDetail } from "@/modules/sales";
import {
  createMember,
  createProduct,
  createTenant,
  detailsOf,
  expectAppError,
  expectReconciled,
  testDb,
} from "./helpers";

/** Discounts at the till (docs/planning/discounts/discounts-spec.md): totals, limits, audit, refunds, idempotency. */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let owner: TenantContext;
let manager: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Discounts");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  manager = await createMember(db, orgId, "MANAGER");
  cashier = await createMember(db, orgId, "CASHIER");
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterEach(async () => {
  // Back to the default 10% limit.
  await db.organization.update({ where: { id: orgId }, data: { maxCashierDiscountBp: 1000 } });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

type Discount = { kind: "PERCENT"; percentBp: number } | { kind: "AMOUNT"; amountMinor: number };

const KEY = () => `disc-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const PERCENT = (percentBp: number): Discount => ({ kind: "PERCENT", percentBp });
const AMOUNT = (amountMinor: number): Discount => ({ kind: "AMOUNT", amountMinor });

async function stocked(qty: number, priceMinor: number) {
  const product = await createProduct(db, orgId);
  await db.product.update({ where: { id: product.id }, data: { priceMinor } });
  await inventory.recordOpeningBalances(owner, {
    branchId,
    lines: [{ ref: { productId: product.id, variantId: null }, qty }],
  });
  return product;
}

function body(
  lines: { productId: string; qty: number; discount?: Discount }[],
  paidMinor: number,
  discount?: Discount,
) {
  return {
    branchId,
    registerId,
    lines: lines.map(({ productId, qty, discount: lineDiscount }) => ({
      ref: { productId, variantId: null },
      qty,
      ...(lineDiscount ? { discount: lineDiscount } : {}),
    })),
    ...(discount ? { discount } : {}),
    payments: paidMinor > 0 ? [{ method: "CASH" as const, amountMinor: paidMinor }] : [],
  };
}

const lineOf = (sale: SaleDetail, productId: string) => sale.lines.find((l) => l.productId === productId);
const onHand = async (productId: string) =>
  (await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId, variantId: null } })).qty;

describe("a discounted sale", () => {
  it("prices line and sale discounts on the server, allocates the sale discount, and audits the detail", async () => {
    const a = await stocked(10, 1000);
    const b = await stocked(10, 1000);
    // a: 2 × 10.00 − 10% = 18.00; b: 10.00. Sale −2.80 split 1800:1000 → 1.80 / 1.00.
    const { sale } = await createSale(
      manager,
      body(
        [
          { productId: a.id, qty: 2, discount: PERCENT(1000) },
          { productId: b.id, qty: 1 },
        ],
        3000,
        AMOUNT(280),
      ),
      KEY(),
    );
    // VAT 14% inside the discounted gross: a 1620 → net 1421, VAT 199; b 900 → net 789, VAT 111.
    expect(lineOf(sale, a.id)).toMatchObject({ discountMinor: 380, lineTotalMinor: 1620, vatMinor: 199 });
    expect(lineOf(sale, b.id)).toMatchObject({ discountMinor: 100, lineTotalMinor: 900, vatMinor: 111 });
    expect(sale).toMatchObject({
      discountMinor: 480,
      subtotalMinor: 2210,
      vatMinor: 310,
      totalMinor: 2520,
      changeMinor: 480,
    });
    // Discounts change money only: the full quantities left stock.
    expect(await onHand(a.id)).toBe(8);

    const audit = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "sale.created", entityId: sale.id },
    });
    expect((audit.metadata as Record<string, unknown>).discount).toEqual({
      totalMinor: 480,
      sale: AMOUNT(280),
      lines: expect.arrayContaining([
        { sku: a.sku, discount: PERCENT(1000), discountMinor: 380 },
        { sku: b.sku, discount: null, discountMinor: 100 },
      ]),
    });

    // The receipt shows each line's discount and the total.
    const receipt = await getReceipt(manager, sale.id, { kind: "SALE", copy: false });
    expect(receipt.discountMinor).toBe(480);
    expect(receipt.lines.map((l) => l.discountMinor).sort()).toEqual([100, 380]);
  });

  it("refuses a discount larger than its line, and a discounted item sent twice", async () => {
    const a = await stocked(5, 1000);
    await expectAppError(
      createSale(manager, body([{ productId: a.id, qty: 1, discount: AMOUNT(1001) }], 0), KEY()),
      422,
      "DISCOUNT_TOO_LARGE",
    );
    await expectAppError(
      createSale(
        manager,
        body(
          [
            { productId: a.id, qty: 1, discount: PERCENT(500) },
            { productId: a.id, qty: 1 },
          ],
          2000,
        ),
        KEY(),
      ),
      422,
      "DUPLICATE_DISCOUNTED_LINE",
    );
  });

  it("completes a free sale (100% off by a manager) with no payment", async () => {
    const a = await stocked(5, 1000);
    const { sale } = await createSale(manager, body([{ productId: a.id, qty: 1 }], 0, PERCENT(10_000)), KEY());
    expect(sale).toMatchObject({ totalMinor: 0, discountMinor: 1000, payments: [] });
  });
});

describe("discount limits (DC7–DC9)", () => {
  it("lets a cashier discount up to the shop's limit", async () => {
    const a = await stocked(5, 1000);
    const { sale } = await createSale(cashier, body([{ productId: a.id, qty: 2 }], 1800, PERCENT(1000)), KEY());
    expect(sale.totalMinor).toBe(1800);
  });

  it("refuses a cashier over the limit with 403 and audits the attempt; nothing is written", async () => {
    const a = await stocked(5, 1000);
    const salesBefore = await db.sale.count({ where: { orgId } });
    const err = await expectAppError(
      createSale(cashier, body([{ productId: a.id, qty: 1, discount: PERCENT(1500) }], 850), KEY()),
      403,
      "DISCOUNT_LIMIT",
    );
    expect(detailsOf(err)).toMatchObject({ limitBp: 1000 });
    expect(err.message).toContain("10%");
    expect(await db.sale.count({ where: { orgId } })).toBe(salesBefore);
    expect(await onHand(a.id)).toBe(5);
    const denied = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "sales.discount.denied", actorUserId: cashier.userId },
      orderBy: { createdAt: "desc" },
    });
    expect(denied.metadata).toMatchObject({ reason: "DISCOUNT_LIMIT", limitBp: 1000 });

    // Stacking a 10% line discount and a 10% sale discount is past 10% too.
    await expectAppError(
      createSale(cashier, body([{ productId: a.id, qty: 1, discount: PERCENT(1000) }], 810, PERCENT(1000)), KEY()),
      403,
      "DISCOUNT_LIMIT",
    );
  });

  it("follows the setting the owner changes, and gives managers and owners no limit", async () => {
    const a = await stocked(10, 1000);
    const saved = await updateReceiptSettings(owner, { maxCashierDiscountBp: 2000 });
    expect(saved.maxCashierDiscountBp).toBe(2000);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "settings.receipt.updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.metadata).toMatchObject({ maxCashierDiscountBp: { from: 1000, to: 2000 } });
    await createSale(cashier, body([{ productId: a.id, qty: 1, discount: PERCENT(1500) }], 850), KEY());

    await updateReceiptSettings(owner, { maxCashierDiscountBp: 0 });
    await expectAppError(
      createSale(cashier, body([{ productId: a.id, qty: 1, discount: AMOUNT(1) }], 999), KEY()),
      403,
      "DISCOUNT_LIMIT",
    );
    await createSale(manager, body([{ productId: a.id, qty: 1, discount: PERCENT(9000) }], 100), KEY());
    await createSale(owner, body([{ productId: a.id, qty: 1 }], 500, PERCENT(5000)), KEY());

    await expect(updateReceiptSettings(owner, { maxCashierDiscountBp: 10_001 })).rejects.toBeInstanceOf(ZodError);
    await expectAppError(updateReceiptSettings(manager, { maxCashierDiscountBp: 5000 }), 403);
  });
});

describe("idempotency with discounts (DC11)", () => {
  it("replays the same discounted sale and refuses the key with a different discount", async () => {
    const a = await stocked(5, 1000);
    const key = KEY();
    const first = await createSale(cashier, body([{ productId: a.id, qty: 1 }], 950, PERCENT(500)), key);
    const again = await createSale(cashier, body([{ productId: a.id, qty: 1 }], 950, PERCENT(500)), key);
    expect(again).toMatchObject({ created: false, sale: { id: first.sale.id, discountMinor: 50 } });
    await expectAppError(
      createSale(cashier, body([{ productId: a.id, qty: 1 }], 950, AMOUNT(50)), key),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await onHand(a.id)).toBe(4);
  });
});

describe("refunds of a discounted sale (DC13)", () => {
  it("gives back exactly what was paid, the last refund taking the remainder", async () => {
    const a = await stocked(5, 1000);
    // 3 × 10.00 − 1.00 = 29.00 paid for the line.
    const { sale } = await createSale(cashier, body([{ productId: a.id, qty: 3, discount: AMOUNT(100) }], 2900), KEY());
    const item = await db.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
    expect(item).toMatchObject({ discountMinor: 100, lineTotalMinor: 2900 });

    const one = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: item.id, qty: 1 }],
      method: "CASH",
      reason: "Changed mind",
    });
    expect(one.refund.totalMinor).toBe(967); // round(2900 / 3)
    const rest = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: item.id, qty: 2 }],
      method: "CASH",
      reason: "Changed mind",
    });
    expect(rest.refund.totalMinor).toBe(1933);
    expect(one.refund.totalMinor + rest.refund.totalMinor).toBe(sale.totalMinor);
    expect(one.refund.vatMinor + rest.refund.vatMinor).toBe(sale.vatMinor);
    expect(await onHand(a.id)).toBe(5);
  });
});

describe("reports (DC15)", () => {
  it("shows the discounts given on completed sales next to gross", async () => {
    const [row] = await salesSummary({
      orgId,
      branchIds: [branchId],
      zone: "UTC",
      from: "2000-01-01",
      to: "2100-12-31",
    });
    const sums = await db.sale.aggregate({
      where: { orgId, status: "COMPLETED" },
      _sum: { discountMinor: true, totalMinor: true },
    });
    expect(row.discountsMinor).toBe(sums._sum.discountMinor);
    expect(row.grossMinor).toBe(sums._sum.totalMinor);
    expect(row.discountsMinor).toBeGreaterThan(0);
  });
});
