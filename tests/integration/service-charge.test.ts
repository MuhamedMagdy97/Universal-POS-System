import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { getServiceCharge, updateServiceCharge } from "@/modules/org";
import { closeShift, getZReport, openShift } from "@/modules/registers";
import { getReport, todayIn } from "@/modules/reports";
import { createSale, getReceipt, refundSale } from "@/modules/sales";
import { createMember, createProduct, createTenant, expectAppError, expectReconciled, testDb } from "./helpers";

/**
 * The dine-in service charge (restaurant-cafe-spec R11) at 12 %: tea 10.00, VAT included at 14 %. Three teas are 30.00;
 * the charge is 3.60 with 0.44 VAT inside it, given back a third at a time (1.20 / 0.15, 1.20 / 0.14, then the rest).
 */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let owner: TenantContext;
let admin: TenantContext;
let cashier: TenantContext;
let tea: string;
let shiftId: string;

const KEY = () => `svc-${crypto.randomUUID()}`;
const ref = (productId: string) => ({ productId, variantId: null });
const sell = (input: Record<string, unknown>, amountMinor: number) =>
  createSale(
    cashier,
    {
      branchId,
      registerId,
      lines: [{ ref: ref(tea), qty: 3 }],
      payments: [{ method: "CASH", amountMinor }],
      ...input,
    },
    KEY(),
  );

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Service");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
  tea = (await createProduct(db, orgId, "SVC-TEA")).id;
  await inventory.recordOpeningBalances(owner, { branchId, lines: [{ ref: ref(tea), qty: 50 }] });
  await db.organization.update({ where: { id: orgId }, data: { maxCashierDiscountBp: 2_000 } });
  shiftId = (await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 })).id;
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("service charge", () => {
  it("is the Owner's setting, 0 to 25 %, audited", async () => {
    expect(await getServiceCharge(cashier)).toEqual({ serviceChargeBp: 0 });
    await expectAppError(updateServiceCharge(admin, { serviceChargeBp: 1_200 }), 403);
    await expect(updateServiceCharge(owner, { serviceChargeBp: 2_600 })).rejects.toThrow();
    await updateServiceCharge(owner, { serviceChargeBp: 1_200 });
    await updateServiceCharge(owner, { serviceChargeBp: 1_200 });
    expect(await db.auditEvent.count({ where: { orgId, action: "settings.service_charge.updated" } })).toBe(1);
  });

  it("is charged on dine-in after discounts, not on takeaway, and can be taken off one order", async () => {
    // 30.00 less 10% = 27.00; 12% of it is 3.24.
    const { sale } = await sell({ orderType: "DINE_IN", discount: { kind: "PERCENT", percentBp: 1_000 } }, 3_024);
    expect(sale).toMatchObject({ totalMinor: 3_024, serviceChargeMinor: 324 });
    const receipt = await getReceipt(cashier, sale.id, { kind: "SALE", copy: false });
    expect(receipt.serviceChargeMinor).toBe(324);

    expect((await sell({ orderType: "TAKEAWAY" }, 3_000)).sale).toMatchObject({ serviceChargeMinor: 0 });
    const off = (await sell({ orderType: "DINE_IN", serviceCharge: false }, 3_000)).sale;
    expect(off).toMatchObject({ totalMinor: 3_000, serviceChargeMinor: 0 });
    const event = await db.auditEvent.findFirstOrThrow({ where: { orgId, action: "sale.created", entityId: off.id } });
    expect(event.metadata).toMatchObject({ serviceChargeRemoved: true });
  });

  it("is given back in proportion over part refunds, exactly in full by the last", async () => {
    const { sale } = await sell({ orderType: "DINE_IN" }, 3_360);
    const row = await db.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row).toMatchObject({ serviceChargeMinor: 360, serviceChargeVatMinor: 44, totalMinor: 3_360 });
    const [line] = await db.saleItem.findMany({ where: { orgId, saleId: sale.id } });

    const back = [];
    for (let i = 0; i < 3; i += 1) {
      const { refund } = await refundSale(owner, sale.id, KEY(), {
        lines: [{ saleItemId: line.id, qty: 1 }],
        method: "CASH",
        reason: "Cold",
      });
      back.push(await db.refund.findUniqueOrThrow({ where: { id: refund.id } }));
    }
    expect(back.map((refund) => [refund.totalMinor, refund.serviceChargeMinor, refund.serviceChargeVatMinor])).toEqual([
      [1_120, 120, 15],
      [1_120, 120, 14],
      [1_120, 120, 15],
    ]);
    const refundSlip = await getReceipt(owner, sale.id, { kind: "REFUND", refundId: back[0].id, copy: false });
    expect(refundSlip.serviceChargeMinor).toBe(120);
  });

  it("shows on the sales summary and the Z-report as its own figure", async () => {
    const today = todayIn("Africa/Cairo");
    const { rows } = await getReport(owner, "sales-summary", { branchId, from: today, to: today });
    // 3.24 + 3.60 charged, 3.60 given back.
    expect(rows[0].serviceChargeMinor).toBe(324);
    await closeShift(cashier, shiftId, { countedCashMinor: 0, discrepancyNote: "test" });
    expect((await getZReport(owner, shiftId)).serviceChargeMinor).toBe(324);
  });
});
