import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { isSaudiVatNumber } from "@/modules/sales/zatca";
import { requirePermission } from "./access";

/**
 * The six receipt fields on `Organization` (T10 H3), the cashier discount limit (discounts-spec DC8) and whether a
 * sale or purchase return may take built-in stock below zero (`blockNegativeStock`).
 * `settings.manage` reads and writes them. A Saudi shop's VAT number must be a valid one: it goes in the ZATCA QR
 * (zatca-phase1-spec Z2).
 */

const Text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value));

export const ReceiptSettingsInput = z
  .object({
    legalName: Text(120),
    taxNumber: Text(40),
    receiptAddress: Text(200),
    receiptPhone: Text(40),
    receiptHeader: Text(200),
    receiptFooter: Text(200),
    maxCashierDiscountBp: z.number().int().min(0).max(10_000),
    blockNegativeStock: z.boolean(),
  })
  .partial()
  .strict();

export type ReceiptSettings = {
  name: string;
  legalName: string | null;
  taxNumber: string | null;
  receiptAddress: string | null;
  receiptPhone: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  maxCashierDiscountBp: number;
  blockNegativeStock: boolean;
  countryCode: string;
};

const SELECT = {
  name: true,
  legalName: true,
  taxNumber: true,
  receiptAddress: true,
  receiptPhone: true,
  receiptHeader: true,
  receiptFooter: true,
  maxCashierDiscountBp: true,
  blockNegativeStock: true,
  countryCode: true,
} as const;

function requireSettings(ctx: TenantContext, operation: string, meta?: AuditRequestMeta): Promise<void> {
  return requirePermission(ctx, "settings.manage", {
    operation,
    entityType: "Organization",
    entityId: ctx.orgId,
    meta,
  });
}

export async function getReceiptSettings(ctx: TenantContext): Promise<ReceiptSettings> {
  await requireSettings(ctx, "receipt.read");
  return getDb().organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: SELECT });
}

export async function updateReceiptSettings(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<ReceiptSettings> {
  await requireSettings(ctx, "receipt.update", meta);
  const patch = ReceiptSettingsInput.parse(input);
  return getDb().$transaction(async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: SELECT });
    if (before.countryCode === "SA" && patch.taxNumber && !isSaudiVatNumber(patch.taxNumber)) {
      throw new AppError("VALIDATION_FAILED", "Enter a 15-digit VAT number that starts and ends with 3", {
        reason: "INVALID_VAT_NUMBER",
      });
    }
    const after = await tx.organization.update({ where: { id: ctx.orgId }, data: patch, select: SELECT });
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((key) => before[key] !== after[key]);
    if (changed.length > 0) {
      await record(tx, {
        ctx,
        meta,
        action: "settings.receipt.updated",
        entityType: "Organization",
        entityId: ctx.orgId,
        metadata: Object.fromEntries(changed.map((key) => [key, { from: before[key], to: after[key] }])),
      });
    }
    return after;
  });
}
