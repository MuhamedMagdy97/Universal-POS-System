import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { createSale, refundSale, voidSale } from "@/modules/sales";
import { closeShift, openShift, previewShiftCash } from "@/modules/registers";
import {
  createMember,
  createProduct,
  createTenant,
  detailsOf,
  expectAppError,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/** Returns, refunds and voids (T8, returns-void-spec.md): partial and last refunds, voids, shifts and races. */

let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let cashier: TenantContext;
let manager: TenantContext;
let reporting: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Returns");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
  manager = await createMember(db, orgId, "MANAGER");
  reporting = await createMember(db, orgId, "REPORTING");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const KEY = () => `key-${uniqueCode()}`;
const line = (productId: string, qty: number) => ({ ref: { productId, variantId: null }, qty });

/** A fresh register with an open shift. */
async function openTill(openingFloatMinor = 0) {
  const register = await db.register.create({ data: { orgId, branchId, name: `Till ${uniqueCode()}` } });
  const shift = await openShift(cashier, { branchId, registerId: register.id, openingFloatMinor });
  return { registerId: register.id, shiftId: shift.id };
}

/** Stocks a product at the branch with a gross price (VAT included, 14%). */
async function stocked(qty: number, priceMinor: number) {
  const product = await createProduct(db, orgId);
  await db.product.update({ where: { id: product.id }, data: { priceMinor } });
  await inventory.recordOpeningBalances(admin, {
    branchId,
    lines: [{ ref: { productId: product.id, variantId: null }, qty }],
  });
  return product;
}

async function cashSale(registerId: string, productId: string, qty: number, tenderedMinor: number) {
  const { sale } = await createSale(
    cashier,
    { branchId, registerId, lines: [line(productId, qty)], payments: [{ method: "CASH", amountMinor: tenderedMinor }] },
    KEY(),
  );
  return sale;
}

const onHand = async (productId: string) =>
  (await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId, variantId: null } })).qty;

const saleItemIds = async (saleId: string) =>
  (await db.saleItem.findMany({ where: { saleId }, orderBy: { id: "asc" } })).map((item) => item.id);

