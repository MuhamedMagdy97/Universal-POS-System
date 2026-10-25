import "server-only";
import { hasPermission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { AppError, notFound } from "@/lib/errors";
import { MAX_STORABLE_MINOR } from "@/lib/money";
import { requireBranch, requirePermission, requireRegister, isUniqueViolation } from "@/modules/sales/access";
import { amountTooLarge, salesConflict } from "@/modules/sales/errors";
import { CashMovementInput, CloseShiftInput, OpenShiftInput } from "@/modules/sales/schemas";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { Uuid } from "@/modules/inventory/schemas";
import { zoneFor } from "@/modules/reports/timezone";

/**
 * Register shifts: open (T6, Q1), close and cash movements (T7). At most one OPEN shift per
 * register, backed by the partial unique index from the init migration. A closed shift is
 * immutable (business rule 9); corrections are new audit-logged entries.
 * See docs/planning/phase-8/shift-close-spec.md.
 */

type Tx = Prisma.TransactionClient;

export type ShiftSummary = {
  id: string;
  branchId: string;
  registerId: string;
  status: "OPEN" | "CLOSED";
  openingFloatMinor: number;
  openedAt: string;
};

export type ShiftCloseSummary = ShiftSummary & {
  closedAt: string;
  expectedCashMinor: number;
  countedCashMinor: number;
  discrepancyMinor: number;
  discrepancyNote: string | null;
};

export type CashMovementSummary = {
  id: string;
  shiftId: string;
  type: "PAY_IN" | "PAY_OUT" | "DROP";
  amountMinor: number;
  reason: string;
  createdAt: string;
};

/**
 * Row lock on the shift (`SELECT … FOR UPDATE`). Sales, cash movements and close all take it
 * first, so a close sums a cash ledger that no sale can still change (spec S3–S4).
 */
export async function lockShift(tx: Tx, orgId: string, shiftId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "RegisterShift" WHERE "orgId" = ${orgId}::uuid AND "id" = ${shiftId}::uuid FOR UPDATE`;
}

export async function openShift(ctx: TenantContext, input: unknown, meta?: AuditRequestMeta): Promise<ShiftSummary> {
  await requirePermission(ctx, "registers.open", { operation: "shift.open", entityType: "RegisterShift", meta });
  const parsed = OpenShiftInput.parse(input);
  await requireBranch(ctx, parsed.branchId);

  const db = getDb();
  try {
    return await db.$transaction(async (tx) => {
      // Shares the till row with a deactivation (org/branches.ts), so a till is never retired under a new shift.
      await tx.$queryRaw`SELECT "id" FROM "Register" WHERE "id" = ${parsed.registerId}::uuid FOR SHARE`;
      await requireRegister(tx, ctx.orgId, parsed.branchId, parsed.registerId);
      const open = await tx.registerShift.findFirst({
        where: { orgId: ctx.orgId, registerId: parsed.registerId, status: "OPEN" },
        select: { id: true },
      });
      if (open) throw salesConflict("SHIFT_ALREADY_OPEN", "This register already has an open shift");

      const shift = await tx.registerShift.create({
        data: {
          orgId: ctx.orgId,
          branchId: parsed.branchId,
          registerId: parsed.registerId,
          openedById: ctx.userId,
          openingFloatMinor: parsed.openingFloatMinor,
        },
      });
      await record(tx, {
        ctx,
        meta,
        action: "shift.opened",
        entityType: "RegisterShift",
        entityId: shift.id,
        metadata: { registerId: parsed.registerId, openingFloatMinor: parsed.openingFloatMinor },
      });
      return shiftSummary(shift);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw salesConflict("SHIFT_ALREADY_OPEN", "This register already has an open shift");
    throw err;
  }
}

/**
 * Closes a shift. The expected cash is computed here from the ledger (spec S1). A repeat close
 * with the same count and note returns the closed shift (200); any other close of a closed shift
 * is refused (409). Spec S7 uses state, not a stored key, so no column is needed.
 */
export async function closeShift(
  ctx: TenantContext,
  shiftId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<ShiftCloseSummary> {
  await requirePermission(ctx, "registers.close", { operation: "shift.close", entityType: "RegisterShift", meta });
  const parsed = CloseShiftInput.parse(input);
  await requireShiftInScope(ctx, shiftId);

  return getDb().$transaction(async (tx) => {
    await lockShift(tx, ctx.orgId, shiftId);
    const shift = await tx.registerShift.findFirst({ where: { id: shiftId, orgId: ctx.orgId } });
    if (!shift) throw notFound("Shift");

    if (shift.status === "CLOSED") {
      if (shift.countedCashMinor === parsed.countedCashMinor && shift.discrepancyNote === parsed.discrepancyNote) {
        return shiftCloseSummary(shift);
      }
      throw salesConflict("SHIFT_ALREADY_CLOSED", "This shift is already closed");
    }

    // OF14: the register's offline device last said it holds unsynced sales. The till itself refuses to close until
    // its queue is empty; a close from anywhere else goes ahead only with a typed note.
    const unsynced = await tx.registerDevice.findFirst({
      where: { orgId: ctx.orgId, registerId: shift.registerId, revokedAt: null, reportedQueued: { gt: 0 } },
      select: {
        reportedQueued: true,
        reportedOldestAt: true,
        reportedAt: true,
        register: { select: { offlineCode: true } },
      },
    });
    if (unsynced && parsed.unsyncedNote === null) {
      throw salesConflict("OFFLINE_SALES_UNSYNCED", "The register's offline device reported unsynced sales", {
        offlineCode: unsynced.register.offlineCode,
        queued: unsynced.reportedQueued,
        oldestAt: unsynced.reportedOldestAt?.toISOString() ?? null,
        reportedAt: unsynced.reportedAt?.toISOString() ?? null,
      });
    }

    const { expectedCashMinor } = await cashBreakdown(tx, ctx.orgId, shift.id, shift.openingFloatMinor);
    const discrepancyMinor = parsed.countedCashMinor - expectedCashMinor;
    if (discrepancyMinor !== 0 && parsed.discrepancyNote === null) {
      throw new AppError("VALIDATION_FAILED", "Add a note when the counted cash differs from the expected cash", {
        reason: "DISCREPANCY_NOTE_REQUIRED",
        discrepancyMinor,
      });
    }
    if (expectedCashMinor > MAX_STORABLE_MINOR || Math.abs(discrepancyMinor) > MAX_STORABLE_MINOR) {
      throw amountTooLarge("shift");
    }

    const closed = await tx.registerShift.update({
      where: { id: shift.id },
      data: {
        status: "CLOSED",
        closedById: ctx.userId,
        closedAt: new Date(),
        expectedCashMinor,
        countedCashMinor: parsed.countedCashMinor,
        discrepancyMinor,
        discrepancyNote: parsed.discrepancyNote,
      },
    });
    await record(tx, {
      ctx,
      meta,
      action: "shift.closed",
      entityType: "RegisterShift",
      entityId: shift.id,
      metadata: {
        registerId: shift.registerId,
        expectedCashMinor,
        countedCashMinor: parsed.countedCashMinor,
        discrepancyMinor,
        ...(unsynced ? { unsyncedOffline: { queued: unsynced.reportedQueued, note: parsed.unsyncedNote } } : {}),
      },
    });
    return shiftCloseSummary(closed);
  });
}

/** Records a pay-in, pay-out or drop on an open shift (spec S5). Pay-in needs sales.create; the others need registers.close. */
export async function addCashMovement(
  ctx: TenantContext,
  shiftId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<CashMovementSummary> {
  const parsed = CashMovementInput.parse(input);
  await requirePermission(ctx, parsed.type === "PAY_IN" ? "sales.create" : "registers.close", {
    operation: "shift.cash_movement",
    entityType: "RegisterShift",
    meta,
  });
  await requireShiftInScope(ctx, shiftId);

  return getDb().$transaction(async (tx) => {
    await lockShift(tx, ctx.orgId, shiftId);
    const shift = await tx.registerShift.findFirst({
      where: { id: shiftId, orgId: ctx.orgId },
      select: { status: true },
    });
    if (!shift) throw notFound("Shift");
    if (shift.status !== "OPEN") throw salesConflict("SHIFT_NOT_OPEN", "This shift is closed");

    const movement = await tx.cashMovement.create({
      data: {
        orgId: ctx.orgId,
        shiftId,
        type: parsed.type,
        amountMinor: parsed.amountMinor,
        reason: parsed.reason,
        actorUserId: ctx.userId,
      },
    });
    await record(tx, {
      ctx,
      meta,
      action: "shift.cash_movement",
      entityType: "RegisterShift",
      entityId: shiftId,
      metadata: { type: parsed.type, amountMinor: parsed.amountMinor },
    });
    return {
      id: movement.id,
      shiftId,
      type: parsed.type,
      amountMinor: movement.amountMinor,
      reason: movement.reason,
      createdAt: movement.createdAt.toISOString(),
    };
  });
}

export type CashBreakdown = {
  openingFloatMinor: number;
  cashSalesMinor: number;
  payInMinor: number;
  payOutMinor: number;
  dropMinor: number;
  cashRefundsMinor: number;
  expectedCashMinor: number;
};

/**
 * Expected drawer cash: opening float + applied cash on completed sales (change is excluded,
 * since a CASH payment row holds the applied amount) + pay-ins − pay-outs − drops − cash refunds
 * booked on this shift (T8, returns-void-spec.md V12). A voided sale drops out through its status.
 */
async function cashBreakdown(
  tx: Tx,
  orgId: string,
  shiftId: string,
  openingFloatMinor: number,
): Promise<CashBreakdown> {
  const cashSales = await tx.payment.aggregate({
    where: { orgId, method: "CASH", sale: { shiftId, status: "COMPLETED" } },
    _sum: { amountMinor: true },
  });
  const moves = await tx.cashMovement.groupBy({
    by: ["type"],
    where: { orgId, shiftId },
    _sum: { amountMinor: true },
  });
  const cashRefunds = await tx.refund.aggregate({
    where: { orgId, shiftId, method: "CASH" },
    _sum: { totalMinor: true },
  });
  const moved = (type: string) => moves.find((move) => move.type === type)?._sum.amountMinor ?? 0;
  const cashSalesMinor = cashSales._sum.amountMinor ?? 0;
  const payInMinor = moved("PAY_IN");
  const payOutMinor = moved("PAY_OUT");
  const dropMinor = moved("DROP");
  const cashRefundsMinor = cashRefunds._sum.totalMinor ?? 0;
  return {
    openingFloatMinor,
    cashSalesMinor,
    payInMinor,
    payOutMinor,
    dropMinor,
    cashRefundsMinor,
    expectedCashMinor: openingFloatMinor + cashSalesMinor + payInMinor - payOutMinor - dropMinor - cashRefundsMinor,
  };
}

/**
 * The count screen's preview of an open shift's expected cash (J4: expected is shown before the
 * count). Read-only, so it takes no lock; closeShift recomputes it under the lock.
 */
export async function previewShiftCash(ctx: TenantContext, shiftId: string): Promise<CashBreakdown> {
  await requirePermission(ctx, "registers.close", { operation: "shift.close", entityType: "RegisterShift" });
  await requireShiftInScope(ctx, shiftId);
  return getDb().$transaction(async (tx) => {
    const shift = await tx.registerShift.findFirst({
      where: { id: shiftId, orgId: ctx.orgId },
      select: { openingFloatMinor: true },
    });
    if (!shift) throw notFound("Shift");
    return cashBreakdown(tx, ctx.orgId, shiftId, shift.openingFloatMinor);
  });
}

/** Bad uuid, unknown id, other-tenant id and out-of-scope branch all answer 404 (as catalog `parseId`). */
async function requireShiftInScope(ctx: TenantContext, shiftId: string): Promise<void> {
  if (!Uuid.safeParse(shiftId).success) throw notFound("Shift");
  const shift = await getDb().registerShift.findFirst({
    where: { id: shiftId, orgId: ctx.orgId },
    select: { branchId: true },
  });
  if (!shift) throw notFound("Shift");
  await requireBranch(ctx, shift.branchId);
}

type ShiftRow = {
  id: string;
  branchId: string;
  registerId: string;
  status: "OPEN" | "CLOSED";
  openingFloatMinor: number;
  openedAt: Date;
};

function shiftSummary(shift: ShiftRow): ShiftSummary {
  return {
    id: shift.id,
    branchId: shift.branchId,
    registerId: shift.registerId,
    status: shift.status,
    openingFloatMinor: shift.openingFloatMinor,
    openedAt: shift.openedAt.toISOString(),
  };
}

type ClosedShiftRow = ShiftRow & {
  closedAt: Date | null;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  discrepancyMinor: number | null;
  discrepancyNote: string | null;
};

function shiftCloseSummary(shift: ClosedShiftRow): ShiftCloseSummary {
  return {
    ...shiftSummary(shift),
    closedAt: (shift.closedAt ?? new Date()).toISOString(),
    expectedCashMinor: shift.expectedCashMinor ?? 0,
    countedCashMinor: shift.countedCashMinor ?? 0,
    discrepancyMinor: shift.discrepancyMinor ?? 0,
    discrepancyNote: shift.discrepancyNote,
  };
}

/** A closed shift's Z-report for printing (T10 H9): the stored close plus the cash terms behind it. */
export type ZReport = CashBreakdown & {
  shiftId: string;
  registerName: string;
  branchName: string;
  currency: string;
  timeZone: string;
  openedAt: string;
  openedBy: string;
  closedAt: string;
  closedBy: string;
  countedCashMinor: number;
  discrepancyMinor: number;
  discrepancyNote: string | null;
  /** Offline sales that reached the server after the close (OF13): beside the stored close, never folded into it. */
  lateOfflineSales: number;
  lateOfflineCashMinor: number;
  correctedExpectedCashMinor: number;
  /** Service charge on the shift's sales less what its refunds gave back (restaurant-cafe-spec R11); 0 when none. */
  serviceChargeMinor: number;
};

/** Offline sales replayed into a shift after it closed (flag LATE_FOR_CLOSED_SHIFT): count and applied cash. */
async function lateOfflineCash(
  client: Tx,
  orgId: string,
  shiftId: string,
): Promise<{ count: number; cashMinor: number }> {
  const where = { orgId, shiftId, status: "COMPLETED" as const, offlineFlags: { has: "LATE_FOR_CLOSED_SHIFT" } };
  const [count, cash] = await Promise.all([
    client.sale.count({ where }),
    client.payment.aggregate({ where: { orgId, method: "CASH", sale: where }, _sum: { amountMinor: true } }),
  ]);
  return { count, cashMinor: cash._sum.amountMinor ?? 0 };
}

export async function getZReport(ctx: TenantContext, shiftId: string): Promise<ZReport> {
  // The till that closes it, or anyone who reads the Shifts report.
  if (!hasPermission(ctx.role, "reports.view")) {
    await requirePermission(ctx, "registers.close", { operation: "shift.zreport", entityType: "RegisterShift" });
  }
  await requireShiftInScope(ctx, shiftId);
  const db = getDb();
  const shift = await db.registerShift.findFirst({
    where: { id: shiftId, orgId: ctx.orgId, status: "CLOSED" },
    include: { register: { select: { name: true } }, branch: { select: { name: true } }, org: true },
  });
  if (!shift || !shift.closedAt || !shift.closedById) throw notFound("Shift");
  const [cash, late, users, charged, givenBack] = await Promise.all([
    db.$transaction((tx) => cashBreakdown(tx, ctx.orgId, shiftId, shift.openingFloatMinor)),
    lateOfflineCash(db, ctx.orgId, shiftId),
    db.user.findMany({ where: { id: { in: [shift.openedById, shift.closedById] } }, select: { id: true, name: true } }),
    db.sale.aggregate({
      where: { orgId: ctx.orgId, shiftId, status: "COMPLETED" },
      _sum: { serviceChargeMinor: true },
    }),
    db.refund.aggregate({ where: { orgId: ctx.orgId, shiftId }, _sum: { serviceChargeMinor: true } }),
  ]);
  const nameOf = (id: string) => users.find((user) => user.id === id)?.name ?? "";
  // The stored figure is the authority for a closed shift (as the Shifts report).
  const expectedCashMinor = shift.expectedCashMinor ?? cash.expectedCashMinor;
  return {
    ...cash,
    // Cash sales as at the close, so the terms still add up to the stored expected cash.
    cashSalesMinor: cash.cashSalesMinor - late.cashMinor,
    expectedCashMinor,
    lateOfflineSales: late.count,
    lateOfflineCashMinor: late.cashMinor,
    correctedExpectedCashMinor: expectedCashMinor + late.cashMinor,
    shiftId: shift.id,
    registerName: shift.register.name,
    branchName: shift.branch.name,
    currency: shift.org.currency,
    timeZone: zoneFor(shift.org.countryCode),
    openedAt: shift.openedAt.toISOString(),
    openedBy: nameOf(shift.openedById),
    closedAt: shift.closedAt.toISOString(),
    closedBy: nameOf(shift.closedById),
    countedCashMinor: shift.countedCashMinor ?? 0,
    discrepancyMinor: shift.discrepancyMinor ?? 0,
    discrepancyNote: shift.discrepancyNote,
    serviceChargeMinor: (charged._sum.serviceChargeMinor ?? 0) - (givenBack._sum.serviceChargeMinor ?? 0),
  };
}

/** True if a shift is open on the till, or on any till of the branch (onboarding O5: such a till or branch stays active). */
export async function hasOpenShift(
  client: Tx,
  orgId: string,
  where: { registerId: string } | { branchId: string },
): Promise<boolean> {
  const open = await client.registerShift.findFirst({
    where: { orgId, ...where, status: "OPEN" },
    select: { id: true },
  });
  return open !== null;
}
