import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { createSale } from "@/modules/sales";
import { addCashMovement, closeShift, openShift, previewShiftCash } from "@/modules/registers";
import {
  createMember,
  createProduct,
  createTenant,
  expectAppError,
  expectReconciled,
  uniqueCode,
  testDb,
} from "./helpers";

/** Shift close and cash count (T7, shift-close-spec.md): expected cash, discrepancy, movements, races. */

let db: Db;
let orgId: string;
let branchId: string;
let otherBranchId: string;
let admin: TenantContext;
let cashier: TenantContext;
let reporting: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Shift Close");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  otherBranchId = tenant.branchB.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
  reporting = await createMember(db, orgId, "REPORTING");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const KEY = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** A fresh register with an open shift, so every test has its own till. */
async function openTill(openingFloatMinor: number) {
  const register = await db.register.create({ data: { orgId, branchId, name: `Till ${uniqueCode()}` } });
  const shift = await openShift(cashier, { branchId, registerId: register.id, openingFloatMinor });
  return { registerId: register.id, shiftId: shift.id };
}

/** Stocks a product at the branch and sets its gross price. */
async function stocked(qty: number, priceMinor: number) {
  const product = await createProduct(db, orgId);
  await db.product.update({ where: { id: product.id }, data: { priceMinor } });
  await inventory.recordOpeningBalances(admin, {
    branchId,
    lines: [{ ref: { productId: product.id, variantId: null }, qty }],
  });
  return product;
}

const line = (productId: string, qty: number) => ({ ref: { productId, variantId: null }, qty });

