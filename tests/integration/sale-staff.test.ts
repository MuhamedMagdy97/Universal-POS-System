import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import { saveStaffMember, type StaffMemberRow } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { exportReportCsv, getReport, todayIn } from "@/modules/reports";
import { createSale, getReceipt, getSaleForReturns, refundSale } from "@/modules/sales";
import { createMember, createTenant, expectAppError, expectReconciled, testDb, uniqueCode } from "./helpers";

/**
 * Staff on sale lines and their commission (salon-spec S4, S8). Haircut 100.00, VAT included at 14 %. Sara 40 %,
 * Omar 30 % (another branch too), Lina inactive.
 */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let owner: TenantContext;
let cashier: TenantContext;
let cut: string;
let sara: StaffMemberRow;
let omar: StaffMemberRow;
let lina: StaffMemberRow;
let elsewhere: StaffMemberRow;

const KEY = () => `stf-${crypto.randomUUID()}`;
const ref = { productId: "", variantId: null as string | null };
const sell = (lines: unknown[], amountMinor: number, extra: Record<string, unknown> = {}) =>
  createSale(cashier, { branchId, registerId, lines, payments: [{ method: "CASH", amountMinor }], ...extra }, KEY());

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "SalonStaff");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  cut = (
    await catalog.createProductAggregate(owner, {
      sku: `CUT-${uniqueCode()}`,
      name: "Haircut",
      priceMinor: 10_000,
      isService: true,
      durationMin: 45,
    })
  ).id;
  ref.productId = cut;
  sara = await saveStaffMember(owner, { name: "Sara", nameAr: "سارة", commissionBp: 4_000, branchIds: [branchId] });
  omar = await saveStaffMember(owner, { name: "Omar", commissionBp: 3_000, branchIds: [branchId] });
  lina = await saveStaffMember(owner, { name: "Lina", commissionBp: 1_000, branchIds: [branchId], isActive: false });
  elsewhere = await saveStaffMember(owner, { name: "Hana", commissionBp: 1_000, branchIds: [tenant.branchB.id] });
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("staff on sale lines", () => {
  it("keeps one service done by two staff members as two lines, with their name and percent then", async () => {
    const { sale } = await sell(
      [
        { ref, qty: 1, staffMemberId: sara.id },
        { ref, qty: 1, staffMemberId: omar.id },
        { ref, qty: 1, staffMemberId: sara.id },
      ],
      30_000,
    );
    expect(sale.lines.map((line) => [line.qty, line.staff?.name])).toEqual(
      expect.arrayContaining([
        [2, "Sara"],
        [1, "Omar"],
      ]),
    );
    const rows = await db.saleItem.findMany({ where: { orgId, saleId: sale.id } });
    expect(rows.find((row) => row.staffMemberId === sara.id)).toMatchObject({ staffName: "Sara", commissionBp: 4_000 });
    const receipt = await getReceipt(cashier, sale.id, { kind: "SALE", copy: false });
    expect(receipt.lines.map((line) => line.staffName).sort()).toEqual(["Omar", "Sara"]);
    const view = await getSaleForReturns(owner, sale.number);
    expect(view.lines.map((line) => line.staffName).sort()).toEqual(["Omar", "Sara"]);
  });

  it("refuses an inactive staff member or one from another branch", async () => {
    await expectAppError(sell([{ ref, qty: 1, staffMemberId: lina.id }], 10_000), 422, "STAFF_INVALID");
    await expectAppError(sell([{ ref, qty: 1, staffMemberId: elsewhere.id }], 10_000), 422, "STAFF_INVALID");
  });
});

describe("the staff commission report", () => {
  it("pays the percent at the time of sale on the net after discount, less refunds", async () => {
    // Mira at 40 %: two 100.00 haircuts with 10 % off are 180.00 gross, 157.89 net, 63.16 commission.
    const mira = await saveStaffMember(owner, { name: "Mira", commissionBp: 4_000, branchIds: [branchId] });
    const { sale } = await sell([{ ref, qty: 2, staffMemberId: mira.id }], 18_000, {
      discount: { kind: "PERCENT", percentBp: 1_000 },
    });
    // Mira's percent goes up after the sale: past commission does not move.
    await saveStaffMember(owner, { ...mira, id: mira.id, commissionBp: 5_000 });
    const today = todayIn("Africa/Cairo");
    const before = await getReport(owner, "staff-commission", { branchId, from: today, to: today });
    expect(before.rows.find((row) => row.name === "Mira")).toMatchObject({
      lines: 1,
      netMinor: 15_789,
      commissionMinor: 6_316,
    });

    const [line] = await db.saleItem.findMany({ where: { orgId, saleId: sale.id } });
    await refundSale(owner, sale.id, KEY(), {
      lines: [{ saleItemId: line.id, qty: 1 }],
      method: "CASH",
      reason: "Redo",
    });
    const after = await getReport(owner, "staff-commission", { branchId, from: today, to: today });
    expect(after.rows.find((row) => row.name === "Mira")).toMatchObject({
      refundedNetMinor: 7_894,
      commissionMinor: 3_158,
    });
    const { body } = await exportReportCsv(owner, "staff-commission", { branchId, from: today, to: today });
    expect(body).toContain("Mira");
  });
});
