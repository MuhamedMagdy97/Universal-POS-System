import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import type { ScaleSettings } from "@/lib/scale-label";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { requirePermission } from "./access";

/**
 * Scale labels (docs/planning/ui-refresh/weighed-selling-spec.md W6): every member reads them (the till parses
 * labels); only the Owner changes them (`shop.manage`), audited as `settings.scale_labels.updated`.
 */

export const ScaleSettingsInput = z.strictObject({
  enabled: z.boolean(),
  prefixes: z
    .array(z.string().regex(/^2\d$/))
    .min(1)
    .max(10)
    .refine((list) => new Set(list).size === list.length),
  itemDigits: z.int().min(4).max(6),
  valueKind: z.enum(["WEIGHT", "PRICE"]),
});

const SELECT = {
  scaleLabelsEnabled: true,
  scaleLabelPrefixes: true,
  scaleItemDigits: true,
  scaleValueKind: true,
} as const;

type Row = {
  scaleLabelsEnabled: boolean;
  scaleLabelPrefixes: string[];
  scaleItemDigits: number;
  scaleValueKind: "WEIGHT" | "PRICE";
};

const toSettings = (row: Row): ScaleSettings => ({
  enabled: row.scaleLabelsEnabled,
  prefixes: row.scaleLabelPrefixes,
  itemDigits: row.scaleItemDigits,
  valueKind: row.scaleValueKind,
});

export async function getScaleSettings(ctx: TenantContext): Promise<ScaleSettings> {
  return toSettings(await getDb().organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: SELECT }));
}

export async function updateScaleSettings(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<ScaleSettings> {
  await requirePermission(ctx, "shop.manage", {
    operation: "scale_labels.update",
    entityType: "Organization",
    entityId: ctx.orgId,
    meta,
  });
  const next = ScaleSettingsInput.parse(input);
  const prefixes = [...next.prefixes].sort();
  return getDb().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${ctx.orgId}::uuid FOR UPDATE`;
    const before = toSettings(await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: SELECT }));
    const after: ScaleSettings = { ...next, prefixes };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await tx.organization.update({
        where: { id: ctx.orgId },
        data: {
          scaleLabelsEnabled: after.enabled,
          scaleLabelPrefixes: prefixes,
          scaleItemDigits: after.itemDigits,
          scaleValueKind: after.valueKind,
        },
      });
      await record(tx, {
        ctx,
        meta,
        action: "settings.scale_labels.updated",
        entityType: "Organization",
        entityId: ctx.orgId,
        metadata: { from: before, to: after },
      });
    }
    return after;
  });
}