describe("closing a shift", () => {
  it("expects the opening float when nothing else moved the cash, and needs no note at zero difference", async () => {
    const { shiftId } = await openTill(5000);
    const closed = await closeShift(cashier, shiftId, { countedCashMinor: 5000 });

    expect(closed).toMatchObject({
      status: "CLOSED",
      expectedCashMinor: 5000,
      countedCashMinor: 5000,
      discrepancyMinor: 0,
      discrepancyNote: null,
    });
    const audit = await db.auditEvent.findFirst({ where: { orgId, action: "shift.closed", entityId: shiftId } });
    expect(audit).not.toBeNull();
  });

  it("counts applied cash on sales (change excluded) and pay-ins, pay-outs and drops", async () => {
    const { registerId, shiftId } = await openTill(5000);
    const product = await stocked(10, 1000);

    // 2 × 1000 gross, tendered 3000: applied cash 2000, change 1000. Only 2000 stays in the drawer.
    const { sale } = await createSale(
      cashier,
      { branchId, registerId, lines: [line(product.id, 2)], payments: [{ method: "CASH", amountMinor: 3000 }] },
      KEY(),
    );
    expect(sale.changeMinor).toBe(1000);

    await addCashMovement(cashier, shiftId, { type: "PAY_IN", amountMinor: 500, reason: "Float top-up" });
    await addCashMovement(cashier, shiftId, { type: "PAY_OUT", amountMinor: 200, reason: "Milk" });
    await addCashMovement(cashier, shiftId, { type: "DROP", amountMinor: 300, reason: "Safe drop" });

    // 5000 + 2000 + 500 − 200 − 300 = 7000. The screen's preview shows the same breakdown.
    expect(await previewShiftCash(cashier, shiftId)).toEqual({
      openingFloatMinor: 5000,
      cashSalesMinor: 2000,
      payInMinor: 500,
      payOutMinor: 200,
      dropMinor: 300,
      cashRefundsMinor: 0,
      expectedCashMinor: 7000,
    });
    const closed = await closeShift(cashier, shiftId, {
      countedCashMinor: 6800,
      discrepancyNote: "Short 200, will check",
    });
    expect(closed).toMatchObject({ expectedCashMinor: 7000, countedCashMinor: 6800, discrepancyMinor: -200 });
  });

  it("refuses a non-zero difference without a note, and stores the note when given", async () => {
    const { shiftId } = await openTill(1000);

    await expectAppError(closeShift(cashier, shiftId, { countedCashMinor: 900 }), 422, "DISCREPANCY_NOTE_REQUIRED");

    const closed = await closeShift(cashier, shiftId, { countedCashMinor: 900, discrepancyNote: "Coin miscount" });
    expect(closed).toMatchObject({ discrepancyMinor: -100, discrepancyNote: "Coin miscount" });
  });

  it("returns the closed shift for a repeat with the same count and note, and refuses a different one", async () => {
    const { shiftId } = await openTill(1000);
    const first = await closeShift(cashier, shiftId, { countedCashMinor: 1000 });

    const repeat = await closeShift(cashier, shiftId, { countedCashMinor: 1000 });
    expect(repeat).toEqual(first);

    await expectAppError(closeShift(cashier, shiftId, { countedCashMinor: 1500 }), 409, "SHIFT_ALREADY_CLOSED");
  });

  it("refuses sales and cash movements once the shift is closed", async () => {
    const { registerId, shiftId } = await openTill(0);
    const product = await stocked(5, 1000);
    await closeShift(cashier, shiftId, { countedCashMinor: 0 });

    await expectAppError(
      createSale(
        cashier,
        { branchId, registerId, lines: [line(product.id, 1)], payments: [{ method: "CASH", amountMinor: 1000 }] },
        KEY(),
      ),
      409,
      "SHIFT_NOT_OPEN",
    );
    await expectAppError(
      addCashMovement(cashier, shiftId, { type: "PAY_IN", amountMinor: 100, reason: "Late" }),
      409,
      "SHIFT_NOT_OPEN",
    );
  });

  it("refuses a user without registers.close", async () => {
    const { shiftId } = await openTill(0);
    await expectAppError(closeShift(reporting, shiftId, { countedCashMinor: 0 }), 403);
  });

  it("refuses another organization's shift as not found", async () => {
    const other = await createTenant(db, "Other Org");
    const otherCashier = await createMember(db, other.org.id, "CASHIER");
    const { shiftId } = await openTill(0);
    await expectAppError(closeShift(otherCashier, shiftId, { countedCashMinor: 0 }), 404);
  });

  it("refuses a shift outside the caller's branch scope as not found", async () => {
    // A cashier limited to the other branch cannot close, preview or move cash on this branch's shift.
    const limited = await createMember(db, orgId, "CASHIER");
    await db.membership.update({ where: { id: limited.membershipId }, data: { allBranches: false } });
    await db.membershipBranch.create({ data: { orgId, membershipId: limited.membershipId, branchId: otherBranchId } });
    const { shiftId } = await openTill(0);

    await expectAppError(closeShift(limited, shiftId, { countedCashMinor: 0 }), 404);
    await expectAppError(previewShiftCash(limited, shiftId), 404);
    await expectAppError(addCashMovement(limited, shiftId, { type: "PAY_IN", amountMinor: 1, reason: "x" }), 404);
  });

  it("refuses a malformed shift id as not found", async () => {
    await expectAppError(closeShift(cashier, "not-a-uuid", { countedCashMinor: 0 }), 404);
  });

  it("validates the count and the cash movement amount", async () => {
    const { shiftId } = await openTill(0);
    await expect(closeShift(cashier, shiftId, { countedCashMinor: -1 })).rejects.toBeInstanceOf(ZodError);
    await expect(
      addCashMovement(cashier, shiftId, { type: "PAY_OUT", amountMinor: 0, reason: "None" }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe("cash movements", () => {
  it("records a movement with its reason and audit row, and refuses a role without the permission", async () => {
    const { shiftId } = await openTill(0);
    const movement = await addCashMovement(cashier, shiftId, {
      type: "PAY_IN",
      amountMinor: 400,
      reason: "Change fund",
    });
    expect(movement).toMatchObject({ type: "PAY_IN", amountMinor: 400, reason: "Change fund" });
    const audit = await db.auditEvent.findFirst({ where: { orgId, action: "shift.cash_movement", entityId: shiftId } });
    expect(audit).not.toBeNull();

    // Reporting has neither sales.create (pay-in) nor registers.close (pay-out, drop). No default
    // role holds sales.create without registers.close, so the S5 split is covered per permission here.
    await expectAppError(addCashMovement(reporting, shiftId, { type: "PAY_IN", amountMinor: 1, reason: "No" }), 403);
    await expectAppError(addCashMovement(reporting, shiftId, { type: "PAY_OUT", amountMinor: 1, reason: "No" }), 403);
  });
});

describe("closing against a concurrent sale", () => {
  it("either counts the sale in the expected cash or refuses it, never both", async () => {
    for (let round = 0; round < 3; round++) {
      const { registerId, shiftId } = await openTill(0);
      const product = await stocked(5, 1000);

      const [closeResult, saleResult] = await Promise.allSettled([
        closeShift(cashier, shiftId, { countedCashMinor: 1000, discrepancyNote: "Race check" }),
        createSale(
          cashier,
          { branchId, registerId, lines: [line(product.id, 1)], payments: [{ method: "CASH", amountMinor: 1000 }] },
          KEY(),
        ),
      ]);

      expect(closeResult.status).toBe("fulfilled");
      if (closeResult.status !== "fulfilled") continue;

      if (saleResult.status === "fulfilled") {
        // The sale committed first: its cash is in the expected amount.
        expect(closeResult.value.expectedCashMinor).toBe(1000);
      } else {
        // The close committed first: the sale was refused and nothing is counted.
        expect(closeResult.value.expectedCashMinor).toBe(0);
      }
    }
  });
});
