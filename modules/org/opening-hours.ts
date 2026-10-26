import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { requirePermission } from "./access";

/**
 * Opening hours for the appointment calendar (docs/planning/ui-refresh/salon-spec.md S6), minutes after local
 * midnight; 09:00-21:00 by default. Every member reads them; the Owner changes them (`shop.manage`), audited as
 * `settings.opening_hours.updated`.
 */

export const OpeningHoursInput = z
  .strictObject({ opensAt: z.int().min(0).max(1_439), closesAt: z.int().min(1).max(1_440) })
  .refine((hours) => hours.opensAt < hours.closesAt, { message: "Closing must be after opening", path: ["closesAt"] });

export type OpeningHours = { opensAt: number; closesAt: number };

export async function getOpeningHours(ctx: TenantContext): Promise<OpeningHours> {
  return getDb().organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { opensAt: true, closesAt: true },
  });
}

export async function updateOpeningHours(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<OpeningHours> {
  await requirePermission(ctx, "shop.manage", {
    operation: "opening_hours.update",
    entityType: "Organization",
    entityId: ctx.orgId,
    meta,
  });
  const next = OpeningHoursInput.parse(input);
  return getDb().$transaction(async (tx) => {
    const [before] = await tx.$queryRaw<OpeningHours[]>`
      SELECT "opensAt", "closesAt" FROM "Organization" WHERE "id" = ${ctx.orgId}::uuid FOR UPDATE`;
    if (before.opensAt !== next.opensAt || before.closesAt !== next.closesAt) {
      await tx.organization.update({ where: { id: ctx.orgId }, data: next });
      await record(tx, {
        ctx,
        meta,
        action: "settings.opening_hours.updated",
        entityType: "Organization",
        entityId: ctx.orgId,
        metadata: { from: before, to: next },
      });
    }
    return next;
  });
}
