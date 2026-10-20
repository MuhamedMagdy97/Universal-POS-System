import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { Prisma } from "@/lib/generated/prisma/client";
import { requireBranch, requirePermission } from "./access";
import { invalidInput } from "./errors";
import { LedgerQuery, StockQuery, Uuid } from "./schemas";

/** Read-only stock views (inventory.read). Cost is never selected (I-18). */

export type StockRow = {
  productId: string;
  variantId: string | null;
  name: string;
  nameAr: string | null;
  variantName: string | null;
  sku: string;
  primaryBarcode: string | null;
  qty: number;
  /** Reorder point at this branch; null = not tracked (low-stock-spec L1). */
  reorderPoint: number | null;
  /** Sent to this branch and not received yet; never part of qty (transit-transfers-spec T8). */
  incoming: number;
  archived: boolean;
  updatedAt: Date | null;
};

export type StockPage = { rows: StockRow[]; nextCursor: string | null };

const StockCursor = z.object({ n: z.string(), p: Uuid, v: z.string() }).strict();
// `t` must be a real timestamp: a forged value would otherwise reach SQL as an invalid date (500).
const LedgerCursor = z.object({ t: z.iso.datetime(), i: Uuid }).strict();

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode<S extends z.ZodType>(schema: S, cursor: string): z.infer<S> {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw invalidInput("INVALID_CURSOR", "The page cursor is not valid");
  }
}

/** Escapes LIKE wildcards so a typed `%` or `_` matches itself. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Stock list at one branch: one row per stockable item (a product without variants, or each
 * active variant), including archived items that still hold stock. Keyset-paged by
 * (name, productId, variantId with NULL first). Zero is shown for items with no balance row.
 */
