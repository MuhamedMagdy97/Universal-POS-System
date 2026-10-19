import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { addCashMovement, closeShift, openShift } from "@/modules/registers";
import { createSale, refundSale, voidSale } from "@/modules/sales";
import { createCategory, createMember, createProduct, createTenant, createVariant, uniqueCode } from "./helpers";

/**
 * One known trading history for the report tests (reports-audit-ux-and-tests.md §5), built through
 * the real sale, refund, void, cash and close services, then moved to fixed times.
 *
 * Day D is 2026-03-10 in Cairo (UTC+2 in March). Branch A, till T1:
 *   shift 1 (opened D 09:00, float 100.00, closed D 20:00 counted 1.00 short)
 *     S1 P1×2 cash (tendered 300.00)           228.00
 *     S2 P2 + P4 (zero-rated) card              60.00
 *     S3 P3 variant wallet                      22.80
 *     S4 P1 split: card 50.00 + cash 64.00     114.00
 *     S5 P2 cash, voided on D                   50.00
 *     refund of one P1 from S1, cash           114.00
 *     pay-in 20.00, pay-out 15.00, drop 50.00
 *   shift 2 (opened D+1, stays open)
 *     refund of S3, wallet, on D+1              22.80
 *     S6 P2 cash at 23:30 Cairo on D+1          50.00
 *     S7 P2 cash at 00:30 Cairo on D+2          50.00
 * Branch B: one P1 cash sale on D. Another org: one P1 cash sale on D.
 */

export const DAY = "2026-03-10";
export const DAY1 = "2026-03-11";
export const DAY2 = "2026-03-12";

type Backdated = "Sale" | "Refund" | "RegisterShift" | "GoodsReceipt";
type BackdatedColumn = "createdAt" | "voidedAt" | "openedAt" | "closedAt" | "receivedAt";

/**
 * Test only: moves rows to fixed times. Sales and refunds are append-only and closed shifts are
 * immutable (database triggers), so the updates run in one transaction with triggers suspended
 * (`session_replication_role = replica`, superuser; the local and CI test databases run as one).
 */
