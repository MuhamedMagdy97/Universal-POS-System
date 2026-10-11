import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { createSale } from "@/modules/sales";
import { openShift } from "@/modules/registers";
import {
  createMember,
  createProduct,
  createTenant,
  detailsOf,
  expectAppError,
  expectReconciled,
  testDb,
} from "./helpers";

/** Checkout (T6): totals, payments, stock, shifts, idempotency and oversell under concurrency. */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let admin: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Checkout");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const KEY = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** Stocks a product at the till's branch. */
async function stocked(qty: number, priceMinor = 1000) {
  const product = await createProduct(db, orgId);
  await db.product.update({ where: { id: product.id }, data: { priceMinor } });
  if (qty > 0) {
    await inventory.recordOpeningBalances(admin, {
      branchId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty }],
    });
  }
  return product;
}

const line = (productId: string, qty: number) => ({ ref: { productId, variantId: null }, qty });

const onHand = async (productId: string) =>
  (await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId, variantId: null } })).qty;

describe("creating a sale", () => {
  it("prices the lines on the server, stores snapshots and payments, and takes the stock", async () => {
    const product = await stocked(5, 1000);
    const { sale, created } = await createSale(
      cashier,
      { branchId, registerId, lines: [line(product.id, 2)], payments: [{ method: "CASH", amountMinor: 2000 }] },
      KEY(),
    );

    expect(created).toBe(true);
    // 2 × 1000 gross, VAT inside at 14%: net 1754, VAT 246.
    expect(sale).toMatchObject({
      subtotalMinor: 1754,
      vatMinor: 246,
      totalMinor: 2000,
      changeMinor: 0,
      discountMinor: 0,
      status: "COMPLETED",
    });
    expect(sale.lines).toEqual([
      expect.objectContaining({
        productId: product.id,
        qty: 2,
        unitPriceMinor: 1000,
        vatRateBp: 1400,
        vatMinor: 246,
        lineTotalMinor: 2000,
      }),
    ]);
    expect(sale.payments).toEqual([{ method: "CASH", amountMinor: 2000, reference: null }]);
    expect(await onHand(product.id)).toBe(3);
    expect(sale.number).toMatch(/^\d{6}$/);
  });

  it("returns cash change and stores only the cash applied to the sale", async () => {
    const product = await stocked(3, 1000);
    const { sale } = await createSale(
      cashier,
      { branchId, registerId, lines: [line(product.id, 1)], payments: [{ method: "CASH", amountMinor: 1500 }] },
      KEY(),
    );
    expect(sale.changeMinor).toBe(500);
    expect(sale.payments).toEqual([{ method: "CASH", amountMinor: 1000, reference: null }]);
  });

  it("merges a repeated item into one line", async () => {
    const product = await stocked(5, 1000);
    const { sale } = await createSale(
      cashier,
      {
        branchId,
        registerId,
        lines: [line(product.id, 1), line(product.id, 2)],
        payments: [{ method: "CASH", amountMinor: 3000 }],
      },
      KEY(),
    );
    expect(sale.lines).toHaveLength(1);
    expect(sale.lines[0].qty).toBe(3);
    expect(await onHand(product.id)).toBe(2);
  });

  it("refuses payments that do not cover the total, and writes nothing", async () => {
    const product = await stocked(5, 1000);
    await expectAppError(
      createSale(
        cashier,
        { branchId, registerId, lines: [line(product.id, 1)], payments: [{ method: "CARD_MANUAL", amountMinor: 500 }] },
        KEY(),
      ),
      422,
      "PAYMENT_MISMATCH",
    );
    expect(await onHand(product.id)).toBe(5);
  });

  it("refuses without an open shift on the register", async () => {
    const second = await createTenant(db, "No Shift");
    const otherAdmin = await createMember(db, second.org.id, "ADMIN");
    const otherCashier = await createMember(db, second.org.id, "CASHIER");
    const otherProduct = await createProduct(db, second.org.id);
    await inventory.recordOpeningBalances(otherAdmin, {
      branchId: second.branchA.id,
      lines: [{ ref: { productId: otherProduct.id, variantId: null }, qty: 2 }],
    });
    await expectAppError(
      createSale(
        otherCashier,
        {
          branchId: second.branchA.id,
          registerId: second.register.id,
          lines: [line(otherProduct.id, 1)],
          payments: [{ method: "CASH", amountMinor: 1000 }],
        },
        KEY(),
      ),
      409,
      "SHIFT_NOT_OPEN",
    );
  });

  it("refuses when stock is short under the block policy, and consumes no sale number", async () => {
    const product = await stocked(1, 1000);
    const before = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
    const err = await expectAppError(
      createSale(
        cashier,
        { branchId, registerId, lines: [line(product.id, 2)], payments: [{ method: "CASH", amountMinor: 2000 }] },
        KEY(),
      ),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(detailsOf(err).lines).toEqual([expect.objectContaining({ productId: product.id, onHand: 1, requested: 2 })]);
    expect(await onHand(product.id)).toBe(1);
    const after = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(after.lastSaleNo).toBe(before.lastSaleNo);
  });

  it("refuses an archived item", async () => {
    const product = await stocked(5, 1000);
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    await expectAppError(
      createSale(
        cashier,
        { branchId, registerId, lines: [line(product.id, 1)], payments: [{ method: "CASH", amountMinor: 1000 }] },
        KEY(),
      ),
      422,
      "ITEM_NOT_SELLABLE",
    );
  });

  it("refuses a user without sales.create", async () => {
    const product = await stocked(5, 1000);
    const reporting = await createMember(db, orgId, "REPORTING");
    await expectAppError(
      createSale(
        reporting,
        { branchId, registerId, lines: [line(product.id, 1)], payments: [{ method: "CASH", amountMinor: 1000 }] },
        KEY(),
      ),
      403,
    );
  });
});

describe("edge amounts", () => {
  it("completes a zero-total sale with no payments", async () => {
    const product = await stocked(2, 0);
    const { sale } = await createSale(
      cashier,
      { branchId, registerId, lines: [line(product.id, 1)], payments: [] },
      KEY(),
    );
    expect(sale).toMatchObject({ totalMinor: 0, vatMinor: 0, changeMinor: 0, payments: [] });
    expect(await onHand(product.id)).toBe(1);
  });

  it("refuses a sale with no payments when something is due", async () => {
    const product = await stocked(2, 1000);
    await expectAppError(
      createSale(cashier, { branchId, registerId, lines: [line(product.id, 1)], payments: [] }, KEY()),
      422,
      "PAYMENT_MISMATCH",
    );
  });

  it("refuses a line total that does not fit the money columns with a 422, not a DB error", async () => {
    const product = await stocked(300, 10_000_000);
    await expectAppError(
      createSale(
        cashier,
        { branchId, registerId, lines: [line(product.id, 300)], payments: [{ method: "CASH", amountMinor: 1 }] },
        KEY(),
      ),
      422,
      "AMOUNT_TOO_LARGE",
    );
    expect(await onHand(product.id)).toBe(300);
  });
});

describe("idempotency (D5)", () => {
  it("replays the same request with the same key and returns the original sale", async () => {
    const product = await stocked(5, 1000);
    const body = {
      branchId,
      registerId,
      lines: [line(product.id, 1)],
      payments: [{ method: "CASH" as const, amountMinor: 1000 }],
    };
    const key = KEY();
    const first = await createSale(cashier, body, key);
    const replay = await createSale(cashier, body, key);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.sale.id).toBe(first.sale.id);
    expect(await onHand(product.id)).toBe(4);
  });

  it("refuses a reused key with a different body", async () => {
    const product = await stocked(5, 1000);
    const key = KEY();
    await createSale(
      cashier,
      { branchId, registerId, lines: [line(product.id, 1)], payments: [{ method: "CASH", amountMinor: 1000 }] },
      key,
    );
    await expectAppError(
      createSale(
        cashier,
        { branchId, registerId, lines: [line(product.id, 2)], payments: [{ method: "CASH", amountMinor: 2000 }] },
        key,
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await onHand(product.id)).toBe(4);
  });

  it("sells once when the same key arrives twice at the same time", async () => {
    const product = await stocked(5, 1000);
    const body = {
      branchId,
      registerId,
      lines: [line(product.id, 1)],
      payments: [{ method: "CASH" as const, amountMinor: 1000 }],
    };
    const key = KEY();
    const results = await Promise.allSettled([createSale(cashier, body, key), createSale(cashier, body, key)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const ids = new Set(fulfilled.map((r) => (r as PromiseFulfilledResult<{ sale: { id: string } }>).value.sale.id));
    expect(ids.size).toBe(1);
    expect(await onHand(product.id)).toBe(4);
  });
});

describe("oversell under concurrency (I-3 at the till)", () => {
  it("lets exactly one of two concurrent sales take the last unit", async () => {
    const product = await stocked(1, 1000);
    const attempt = () =>
      createSale(
        cashier,
        { branchId, registerId, lines: [line(product.id, 1)], payments: [{ method: "CASH", amountMinor: 1000 }] },
        KEY(),
      );
    const results = await Promise.allSettled([attempt(), attempt()]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(await onHand(product.id)).toBe(0);
  });
});
