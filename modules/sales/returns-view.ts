import "server-only";
import { hasPermission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import { normalizeDigits, type CurrencyCode } from "@/lib/money";
import { requireBranch } from "./access";

/**
 * Read model for the Returns screen (T8): one sale found by its receipt number, with what is
 * left to refund on each line and whether it can still be voided. UI gating only; refundSale
 * and voidSale re-check everything under their locks.
 */

export type ReturnLine = {
  saleItemId: string;
  sku: string;
  name: string;
  nameAr: string | null;
  qty: number;
  lineTotalMinor: number;
  refundedQty: number;
  refundedAmountMinor: number;
};

export type ReturnRefund = {
  id: string;
  method: "CASH" | "CARD_MANUAL" | "WALLET";
  totalMinor: number;
  reason: string;
  createdAt: string;
};

export type SaleForReturns = {
  id: string;
  number: string;
  status: "COMPLETED" | "VOIDED";
  currency: CurrencyCode;
  totalMinor: number;
  createdAt: string;
  registerName: string;
  voidReason: string | null;
  lines: ReturnLine[];
  refunds: ReturnRefund[];
  /** The sale's register has an open shift to book a refund on (V6). */
  registerHasOpenShift: boolean;
  /** COMPLETED, its shift still open, and no refunds yet (V7). */
  canVoid: boolean;
};

/** Receipt numbers are six digits; "123", "000123" and "١٢٣" all find sale 000123. Anything else is not a number. */
export function normalizeSaleNumber(raw: string): string | null {
  const digits = normalizeDigits(raw).trim();
  if (!/^\d{1,6}$/.test(digits)) return null;
  return digits.padStart(6, "0");
}

export async function getSaleForReturns(ctx: TenantContext, rawNumber: string): Promise<SaleForReturns> {
  if (!hasPermission(ctx.role, "sales.refund") && !hasPermission(ctx.role, "sales.void")) {
    throw forbidden("Missing permission for this action");
  }
  const number = normalizeSaleNumber(rawNumber);
  if (number === null) throw notFound("Sale");

  const db = getDb();
  const sale = await db.sale.findUnique({
    where: { orgId_number: { orgId: ctx.orgId, number } },
    include: {
      items: { orderBy: { id: "asc" } },
      register: { select: { name: true } },
      shift: { select: { status: true } },
      refunds: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!sale) throw notFound("Sale");
  await requireBranch(ctx, sale.branchId);

  const done = await db.refundItem.groupBy({
    by: ["saleItemId"],
    where: { orgId: ctx.orgId, saleItemId: { in: sale.items.map((item) => item.id) } },
    _sum: { qty: true, amountMinor: true },
  });
  const refunded = new Map(done.map((row) => [row.saleItemId, row._sum]));
  const openShift = await db.registerShift.findFirst({
    where: { orgId: ctx.orgId, registerId: sale.registerId, status: "OPEN" },
    select: { id: true },
  });

  return {
    id: sale.id,
    number: sale.number,
    status: sale.status,
    currency: sale.currency,
    totalMinor: sale.totalMinor,
    createdAt: sale.createdAt.toISOString(),
    registerName: sale.register.name,
    voidReason: sale.voidReason,
    lines: sale.items.map((item) => ({
      saleItemId: item.id,
      sku: item.skuSnapshot,
      name: item.nameSnapshot,
      nameAr: item.nameArSnapshot,
      qty: item.qty,
      lineTotalMinor: item.lineTotalMinor,
      refundedQty: refunded.get(item.id)?.qty ?? 0,
      refundedAmountMinor: refunded.get(item.id)?.amountMinor ?? 0,
    })),
    refunds: sale.refunds.map((refund) => ({
      id: refund.id,
      method: refund.method,
      totalMinor: refund.totalMinor,
      reason: refund.reason,
      createdAt: refund.createdAt.toISOString(),
    })),
    registerHasOpenShift: openShift !== null,
    canVoid: sale.status === "COMPLETED" && sale.shift.status === "OPEN" && sale.refunds.length === 0,
  };
}