export async function backdate(db: Db, updates: [Backdated, string, BackdatedColumn, string][]): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    for (const [table, id, column, iso] of updates) {
      await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "${column}" = ($1::timestamptz AT TIME ZONE 'UTC') WHERE "id" = $2::uuid`,
        iso,
        id,
      );
    }
  });
}

const KEY = () => `rep-${uniqueCode()}`;

export async function seedReportsFixture(db: Db) {
  const tenant = await createTenant(db, "Reports");
  const orgId = tenant.org.id;
  const branchA = tenant.branchA.id;
  const branchB = tenant.branchB.id;
  const owner = await createMember(db, orgId, "OWNER");
  const cashier = await createMember(db, orgId, "CASHIER");
  const manager = await createMember(db, orgId, "MANAGER");

  const category = await createCategory(db, orgId, "Drinks");
  const p1 = await createProduct(db, orgId);
  await db.product.update({ where: { id: p1.id }, data: { priceMinor: 11_400, categoryId: category.id } });
  const p2 = await createProduct(db, orgId);
  await db.product.update({ where: { id: p2.id }, data: { priceMinor: 5_000 } });
  const p3 = await createProduct(db, orgId);
  const v3 = await createVariant(db, orgId, p3.id);
  await db.productVariant.update({ where: { id: v3.id }, data: { priceMinor: 2_280 } });
  const p4 = await createProduct(db, orgId);
  await db.product.update({
    where: { id: p4.id },
    data: { priceMinor: 1_000, vatApplicable: false, vatCategory: "ZERO_RATED" },
  });

  const ref = (productId: string, variantId: string | null = null) => ({ productId, variantId });
  for (const branchId of [branchA, branchB]) {
    await inventory.recordOpeningBalances(owner, {
      branchId,
      lines: [
        { ref: ref(p1.id), qty: 50 },
        { ref: ref(p2.id), qty: 50 },
        { ref: ref(p3.id, v3.id), qty: 50 },
        { ref: ref(p4.id), qty: 50 },
      ],
    });
  }

  const t1 = tenant.register.id;
  const shift1 = await openShift(cashier, { branchId: branchA, registerId: t1, openingFloatMinor: 10_000 });
  const sell = async (lines: { ref: ReturnType<typeof ref>; qty: number }[], payments: unknown[]) =>
    (await createSale(cashier, { branchId: branchA, registerId: t1, lines, payments }, KEY())).sale;

  const s1 = await sell([{ ref: ref(p1.id), qty: 2 }], [{ method: "CASH", amountMinor: 30_000 }]);
  const s2 = await sell(
    [
      { ref: ref(p2.id), qty: 1 },
      { ref: ref(p4.id), qty: 1 },
    ],
    [{ method: "CARD_MANUAL", amountMinor: 6_000 }],
  );
  const s3 = await sell([{ ref: ref(p3.id, v3.id), qty: 1 }], [{ method: "WALLET", amountMinor: 2_280 }]);
  const s4 = await sell(
    [{ ref: ref(p1.id), qty: 1 }],
    [
      { method: "CARD_MANUAL", amountMinor: 5_000 },
      { method: "CASH", amountMinor: 10_000 },
    ],
  );
  const s5 = await sell([{ ref: ref(p2.id), qty: 1 }], [{ method: "CASH", amountMinor: 5_000 }]);
  await voidSale(manager, s5.id, { reason: "Wrong item" });

  const lineOf = async (saleId: string) => (await db.saleItem.findFirstOrThrow({ where: { saleId } })).id;
  const refund1 = await refundSale(manager, s1.id, KEY(), {
    lines: [{ saleItemId: await lineOf(s1.id), qty: 1 }],
    method: "CASH",
    reason: "Damaged",
  });

  await addCashMovement(cashier, shift1.id, { type: "PAY_IN", amountMinor: 2_000, reason: "Change float" });
  await addCashMovement(cashier, shift1.id, { type: "PAY_OUT", amountMinor: 1_500, reason: "Cleaning" });
  await addCashMovement(cashier, shift1.id, { type: "DROP", amountMinor: 5_000, reason: "Safe" });
  const closed = await closeShift(cashier, shift1.id, { countedCashMinor: 23_200, discrepancyNote: "Short" });

  const shift2 = await openShift(cashier, { branchId: branchA, registerId: t1, openingFloatMinor: 0 });
  const refund2 = await refundSale(manager, s3.id, KEY(), {
    lines: [{ saleItemId: await lineOf(s3.id), qty: 1 }],
    method: "WALLET",
    reference: "W-77",
    reason: "Changed mind",
  });
  const s6 = await sell([{ ref: ref(p2.id), qty: 1 }], [{ method: "CASH", amountMinor: 5_000 }]);
  const s7 = await sell([{ ref: ref(p2.id), qty: 1 }], [{ method: "CASH", amountMinor: 5_000 }]);

  // Branch B: its own till and one sale on D.
  const tB = await db.register.create({ data: { orgId, branchId: branchB, name: "Till B" } });
  const shiftB = await openShift(cashier, { branchId: branchB, registerId: tB.id, openingFloatMinor: 0 });
  const sB = (
    await createSale(
      cashier,
      {
        branchId: branchB,
        registerId: tB.id,
        lines: [{ ref: ref(p1.id), qty: 1 }],
        payments: [{ method: "CASH", amountMinor: 11_400 }],
      },
      KEY(),
    )
  ).sale;

  // Fixed times (UTC). Cairo is UTC+2 on these dates.
  await backdate(db, [
    ["RegisterShift", shift1.id, "openedAt", "2026-03-10T07:00:00Z"],
    ["RegisterShift", shift1.id, "closedAt", "2026-03-10T18:00:00Z"],
    ["RegisterShift", shift2.id, "openedAt", "2026-03-11T07:00:00Z"],
    ["RegisterShift", shiftB.id, "openedAt", "2026-03-10T07:00:00Z"],
    ["Sale", s1.id, "createdAt", "2026-03-10T08:00:00Z"],
    ["Sale", s2.id, "createdAt", "2026-03-10T09:00:00Z"],
    ["Sale", s3.id, "createdAt", "2026-03-10T10:00:00Z"],
    ["Sale", s4.id, "createdAt", "2026-03-10T11:00:00Z"],
    ["Sale", s5.id, "createdAt", "2026-03-10T12:00:00Z"],
    ["Sale", s5.id, "voidedAt", "2026-03-10T12:30:00Z"],
    ["Refund", refund1.refund.id, "createdAt", "2026-03-10T13:00:00Z"],
    ["Refund", refund2.refund.id, "createdAt", "2026-03-11T09:00:00Z"],
    ["Sale", s6.id, "createdAt", "2026-03-11T21:30:00Z"], // 23:30 Cairo on D+1
    ["Sale", s7.id, "createdAt", "2026-03-11T22:30:00Z"], // 00:30 Cairo on D+2
    ["Sale", sB.id, "createdAt", "2026-03-10T10:00:00Z"],
  ]);

  // Another org trading on the same day must never show up.
  const other = await createTenant(db, "Other");
  const otherOwner = await createMember(db, other.org.id, "OWNER");
  const otherProduct = await createProduct(db, other.org.id);
  await inventory.recordOpeningBalances(otherOwner, {
    branchId: other.branchA.id,
    lines: [{ ref: ref(otherProduct.id), qty: 5 }],
  });
  await openShift(otherOwner, { branchId: other.branchA.id, registerId: other.register.id, openingFloatMinor: 0 });
  const otherSale = (
    await createSale(
      otherOwner,
      {
        branchId: other.branchA.id,
        registerId: other.register.id,
        lines: [{ ref: ref(otherProduct.id), qty: 1 }],
        payments: [{ method: "CASH", amountMinor: 1_000 }],
      },
      KEY(),
    )
  ).sale;
  await backdate(db, [["Sale", otherSale.id, "createdAt", "2026-03-10T10:00:00Z"]]);

  return {
    orgId,
    branchA,
    branchB,
    owner,
    cashier,
    manager,
    category,
    products: { p1, p2, p3, v3, p4 },
    sales: { s1, s2, s3, s4, s5, s6, s7, sB },
    shift1: closed,
    shift2,
    otherOrgId: other.org.id,
  };
}

export type ReportsFixture = Awaited<ReturnType<typeof seedReportsFixture>>;

/** A member limited to the given branches (allBranches = false). */
export async function createScopedMember(
  db: Db,
  orgId: string,
  role: TenantContext["role"],
  branchIds: string[],
): Promise<TenantContext> {
  const ctx = await createMember(db, orgId, role);
  await db.membership.update({ where: { id: ctx.membershipId }, data: { allBranches: false } });
  for (const branchId of branchIds) {
    await db.membershipBranch.create({ data: { orgId, membershipId: ctx.membershipId, branchId } });
  }
  return ctx;
}