export async function listStock(ctx: TenantContext, query: z.input<typeof StockQuery>): Promise<StockPage> {
  await requirePermission(ctx, "inventory.read");
  const parsed = StockQuery.parse(query);
  await requireBranch(ctx, parsed.branchId);

  const cursor = parsed.cursor ? decode(StockCursor, parsed.cursor) : null;
  const search = parsed.q?.trim();
  const pattern = search ? `%${escapeLike(search)}%` : null;

  const searchSql = search
    ? Prisma.sql`AND (name ILIKE ${pattern} OR "nameAr" ILIKE ${pattern} OR sku ILIKE ${pattern}
        OR "variantName" ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM "Barcode" bc WHERE bc."orgId" = ${ctx.orgId}::uuid
                   AND bc."productId" = items."productId" AND bc.code = ${search}
                   -- A variant's barcode finds only that variant; a product-level barcode finds all of them.
                   AND (bc."variantId" IS NULL OR bc."variantId" = items."variantId")))`
    : Prisma.empty;
  const filterSql = {
    all: Prisma.sql`TRUE`,
    inStock: Prisma.sql`qty > 0`,
    zero: Prisma.sql`qty = 0`,
    negative: Prisma.sql`qty < 0`,
    unopened: Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "InventoryMovement" m
      WHERE m."orgId" = ${ctx.orgId}::uuid AND m."branchId" = ${parsed.branchId}::uuid
        AND m."productId" = items."productId" AND m."variantId" IS NOT DISTINCT FROM items."variantId")`,
  }[parsed.filter];
  const cursorSql = cursor
    ? Prisma.sql`AND (name, "productId", COALESCE("variantId"::text, '')) > (${cursor.n}, ${cursor.p}::uuid, ${cursor.v})`
    : Prisma.empty;

  const rows = await getDb().$queryRaw<(Omit<StockRow, "archived"> & { active: boolean })[]>`
    WITH items AS (
      SELECT p.id AS "productId", v.id AS "variantId", p.name AS name, p."nameAr" AS "nameAr",
             COALESCE(v.sku, p.sku) AS sku, v.name AS "variantName",
             CASE WHEN v.id IS NULL THEN p."isActive" ELSE p."isActive" AND v."isActive" END AS active,
             COALESCE(b.qty, 0) AS qty, b."reorderPoint" AS "reorderPoint", b."updatedAt" AS "updatedAt",
             (SELECT bc.code FROM "Barcode" bc
              WHERE bc."orgId" = p."orgId" AND bc."productId" = p.id AND bc."isPrimary"
                AND bc."variantId" IS NOT DISTINCT FROM v.id) AS "primaryBarcode",
             (SELECT COALESCE(SUM(l."qtySent"), 0) FROM "StockTransferLine" l
              JOIN "StockTransfer" t ON t."orgId" = l."orgId" AND t.id = l."transferId"
              WHERE l."orgId" = p."orgId" AND t."toBranchId" = ${parsed.branchId}::uuid AND t.status = 'SENT'
                AND l."productId" = p.id AND l."variantId" IS NOT DISTINCT FROM v.id) AS incoming
      FROM "Product" p
      LEFT JOIN "ProductVariant" v ON p."hasVariants" AND v."orgId" = p."orgId" AND v."productId" = p.id
      LEFT JOIN "StockBalance" b ON b."orgId" = p."orgId" AND b."branchId" = ${parsed.branchId}::uuid
        AND b."productId" = p.id AND b."variantId" IS NOT DISTINCT FROM v.id
      WHERE p."orgId" = ${ctx.orgId}::uuid AND (NOT p."hasVariants" OR v.id IS NOT NULL)
    )
    SELECT "productId", "variantId", name, "nameAr", sku, "variantName", active, qty::int AS qty,
           "reorderPoint", "updatedAt", "primaryBarcode", incoming::int AS incoming
    FROM items
    WHERE (active OR qty <> 0 OR incoming > 0) AND ${filterSql} ${searchSql} ${cursorSql}
    ORDER BY name, "productId", COALESCE("variantId"::text, '')
    LIMIT ${parsed.limit + 1}`;

  const page = rows.slice(0, parsed.limit).map(({ active, ...row }) => ({ ...row, archived: !active }));
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > parsed.limit && last ? encode({ n: last.name, p: last.productId, v: last.variantId ?? "" }) : null;
  return { rows: page, nextCursor };
}

export type LedgerRow = {
  id: string;
  createdAt: Date;
  reason: string;
  adjustmentReason: string | null;
  qtyDelta: number;
  balanceAfter: number;
  actor: { id: string; name: string };
  note: string | null;
  refType: string | null;
  refId: string | null;
  transfer: { groupId: string; otherBranch: { id: string; name: string } | null } | null;
};

export type LedgerPage = { qty: number; reorderPoint: number | null; rows: LedgerRow[]; nextCursor: string | null };

/**
 * Item history at one branch, newest first. `balanceAfter` is a running sum over the whole
 * item history (not just this page), so every row shows the balance at that moment.
 */
export async function getItemLedger(ctx: TenantContext, query: z.input<typeof LedgerQuery>): Promise<LedgerPage> {
  await requirePermission(ctx, "inventory.read");
  const parsed = LedgerQuery.parse(query);
  await requireBranch(ctx, parsed.branchId);
  const client = getDb();

  const product = await client.product.findFirst({
    where: { id: parsed.productId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!product) throw new AppError("NOT_FOUND", "Item not found", null);

  const balance = await client.stockBalance.findFirst({
    where: { orgId: ctx.orgId, branchId: parsed.branchId, productId: parsed.productId, variantId: parsed.variantId },
    select: { qty: true, reorderPoint: true },
  });
  const cursor = parsed.cursor ? decode(LedgerCursor, parsed.cursor) : null;
  const cursorSql = cursor
    ? Prisma.sql`WHERE ("createdAt", id) < (${new Date(cursor.t)}::timestamptz, ${cursor.i}::uuid)`
    : Prisma.empty;

  const rows = await client.$queryRaw<
    {
      id: string;
      createdAt: Date;
      reason: string;
      adjustmentReason: string | null;
      qtyDelta: number;
      balanceAfter: number;
      actorId: string;
      actorName: string;
      note: string | null;
      refType: string | null;
      refId: string | null;
      transferGroupId: string | null;
    }[]
  >`
    WITH history AS (
      SELECT m.id, m."createdAt", m.reason, m."adjustmentReason", m."qtyDelta", m.note, m."refType", m."refId",
             m."transferGroupId", u.id AS "actorId", u.name AS "actorName",
             (SUM(m."qtyDelta") OVER (ORDER BY m."createdAt", m.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::int
               AS "balanceAfter"
      FROM "InventoryMovement" m
      JOIN "User" u ON u.id = m."actorUserId"
      WHERE m."orgId" = ${ctx.orgId}::uuid AND m."branchId" = ${parsed.branchId}::uuid
        AND m."productId" = ${parsed.productId}::uuid
        AND m."variantId" IS NOT DISTINCT FROM ${parsed.variantId}::uuid
    )
    SELECT * FROM history
    ${cursorSql}
    ORDER BY "createdAt" DESC, id DESC
    LIMIT ${parsed.limit + 1}`;

  const page = rows.slice(0, parsed.limit);
  const groups = [...new Set(page.map((row) => row.transferGroupId).filter((g): g is string => g !== null))];
  const others = groups.length
    ? await client.inventoryMovement.findMany({
        where: { orgId: ctx.orgId, transferGroupId: { in: groups }, branchId: { not: parsed.branchId } },
        select: { transferGroupId: true, branch: { select: { id: true, name: true } } },
      })
    : [];
  const otherBranchOf = new Map(others.map((row) => [row.transferGroupId, row.branch]));

  const last = page[page.length - 1];
  return {
    qty: balance?.qty ?? 0,
    reorderPoint: balance?.reorderPoint ?? null,
    rows: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      reason: row.reason,
      adjustmentReason: row.adjustmentReason,
      qtyDelta: row.qtyDelta,
      balanceAfter: row.balanceAfter,
      actor: { id: row.actorId, name: row.actorName },
      note: row.note,
      refType: row.refType,
      refId: row.refId,
      transfer: row.transferGroupId
        ? { groupId: row.transferGroupId, otherBranch: otherBranchOf.get(row.transferGroupId) ?? null }
        : null,
    })),
    nextCursor: rows.length > parsed.limit && last ? encode({ t: last.createdAt.toISOString(), i: last.id }) : null,
  };
}
