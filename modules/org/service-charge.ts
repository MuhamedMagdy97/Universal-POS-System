import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { requirePermission } from "./access";

/**
 * The service charge on dine-in orders (docs/planning/ui-refresh/restaurant-cafe-spec.md R11): a percent in basis
 * points, 0 = off (the default). Every member reads it (the till); only the Owner changes it (`shop.manage`),
 * audited as `settings.service_charge.updated`.
 */

export const ServiceChargeInput = z.strictObject({ serviceChargeBp: z.int().min(0).max(2_500) });

export async function getServiceCharge(ctx: TenantContext): Promise<{ serviceChargeBp: number }> {
  return getDb().organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { serviceChargeBp: true } });
}

export async function updateServiceCharge(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<{ serviceChargeBp: number }> {
  await requirePermission(ctx, "shop.manage", {
    operation: "service_charge.update",
    entityType: "Organization",
    entityId: ctx.orgId,
    meta,
  });
  const { serviceChargeBp } = ServiceChargeInput.parse(input);
  return getDb().$transaction(async (tx) => {
    const [org] = await tx.$queryRaw<{ serviceChargeBp: number }[]>`
      SELECT "serviceChargeBp" FROM "Organization" WHERE "id" = ${ctx.orgId}::uuid FOR UPDATE`;
    if (org.serviceChargeBp !== serviceChargeBp) {
      await tx.organization.update({ where: { id: ctx.orgId }, data: { serviceChargeBp } });
      await record(tx, {
        ctx,
        meta,
        action: "settings.service_charge.updated",
        entityType: "Organization",
        entityId: ctx.orgId,
        metadata: { serviceChargeBp: { from: org.serviceChargeBp, to: serviceChargeBp } },
      });
    }
    return { serviceChargeBp };
  });
}