describe("refunding lines of a sale", () => {
  it("refunds one unit of two: amount and VAT by share, stock back, drawer reduced at close", async () => {
    const { registerId, shiftId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 2, 2000);
    const [itemId] = await saleItemIds(sale.id);

    const { refund, created } = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: itemId, qty: 1 }],
      method: "CASH",
      reason: "Changed mind",
    });
    expect(created).toBe(true);
    // Line: gross 2000, VAT 246 (14% inside). One unit: gross 1000, VAT 123.
    expect(refund).toMatchObject({ totalMinor: 1000, vatMinor: 123, method: "CASH", shiftId });
    expect(await onHand(product.id)).toBe(4);

    // Drawer: cash sale 2000 − cash refund 1000 = 1000.
    expect(await previewShiftCash(cashier, shiftId)).toMatchObject({
      cashSalesMinor: 2000,
      cashRefundsMinor: 1000,
      expectedCashMinor: 1000,
    });
  });

  it("refunds the last unit with the remainder, so the two refunds add up to the line exactly", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1001);
    const sale = await cashSale(registerId, product.id, 3, 3003);
    const [itemId] = await saleItemIds(sale.id);

    const first = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: itemId, qty: 1 }],
      method: "CASH",
      reason: "One",
    });
    const second = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: itemId, qty: 1 }],
      method: "CASH",
      reason: "Two",
    });
    const last = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: itemId, qty: 1 }],
      method: "CASH",
      reason: "Three",
    });

    const item = await db.saleItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(first.refund.totalMinor + second.refund.totalMinor + last.refund.totalMinor).toBe(item.lineTotalMinor);
    expect(first.refund.vatMinor + second.refund.vatMinor + last.refund.vatMinor).toBe(item.vatMinor);
  });

  it("refuses more than the remaining quantity and names the line", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 2, 2000);
    const [itemId] = await saleItemIds(sale.id);
    await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: itemId, qty: 1 }],
      method: "CASH",
      reason: "One",
    });

    const err = await expectAppError(
      refundSale(manager, sale.id, KEY(), {
        lines: [{ saleItemId: itemId, qty: 2 }],
        method: "CASH",
        reason: "Too many",
      }),
      409,
      "REFUND_QTY_EXCEEDED",
    );
    expect(detailsOf(err).lines).toEqual([{ saleItemId: itemId, requested: 2, refundable: 1 }]);
  });

  it("replays the same key and body as the original refund, and refuses the key with another body", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 2, 2000);
    const [itemId] = await saleItemIds(sale.id);
    const key = KEY();
    const body = { lines: [{ saleItemId: itemId, qty: 1 }], method: "CASH" as const, reason: "Same" };

    const first = await refundSale(manager, sale.id, key, body);
    const replay = await refundSale(manager, sale.id, key, body);
    expect(replay.created).toBe(false);
    expect(replay.refund.id).toBe(first.refund.id);
    expect(await db.refund.count({ where: { orgId, saleId: sale.id } })).toBe(1);
    expect(await onHand(product.id)).toBe(4);

    await expectAppError(
      refundSale(manager, sale.id, key, { ...body, reason: "Different" }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("refunds to a card without touching the drawer, and keeps the manual reference", async () => {
    const { registerId, shiftId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 1, 1000);
    const [itemId] = await saleItemIds(sale.id);

    const { refund } = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: itemId, qty: 1 }],
      method: "CARD_MANUAL",
      reference: "SLIP-42",
      reason: "Card return",
    });
    expect(refund).toMatchObject({ method: "CARD_MANUAL", reference: "SLIP-42", totalMinor: 1000 });
    expect(await previewShiftCash(cashier, shiftId)).toMatchObject({ cashRefundsMinor: 0, expectedCashMinor: 1000 });
  });

  it("refuses a refund without an open shift on the register", async () => {
    const { registerId, shiftId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 1, 1000);
    const [itemId] = await saleItemIds(sale.id);
    await closeShift(cashier, shiftId, { countedCashMinor: 1000 });

    // The sale's shift is closed, and the register has no open shift to book against.
    await expectAppError(
      refundSale(manager, sale.id, KEY(), { lines: [{ saleItemId: itemId, qty: 1 }], method: "CASH", reason: "Late" }),
      409,
      "SHIFT_NOT_OPEN",
    );
  });

  it("books a refund of a closed shift's sale on the open shift, and leaves the closed shift unchanged", async () => {
    const { registerId, shiftId: closedId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 1, 1000);
    const [itemId] = await saleItemIds(sale.id);
    await closeShift(cashier, closedId, { countedCashMinor: 1000 });
    const before = await db.registerShift.findUniqueOrThrow({ where: { id: closedId } });

    const nextShift = await openShift(cashier, { branchId, registerId, openingFloatMinor: 500 });
    const { refund } = await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: itemId, qty: 1 }],
      method: "CASH",
      reason: "Next day",
    });
    expect(refund.shiftId).toBe(nextShift.id);
    expect(await db.registerShift.findUniqueOrThrow({ where: { id: closedId } })).toEqual(before);
    expect(await previewShiftCash(cashier, nextShift.id)).toMatchObject({
      cashRefundsMinor: 1000,
      expectedCashMinor: -500,
    });
  });

  it("refuses a user without sales.refund", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 1, 1000);
    const [itemId] = await saleItemIds(sale.id);
    await expectAppError(
      refundSale(reporting, sale.id, KEY(), { lines: [{ saleItemId: itemId, qty: 1 }], method: "CASH", reason: "No" }),
      403,
    );
  });

  it("answers 404 for an unknown sale line and a malformed sale id", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 1, 1000);
    await expectAppError(
      refundSale(manager, sale.id, KEY(), {
        lines: [{ saleItemId: crypto.randomUUID(), qty: 1 }],
        method: "CASH",
        reason: "x",
      }),
      404,
    );
    await expectAppError(
      refundSale(manager, "not-a-uuid", KEY(), {
        lines: [{ saleItemId: crypto.randomUUID(), qty: 1 }],
        method: "CASH",
        reason: "x",
      }),
      404,
    );
  });

  it("lets only one of two concurrent refunds of the last units through", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 2, 2000);
    const [itemId] = await saleItemIds(sale.id);

    const results = await Promise.allSettled([
      refundSale(manager, sale.id, KEY(), { lines: [{ saleItemId: itemId, qty: 2 }], method: "CASH", reason: "A" }),
      refundSale(manager, sale.id, KEY(), { lines: [{ saleItemId: itemId, qty: 2 }], method: "CASH", reason: "B" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
    expect(await onHand(product.id)).toBe(5);
  });
});

