import "server-only";
import type { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { t, toLocale } from "@/lib/i18n";
import type { AuditRequestMeta } from "@/modules/audit";
import { record } from "@/modules/audit";
import { toCsv } from "@/modules/reports";
import { inventorySourceOf } from "@/modules/integrations/inventory-sys/source";
import { requireBranch, requirePermission } from "./access";
import { assertKnownItems } from "./ledger";
import { keyOf, lockBalances } from "./locking";
import { LowStockQuery, ReorderPointInput } from "./schemas";

/** Reorder points and the low-stock list (docs/planning/low-stock/low-stock-spec.md). */

export type LowStockRow = {
  productId: string;
  variantId: string | null;
  name: string;
  nameAr: string | null;
  variantName: string | null;
  sku: string;
  qty: number;
  reorderPoint: number;
  archived: boolean;
};

/** The list is a working list, not a report: past this many rows it is truncated (L8). */
export const LOW_STOCK_CAP = 1000;

/**
 * Sets (or clears, with null) the reorder point of one item at one branch (L1–L6). The balance
 * row is created on demand by the same lock path as stock writes, so qty 0 stays reconciled.
 * The raw UPDATE leaves `updatedAt` alone: it means "last stock change" on the stock list.
 */
export async function setReorderPoint(
  ctx: TenantContext,
  input: z.input<typeof ReorderPointInput>,
  meta?: AuditRequestMeta,
): Promise<{ reorderPoint: number | null }> {
  await requirePermission(ctx, "inventory.adjust", { operation: "reorderPoint", entityType: "StockBalance", meta });
  const parsed = ReorderPointInput.parse(input);
  await requireBranch(ctx, parsed.branchId);

  return getDb().$transaction(async (tx) => {
    const key = { branchId: parsed.branchId, ...parsed.ref };
    await assertKnownItems(tx, ctx.orgId, [parsed.ref]);
    const locked = await lockBalances(tx, ctx.orgId, [key]);
    const balance = locked.get(keyOf(key));
    if (!balance) throw new Error("balance row missing after lock");

    const [current] = await tx.$queryRaw<{ reorderPoint: number | null }[]>`
      SELECT "reorderPoint" FROM "StockBalance" WHERE id = ${balance.id}::uuid AND "orgId" = ${ctx.orgId}::uuid`;
    const before = current?.reorderPoint ?? null;
    if (before === parsed.reorderPoint) return { reorderPoint: before };

    await tx.$executeRaw`
      UPDATE "StockBalance" SET "reorderPoint" = ${parsed.reorderPoint}
      WHERE id = ${balance.id}::uuid AND "orgId" = ${ctx.orgId}::uuid`;
    await record(tx, {
      ctx,
      meta,
      action: "inventory.reorder_point.set",
      entityType: "StockBalance",
      entityId: balance.id,
      metadata: { branchId: parsed.branchId, ref: parsed.ref, before, after: parsed.reorderPoint },
    });
    return { reorderPoint: parsed.reorderPoint };
  });
}

/** Low items at one branch (L3, L7): tracked, at or below the point, active or still holding stock. */
function lowStockFrom(orgId: string, branchId: string): Prisma.Sql {
  return Prisma.sql`
    FROM "StockBalance" b
    JOIN "Product" p ON p."orgId" = b."orgId" AND p.id = b."productId"
    LEFT JOIN "ProductVariant" v ON v."orgId" = b."orgId" AND v.id = b."variantId"
    WHERE b."orgId" = ${orgId}::uuid AND b."branchId" = ${branchId}::uuid
      AND b."reorderPoint" IS NOT NULL AND b.qty <= b."reorderPoint"
      AND p."hasVariants" = (b."variantId" IS NOT NULL)
      AND ((p."isActive" AND COALESCE(v."isActive", TRUE)) OR b.qty <> 0)`;
}

export async function listLowStock(
  ctx: TenantContext,
  query: LowStockQuery,
): Promise<{ rows: LowStockRow[]; truncated: boolean }> {
  await requirePermission(ctx, "inventory.read");
  const { branchId } = LowStockQuery.parse(query);
  await requireBranch(ctx, branchId);
  // A linked shop's POS stock is history only (integration spec I18): nothing is low here.
  if ((await inventorySourceOf(ctx.orgId)) === "EXTERNAL") return { rows: [], truncated: false };

  const rows = await getDb().$queryRaw<LowStockRow[]>`
    SELECT b."productId", b."variantId", p.name, p."nameAr", v.name AS "variantName",
           COALESCE(v.sku, p.sku) AS sku, b.qty, b."reorderPoint",
           NOT (p."isActive" AND COALESCE(v."isActive", TRUE)) AS archived
    ${lowStockFrom(ctx.orgId, branchId)}
    ORDER BY b."reorderPoint" - b.qty DESC, p.name, b."productId", COALESCE(b."variantId"::text, '')
    LIMIT ${LOW_STOCK_CAP + 1}`;
  return { rows: rows.slice(0, LOW_STOCK_CAP), truncated: rows.length > LOW_STOCK_CAP };
}

/** Count for the dashboard tile (L9). */
export async function countLowStock(ctx: TenantContext, branchId: string): Promise<number> {
  await requirePermission(ctx, "inventory.read");
  LowStockQuery.parse({ branchId });
  await requireBranch(ctx, branchId);
  if ((await inventorySourceOf(ctx.orgId)) === "EXTERNAL") return 0;
  const [row] = await getDb().$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count ${lowStockFrom(ctx.orgId, branchId)}`;
  return row?.count ?? 0;
}

/** CSV of the low-stock list (BOM, CRLF, formula-safe), audit-logged like report exports. */
export async function exportLowStockCsv(
  ctx: TenantContext,
  query: LowStockQuery,
  rawLocale: unknown,
  meta?: AuditRequestMeta,
): Promise<{ filename: string; body: string }> {
  const { rows } = await listLowStock(ctx, query);
  const locale = toLocale(rawLocale);
  const body = toCsv(
    [
      t(locale, "inventory.column.item"),
      t(locale, "inventory.column.sku"),
      t(locale, "inventory.column.onHand"),
      t(locale, "inventory.column.reorderPoint"),
      t(locale, "inventory.column.shortfall"),
    ],
    rows.map((row) => {
      const name = locale === "ar" && row.nameAr ? row.nameAr : row.name;
      return [
        row.variantName ? `${name} — ${row.variantName}` : name,
        row.sku,
        row.qty,
        row.reorderPoint,
        row.reorderPoint - row.qty,
      ];
    }),
  );
  await record(getDb(), {
    ctx,
    meta,
    action: "inventory.low_stock.exported",
    entityType: "StockBalance",
    metadata: { branchId: query.branchId, rows: rows.length },
  });
  return { filename: `low-stock_${query.branchId}.csv`, body };
}
