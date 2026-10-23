import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { Uuid } from "@/modules/inventory/schemas";
import { branchesInScope, decodeAuditCursor, encodeAuditCursor, reportSettings } from "@/modules/reports";
import { requireBranch, requirePermission } from "./access";

/**
 * "Offline sales to review" (offline-till-spec OF13, slice 4): offline sales that carry review flags, newest
 * received first, 50 per page, in the caller's branches. The details come from the `sale.offline.flagged` audit
 * rows written at replay. Marking a sale reviewed appends a `sale.offline.reviewed` audit row (sales are
 * append-only), which takes it off the list.
 */

export const REVIEW_PAGE_SIZE = 50;

export type OfflineReviewRow = {
  saleId: string;
  number: string;
  status: "COMPLETED" | "VOIDED";
  branchName: string;
  registerName: string;
  cashierName: string | null;
  soldAt: Date;
  receivedAt: Date;
  currency: string;
  totalMinor: number;
  /** Cash applied to the sale: what it adds to the drawer (OF13 "cash effect"). */
  cashMinor: number;
  shift: { id: string; openedAt: Date; closedAt: Date | null };
  items: { sku: string; name: string; nameAr: string | null; qty: number }[];
  /** One entry per flag, with what the replay recorded (`{ number, flag, ...details }` minus number and flag). */
  flags: { flag: string; details: Record<string, unknown> }[];
};

export type OfflineReviewPage = { rows: OfflineReviewRow[]; nextCursor: string | null; timezone: string };

const REVIEWED = "sale.offline.reviewed";

export async function listOfflineReview(
  ctx: TenantContext,
  query: { cursor?: string } = {},
  meta?: AuditRequestMeta,
): Promise<OfflineReviewPage> {
  await requirePermission(ctx, "sales.review", { operation: "sale.offline.list", entityType: "Sale", meta });
  const cursor = query.cursor === undefined ? null : decodeAuditCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    throw new AppError("VALIDATION_FAILED", "Invalid cursor", { reason: "INVALID_CURSOR" });
  }
  const [branches, { zone }] = await Promise.all([branchesInScope(ctx), reportSettings(ctx.orgId)]);
  const branchIds = branches.map((branch) => branch.id);
  const db = getDb();
  // ponytail: no index on offlineFlags; scans the org's sales in scope. Add a partial index if it ever shows up.
  const page = await db.$queryRaw<{ id: string; receivedAt: Date }[]>`
    SELECT s."id", s."receivedAt" FROM "Sale" s
     WHERE s."orgId" = ${ctx.orgId}::uuid AND s."branchId" = ANY(${branchIds}::uuid[])
       AND cardinality(s."offlineFlags") > 0
       AND NOT EXISTS (SELECT 1 FROM "AuditEvent" a
                        WHERE a."orgId" = s."orgId" AND a."entityType" = 'Sale' AND a."entityId" = s."id"::text
                          AND a."action" = ${REVIEWED})
       ${
         cursor
           ? Prisma.sql`AND (s."receivedAt", s."id") < ((${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id}::uuid)`
           : Prisma.empty
       }
     ORDER BY s."receivedAt" DESC, s."id" DESC
     LIMIT ${REVIEW_PAGE_SIZE + 1}`;
  const ids = page.slice(0, REVIEW_PAGE_SIZE).map((row) => row.id);
  const last = page[REVIEW_PAGE_SIZE - 1];
  const nextCursor =
    page.length > REVIEW_PAGE_SIZE && last
      ? encodeAuditCursor({ at: last.receivedAt.toISOString(), id: last.id })
      : null;

  const [sales, flagged] = await Promise.all([
    db.sale.findMany({
      where: { orgId: ctx.orgId, id: { in: ids } },
      select: {
        id: true,
        number: true,
        status: true,
        cashierId: true,
        createdAt: true,
        receivedAt: true,
        currency: true,
        totalMinor: true,
        branch: { select: { name: true } },
        register: { select: { name: true } },
        shift: { select: { id: true, openedAt: true, closedAt: true } },
        items: { select: { skuSnapshot: true, nameSnapshot: true, nameArSnapshot: true, qty: true } },
        payments: { where: { method: "CASH" }, select: { amountMinor: true } },
      },
    }),
    db.auditEvent.findMany({
      where: { orgId: ctx.orgId, action: "sale.offline.flagged", entityType: "Sale", entityId: { in: ids } },
      select: { entityId: true, metadata: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const users = await db.user.findMany({
    where: { id: { in: sales.map((sale) => sale.cashierId) } },
    select: { id: true, name: true },
  });

  const rows = ids.flatMap((id): OfflineReviewRow[] => {
    const sale = sales.find((s) => s.id === id);
    if (!sale) return [];
    return [
      {
        saleId: sale.id,
        number: sale.number,
        status: sale.status,
        branchName: sale.branch.name,
        registerName: sale.register.name,
        cashierName: users.find((user) => user.id === sale.cashierId)?.name ?? null,
        soldAt: sale.createdAt,
        receivedAt: sale.receivedAt ?? sale.createdAt,
        currency: sale.currency,
        totalMinor: sale.totalMinor,
        cashMinor: sale.payments.reduce((total, payment) => total + payment.amountMinor, 0),
        shift: sale.shift,
        items: sale.items.map((item) => ({
          sku: item.skuSnapshot,
          name: item.nameSnapshot,
          nameAr: item.nameArSnapshot,
          qty: item.qty,
        })),
        flags: flagged
          .filter((row) => row.entityId === id)
          .map((row) => {
            const { flag, number: _number, ...details } = row.metadata as Record<string, unknown>;
            return { flag: String(flag), details };
          }),
      },
    ];
  });
  return { rows, nextCursor, timezone: zone };
}

/** Takes a flagged offline sale off the review list. Repeating it is a no-op. */
export async function markOfflineSaleReviewed(
  ctx: TenantContext,
  saleId: string,
  meta?: AuditRequestMeta,
): Promise<void> {
  await requirePermission(ctx, "sales.review", { operation: "sale.offline.review", entityType: "Sale", meta });
  if (!Uuid.safeParse(saleId).success) throw notFound("Sale");
  await getDb().$transaction(async (tx) => {
    // The row lock serialises two managers reviewing the same sale (a lock fires no Sale_guard trigger).
    const [sale] = await tx.$queryRaw<{ branchId: string; number: string; offlineFlags: string[] }[]>`
      SELECT "branchId", "number", "offlineFlags" FROM "Sale"
       WHERE "id" = ${saleId}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
    if (!sale || sale.offlineFlags.length === 0) throw notFound("Sale");
    await requireBranch(ctx, sale.branchId);
    const done = await tx.auditEvent.findFirst({
      where: { orgId: ctx.orgId, action: REVIEWED, entityType: "Sale", entityId: saleId },
      select: { id: true },
    });
    if (done) return;
    await record(tx, {
      ctx,
      meta,
      action: REVIEWED,
      entityType: "Sale",
      entityId: saleId,
      metadata: { number: sale.number, flags: sale.offlineFlags },
    });
  });
}
