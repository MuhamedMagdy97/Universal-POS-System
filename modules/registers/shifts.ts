import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { requireBranch, requirePermission, requireRegister, isUniqueViolation } from "@/modules/sales/access";
import { salesConflict } from "@/modules/sales/errors";
import { OpenShiftInput } from "@/modules/sales/schemas";
import { record, type AuditRequestMeta } from "@/modules/audit";

/**
 * Opens a shift on a register (Q1: open only; close and cash count are T7). At most one OPEN
 * shift per register, backed by the partial unique index from the init migration.
 */

export type ShiftSummary = {
  id: string;
  branchId: string;
  registerId: string;
  status: "OPEN" | "CLOSED";
  openingFloatMinor: number;
  openedAt: string;
};

export async function openShift(ctx: TenantContext, input: unknown, meta?: AuditRequestMeta): Promise<ShiftSummary> {
  await requirePermission(ctx, "registers.open", { operation: "shift.open", entityType: "RegisterShift", meta });
  const parsed = OpenShiftInput.parse(input);
  await requireBranch(ctx, parsed.branchId);

  const db = getDb();
  try {
    return await db.$transaction(async (tx) => {
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
      return {
        id: shift.id,
        branchId: shift.branchId,
        registerId: shift.registerId,
        status: shift.status,
        openingFloatMinor: shift.openingFloatMinor,
        openedAt: shift.openedAt.toISOString(),
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw salesConflict("SHIFT_ALREADY_OPEN", "This register already has an open shift");
    throw err;
  }
}