describe("voiding a sale", () => {
  it("voids a sale on the open shift: status VOIDED, stock back, cash out of the drawer", async () => {
    const { registerId, shiftId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 2, 2000);
    expect(await onHand(product.id)).toBe(3);

    const { sale: voided, created } = await voidSale(manager, sale.id, { reason: "Wrong customer" });
    expect(created).toBe(true);
    expect(voided.status).toBe("VOIDED");
    expect(await onHand(product.id)).toBe(5);
    expect(await previewShiftCash(cashier, shiftId)).toMatchObject({ cashSalesMinor: 0, expectedCashMinor: 0 });

    const audit = await db.auditEvent.findFirst({ where: { orgId, action: "sale.void", entityId: sale.id } });
    expect(audit).not.toBeNull();
  });

  it("replays a void of an already voided sale as it is", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 1, 1000);
    await voidSale(manager, sale.id, { reason: "First" });
    const replay = await voidSale(manager, sale.id, { reason: "Second" });
    expect(replay.created).toBe(false);
    expect(replay.sale.status).toBe("VOIDED");
    expect(await onHand(product.id)).toBe(5);
  });

  it("refuses a void once any line has been refunded", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 2, 2000);
    const [itemId] = await saleItemIds(sale.id);
    await refundSale(manager, sale.id, KEY(), {
      lines: [{ saleItemId: itemId, qty: 1 }],
      method: "CASH",
      reason: "One",
    });
    await expectAppError(voidSale(manager, sale.id, { reason: "Too late" }), 409, "SALE_HAS_REFUNDS");
  });

  it("refuses a void after the sale's shift closed, and leaves the closed shift unchanged", async () => {
    const { registerId, shiftId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 1, 1000);
    await closeShift(cashier, shiftId, { countedCashMinor: 1000 });
    const before = await db.registerShift.findUniqueOrThrow({ where: { id: shiftId } });

    await expectAppError(voidSale(manager, sale.id, { reason: "Closed" }), 409, "VOID_SHIFT_CLOSED");
    expect(await db.registerShift.findUniqueOrThrow({ where: { id: shiftId } })).toEqual(before);
    expect(await onHand(product.id)).toBe(4);
  });

  it("refuses a user without sales.void", async () => {
    const { registerId } = await openTill(0);
    const product = await stocked(5, 1000);
    const sale = await cashSale(registerId, product.id, 1, 1000);
    await expectAppError(voidSale(cashier, sale.id, { reason: "No" }), 403);
  });

  it("never both voids and refunds the same sale when they race", async () => {
    for (let round = 0; round < 3; round++) {
      const { registerId } = await openTill(0);
      const product = await stocked(5, 1000);
      const sale = await cashSale(registerId, product.id, 1, 1000);
      const [itemId] = await saleItemIds(sale.id);

      const [voidResult, refundResult] = await Promise.allSettled([
        voidSale(manager, sale.id, { reason: "Race" }),
        refundSale(manager, sale.id, KEY(), {
          lines: [{ saleItemId: itemId, qty: 1 }],
          method: "CASH",
          reason: "Race",
        }),
      ]);
      const voided = voidResult.status === "fulfilled";
      const refunded = refundResult.status === "fulfilled";
      expect(voided && refunded).toBe(false);
      expect(voided || refunded).toBe(true);
    }
  });
});

describe("rounding of refunds", () => {
  it("keeps the expected cash exact when a sale is refunded in several parts", async () => {
    const { registerId, shiftId } = await openTill(0);
    const product = await stocked(10, 999);
    const sale = await cashSale(registerId, product.id, 3, 2997);
    const [itemId] = await saleItemIds(sale.id);
    for (let i = 0; i < 3; i++) {
      await refundSale(manager, sale.id, KEY(), {
        lines: [{ saleItemId: itemId, qty: 1 }],
        method: "CASH",
        reason: `Part ${i}`,
      });
    }
    // The drawer ends where it started, to the piastre.
    expect(await previewShiftCash(cashier, shiftId)).toMatchObject({ expectedCashMinor: 0 });
  });

  it("refuses a refund that comes to zero with a 422, not a database error", async () => {
    // A free item (zero-total sale, T6) has no money to give back; the database requires a refund total above zero.
    const { registerId } = await openTill(0);
    const product = await stocked(5, 0);
    const { sale } = await createSale(
      cashier,
      { branchId, registerId, lines: [line(product.id, 1)], payments: [] },
      KEY(),
    );
    const [itemId] = await saleItemIds(sale.id);

    await expectAppError(
      refundSale(manager, sale.id, KEY(), { lines: [{ saleItemId: itemId, qty: 1 }], method: "CASH", reason: "Free" }),
      422,
      "REFUND_ZERO_TOTAL",
    );
    expect(await db.refund.count({ where: { orgId, saleId: sale.id } })).toBe(0);
    expect(await onHand(product.id)).toBe(4);
  });
});
