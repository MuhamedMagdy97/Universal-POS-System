import "server-only";
import { cache } from "react";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { BUSINESS_TYPE_IDS, type BusinessTypeId } from "@/modules/presets";
import { requirePermission } from "./access";

/**
 * The shop's business type (docs/planning/ui-refresh/business-profiles-spec.md BP3). Every member reads it (it picks
 * the accent, the till layout and the dashboard); only the Owner changes it (`shop.manage`). Changing it changes the
 * view only: products, stock, sales and reports stay as they are.
 */

export const BusinessTypeInput = z.strictObject({ businessType: z.enum(BUSINESS_TYPE_IDS) });

/** One read per request for the layout, dashboard and till (React `cache`). */
export const orgBusinessType = cache(async (orgId: string): Promise<BusinessTypeId> => {
  const org = await getDb().organization.findUniqueOrThrow({ where: { id: orgId }, select: { businessType: true } });
  return org.businessType;
});

export function getBusinessType(ctx: TenantContext): Promise<BusinessTypeId> {
  return orgBusinessType(ctx.orgId);
}

export async function updateBusinessType(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<{ businessType: BusinessTypeId }> {
  await requirePermission(ctx, "shop.manage", {
    operation: "business_type.update",
    entityType: "Organization",
    entityId: ctx.orgId,
    meta,
  });
  const { businessType } = BusinessTypeInput.parse(input);
  return getDb().$transaction(async (tx) => {
    const [org] = await tx.$queryRaw<{ businessType: BusinessTypeId }[]>`
      SELECT "businessType" FROM "Organization" WHERE "id" = ${ctx.orgId}::uuid FOR UPDATE`;
    if (org.businessType !== businessType) {
      await tx.organization.update({ where: { id: ctx.orgId }, data: { businessType } });
      await record(tx, {
        ctx,
        meta,
        action: "settings.business_type.updated",
        entityType: "Organization",
        entityId: ctx.orgId,
        metadata: { businessType: { from: org.businessType, to: businessType } },
      });
    }
    return { businessType };
  });
}
