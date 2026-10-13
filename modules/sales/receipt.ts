import "server-only";
import { hasPermission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import type { CurrencyCode } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { Uuid } from "@/modules/inventory/schemas";
import { zoneFor } from "@/modules/reports/timezone";
import { requireBranch } from "./access";

/**
 * Printable receipt for a sale, one of its refunds, or its void (T10 H2, H4). Built on the server
 * from the stored snapshots and the shop's receipt fields, so a reprint matches the original.
 */

export type ReceiptKind = "SALE" | "REFUND" | "VOID";

export type ReceiptShop = {
  name: string;
  branchName: string;
  address: string | null;
  phone: string | null;
  taxNumber: string | null;
  header: string | null;
  footer: string | null;
};

export type ReceiptDoc = {
  kind: ReceiptKind;
  /** A reprint: printed with a "Copy" mark (H4). */
  copy: boolean;
  shop: ReceiptShop;
  saleNumber: string;
  currency: CurrencyCode;
  /** When the sale, refund or void happened. */
  at: string;
  timeZone: string;
  staffName: string;
  registerName: string;
  /** Refund or void reason. */
  reason: string | null;
  lines: { name: string; nameAr: string | null; qty: number; lineTotalMinor: number }[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  vatRatesBp: number[];
  payments: { method: string; amountMinor: number }[];
  changeMinor: number;
};

export type ReceiptRequest = { kind: ReceiptKind; refundId?: string; copy: boolean };

export async function getReceipt(
  ctx: TenantContext,
  saleId: string,
  request: ReceiptRequest,
  meta?: AuditRequestMeta,
): Promise<ReceiptDoc> {
  if (!Uuid.safeParse(saleId).success) throw notFound("Sale");
  const db = getDb();
  const sale = await db.sale.findFirst({
    where: { id: saleId, orgId: ctx.orgId },
    include: {
      items: { orderBy: { id: "asc" } },
      payments: { orderBy: { id: "asc" } },
      register: { select: { name: true } },
      branch: { select: { name: true, address: true } },
      org: true,
    },
  });
  if (!sale) throw notFound("Sale");
  await requireBranch(ctx, sale.branchId);
  const mayRead =
    hasPermission(ctx.role, "sales.refund") || hasPermission(ctx.role, "sales.void") || sale.cashierId === ctx.userId;
  if (!mayRead) throw forbidden("Missing permission for this action");

  const { org } = sale;
  const shop: ReceiptShop = {
    name: org.legalName ?? org.name,
    branchName: sale.branch.name,
    address: org.receiptAddress ?? sale.branch.address,
    phone: org.receiptPhone,
    taxNumber: org.taxNumber,
    header: org.receiptHeader,
    footer: org.receiptFooter,
  };
  const base = {
    kind: request.kind,
    copy: request.copy,
    shop,
    saleNumber: sale.number,
    currency: sale.currency,
    timeZone: zoneFor(org.countryCode),
    registerName: sale.register.name,
  };
  const saleLines = sale.items.map((item) => ({
    name: item.nameSnapshot,
    nameAr: item.nameArSnapshot,
    qty: item.qty,
    lineTotalMinor: item.lineTotalMinor,
  }));
  const rates = (bps: number[]) => [...new Set(bps)].sort((a, b) => a - b);

  let doc: ReceiptDoc;
  if (request.kind === "REFUND") {
    if (!request.refundId || !Uuid.safeParse(request.refundId).success) throw notFound("Refund");
    const refund = await db.refund.findFirst({
      where: { id: request.refundId, orgId: ctx.orgId, saleId: sale.id },
      include: { items: { orderBy: { id: "asc" } } },
    });
    if (!refund) throw notFound("Refund");
    const byId = new Map(sale.items.map((item) => [item.id, item]));
    const lines = refund.items.map((item) => {
      const source = byId.get(item.saleItemId);
      return {
        name: source?.nameSnapshot ?? "",
        nameAr: source?.nameArSnapshot ?? null,
        qty: item.qty,
        lineTotalMinor: item.amountMinor,
      };
    });
    doc = {
      ...base,
      at: refund.createdAt.toISOString(),
      staffName: await userName(refund.processedById),
      reason: refund.reason,
      lines,
      subtotalMinor: refund.totalMinor - refund.vatMinor,
      vatMinor: refund.vatMinor,
      totalMinor: refund.totalMinor,
      vatRatesBp: rates(refund.items.map((item) => byId.get(item.saleItemId)?.vatRateBp ?? 0)),
      payments: [{ method: refund.method, amountMinor: refund.totalMinor }],
      changeMinor: 0,
    };
  } else {
    const isVoid = request.kind === "VOID";
    if (isVoid && (sale.status !== "VOIDED" || !sale.voidedAt || !sale.voidedById)) throw notFound("Void");
    doc = {
      ...base,
      at: ((isVoid ? sale.voidedAt : null) ?? sale.createdAt).toISOString(),
      staffName: await userName((isVoid ? sale.voidedById : null) ?? sale.cashierId),
      reason: isVoid ? sale.voidReason : null,
      lines: saleLines,
      subtotalMinor: sale.subtotalMinor,
      vatMinor: sale.vatMinor,
      totalMinor: sale.totalMinor,
      vatRatesBp: rates(sale.items.map((item) => item.vatRateBp)),
      payments: sale.payments.map((payment) => ({ method: payment.method, amountMinor: payment.amountMinor })),
      changeMinor: sale.changeMinor,
    };
  }

  if (request.copy) {
    await record(db, {
      ctx,
      meta,
      action: "sale.receipt.reprinted",
      entityType: "Sale",
      entityId: sale.id,
      metadata: { kind: request.kind, refundId: request.refundId ?? null, number: sale.number },
    });
  }
  return doc;
}

async function userName(userId: string): Promise<string> {
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name ?? "";
}
