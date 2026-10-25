import "server-only";
import { hasPermission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import { normalizeDigits, type CurrencyCode } from "@/lib/money";
import { requireBranch } from "./access";
import type { OptionSnapshot } from "./options";
import { optionsOf } from "./receipt";

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
  /** Pieces, or grams for a KG line (weighed-selling-spec W8). */
  qty: number;
  unitType: "EACH" | "KG";
  /** Options as sold and the line note, so two lines of one item can be told apart (restaurant-cafe-spec R9). */
  options: OptionSnapshot[];
  note: string | null;
  /** What the line was discounted at the sale; `lineTotalMinor` is already the paid amount (discounts-spec DC13). */
  discountMinor: number;
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
  /** Active tills in the sale's branch that can pay out a refund, the sale's own till first. */
  registers: { id: string; name: string; hasOpenShift: boolean }[];
  /** The sale's own till. */
  registerId: string;
  /** COMPLETED, its shift still open, and no refunds yet (V7). */
  canVoid: boolean;
};

/**
 * Receipt numbers are six digits; "123", "000123" and "١٢٣" all find sale 000123. Offline sales carry their
 * register's series (offline till slice 1): "t1-45" and "T1-000045" both find T1-000045. Anything else is not a number.
 */
export function normalizeSaleNumber(raw: string): string | null {
  const value = normalizeDigits(raw).trim().toUpperCase();
  if (/^\d{1,6}$/.test(value)) return value.padStart(6, "0");
  const offline = /^([A-Z][A-Z0-9]{0,7})-(\d{1,6})$/.exec(value);
  return offline ? `${offline[1]}-${offline[2].padStart(6, "0")}` : null;
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
  const tills = await db.register.findMany({
    where: { orgId: ctx.orgId, branchId: sale.branchId, isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, shifts: { where: { status: "OPEN" }, select: { id: true } } },
  });
  const registers = tills
    .map((till) => ({ id: till.id, name: till.name, hasOpenShift: till.shifts.length > 0 }))
    .sort((x, y) => Number(y.id === sale.registerId) - Number(x.id === sale.registerId));

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
      unitType: item.unitType,
      options: optionsOf(item.options),
      note: item.note,
      discountMinor: item.discountMinor,
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
    registerHasOpenShift: registers.some((till) => till.id === sale.registerId && till.hasOpenShift),
    registers,
    registerId: sale.registerId,
    canVoid: sale.status === "COMPLETED" && sale.shift.status === "OPEN" && sale.refunds.length === 0,
  };
}
