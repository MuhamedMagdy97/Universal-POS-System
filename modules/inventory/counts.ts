import "server-only";
import type { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { Prisma, type StockCountScope, type StockCountStatus } from "@/lib/generated/prisma/client";
import type { AuditRequestMeta } from "@/modules/audit";
import { record } from "@/modules/audit";
import { assertBuiltIn } from "@/modules/integrations/inventory-sys/source";
import { isUniqueViolation, requireBranch, requirePermission } from "./access";
import { countEmpty, countOpen, countState, invalidInput, itemNotInCount } from "./errors";
import { applyLines, assertKnownItems } from "./ledger";
import { lockBalances } from "./locking";
import { getOnHand } from "./queries";
import {
  CountCreateInput,
  CountEntryInput,
  CountItemInput,
  CountItemsInput,
  CountListQuery,
  MAX_QTY,
  Uuid,
  assertNoDuplicateRefs,
  countDelta,
} from "./schemas";
import type { ItemRef } from "./types";

/**
 * Stock counts (docs/planning/stock-counts/stock-counts-spec.md). A count is DRAFT → COUNTING →
 * POSTED, or CANCELLED. Expected on-hand is snapshotted when an item is first counted, and posting
 * applies `counted − expected` to the on-hand at posting time, so sales made while counting stay.
 * Every write locks the count row first, which serializes entries against posting.
 */

type Tx = Prisma.TransactionClient;
type CountRow = {
  id: string;
  branchId: string;
  status: StockCountStatus;
  scope: StockCountScope;
  categoryId: string | null;
};

const OPEN: StockCountStatus[] = ["DRAFT", "COUNTING"];
/** Posting a large count runs one row update per line; the default 5 s is too short. */
const POST_TIMEOUT_MS = 60_000;

export type CountSummary = {
  id: string;
  status: StockCountStatus;
  scope: StockCountScope;
  categoryName: string | null;
  note: string | null;
  createdAt: Date;
  postedAt: Date | null;
  counted: number;
};

export type CountLineView = {
  ref: ItemRef;
  name: string;
  nameAr: string | null;
  variantName: string | null;
  sku: string;
  countedQty: number | null;
  expectedQty: number | null;
  /** Live on-hand (open counts) or on-hand when posted. */
  onHand: number;
  /** Difference to post (open) or posted (closed); null when not counted. */
  qtyDelta: number | null;
};

export type CountDetail = CountSummary & {
  branchId: string;
  categoryId: string | null;
  lines: CountLineView[];
  /** In-scope items not counted yet; they stay unchanged when posted (C7). */
  uncounted: number;
};

export type PostResult = { lines: number; totalDelta: number; replayed: boolean };

const write = (operation: string, meta?: AuditRequestMeta) => ({ operation, entityType: "StockCount", meta });

/** Same-org count, branch inside the caller's scope (else 404). */
async function findCount(ctx: TenantContext, id: string): Promise<CountRow> {
  if (!Uuid.safeParse(id).success) throw notFound("Count");
  const count = await getDb().stockCount.findFirst({
    where: { id, orgId: ctx.orgId },
    select: { id: true, branchId: true, status: true, scope: true, categoryId: true },
  });
  if (!count) throw notFound("Count");
  await requireBranch(ctx, count.branchId);
  return count;
}

/** Locks the count row for the rest of the transaction and re-reads it. */
async function lockCount(tx: Tx, orgId: string, id: string): Promise<CountRow> {
  const rows = await tx.$queryRaw<CountRow[]>`
    SELECT id, "branchId", status, scope, "categoryId" FROM "StockCount"
    WHERE "orgId" = ${orgId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw notFound("Count");
  return rows[0];
}

function requireStatus(count: CountRow, ...allowed: StockCountStatus[]): void {
  if (!allowed.includes(count.status)) throw countState(count.status);
}

/** The category and its sub-categories, as a SQL set of ids. */
function categoryTree(orgId: string, categoryId: string): Prisma.Sql {
  return Prisma.sql`(
    WITH RECURSIVE tree AS (
      SELECT id FROM "Category" WHERE "orgId" = ${orgId}::uuid AND id = ${categoryId}::uuid
      UNION ALL
      SELECT c.id FROM "Category" c JOIN tree t ON c."parentId" = t.id WHERE c."orgId" = ${orgId}::uuid
    ) SELECT id FROM tree)`;
}

async function inScope(tx: Tx, ctx: TenantContext, count: CountRow, ref: ItemRef): Promise<boolean> {
  if (count.scope === "ITEMS") {
    const line = await tx.stockCountLine.findFirst({
      where: { orgId: ctx.orgId, countId: count.id, productId: ref.productId, variantId: ref.variantId },
      select: { id: true },
    });
    return line !== null;
  }
  // Existence and the variant rule; archived items may be counted (a write-off).
  await assertKnownItems(tx, ctx.orgId, [ref]);
  if (count.scope === "FULL" || !count.categoryId) return true;
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM "Product"
    WHERE "orgId" = ${ctx.orgId}::uuid AND id = ${ref.productId}::uuid
      AND "categoryId" IN ${categoryTree(ctx.orgId, count.categoryId)}`;
  return rows.length > 0;
}

export async function listCounts(ctx: TenantContext, query: z.input<typeof CountListQuery>): Promise<CountSummary[]> {
  await requirePermission(ctx, "inventory.read");
  const parsed = CountListQuery.parse(query);
  await requireBranch(ctx, parsed.branchId);
  const rows = await getDb().stockCount.findMany({
    where: { orgId: ctx.orgId, branchId: parsed.branchId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      scope: true,
      categoryId: true,
      note: true,
      createdAt: true,
      postedAt: true,
      _count: { select: { lines: { where: { countedQty: { not: null } } } } },
    },
  });
  const names = await categoryNames(
    ctx.orgId,
    rows.map((row) => row.categoryId),
  );
  return rows.map(({ _count, categoryId, ...row }) => ({
    ...row,
    categoryName: categoryId ? (names.get(categoryId) ?? null) : null,
    counted: _count.lines,
  }));
}

async function categoryNames(orgId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await getDb().category.findMany({
    where: { orgId, id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function createCount(
  ctx: TenantContext,
  input: z.input<typeof CountCreateInput>,
  meta?: AuditRequestMeta,
): Promise<{ id: string }> {
  await requirePermission(ctx, "inventory.adjust", write("count.create", meta));
  const parsed = CountCreateInput.parse(input);
  await requireBranch(ctx, parsed.branchId);
  if (parsed.categoryId) {
    const category = await getDb().category.findFirst({
      where: { id: parsed.categoryId, orgId: ctx.orgId },
      select: { id: true },
    });
    if (!category) throw notFound("Category");
  }
  try {
    return await getDb().$transaction(async (tx) => {
      const count = await tx.stockCount.create({
        data: {
          orgId: ctx.orgId,
          branchId: parsed.branchId,
          scope: parsed.scope,
          categoryId: parsed.categoryId ?? null,
          note: parsed.note?.trim() || null,
          createdByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await record(tx, {
        ctx: { ...ctx, branchId: parsed.branchId },
        meta,
        action: "inventory.count.created",
        entityType: "StockCount",
        entityId: count.id,
        metadata: { branchId: parsed.branchId, scope: parsed.scope, categoryId: parsed.categoryId ?? null },
      });
      return count;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw countOpen();
    throw err;
  }
}

export async function getCount(ctx: TenantContext, id: string): Promise<CountDetail> {
  await requirePermission(ctx, "inventory.read");
  const found = await findCount(ctx, id);
  const db = getDb();
  const count = await db.stockCount.findFirstOrThrow({
    where: { id: found.id, orgId: ctx.orgId },
    include: {
      lines: {
        include: {
          product: { select: { name: true, nameAr: true, sku: true } },
          variant: { select: { name: true, sku: true } },
        },
      },
    },
  });
  const open = OPEN.includes(count.status);
  const refs = count.lines.map((line) => ({ productId: line.productId, variantId: line.variantId }));
  const live = open ? await getOnHand(db, ctx.orgId, count.branchId, refs) : [];

  const lines: CountLineView[] = count.lines
    .map((line, index) => {
      return {
        ref: refs[index],
        name: line.product.name,
        nameAr: line.product.nameAr,
        variantName: line.variant?.name ?? null,
        sku: line.variant?.sku ?? line.product.sku,
        countedQty: line.countedQty,
        expectedQty: line.expectedQty,
        onHand: open ? live[index] : (line.onHandAtPost ?? 0),
        qtyDelta: open ? countDelta(line.countedQty, line.expectedQty) : line.qtyDelta,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.variantName ?? "").localeCompare(b.variantName ?? ""));

  const counted = lines.filter((line) => line.countedQty !== null).length;
  const names = await categoryNames(ctx.orgId, [count.categoryId]);
  return {
    id: count.id,
    branchId: count.branchId,
    status: count.status,
    scope: count.scope,
    categoryId: count.categoryId,
    categoryName: count.categoryId ? (names.get(count.categoryId) ?? null) : null,
    note: count.note,
    createdAt: count.createdAt,
    postedAt: count.postedAt,
    counted,
    lines,
    uncounted: open ? await uncountedInScope(ctx.orgId, found, lines.length - counted) : 0,
  };
}

/**
 * Stockable items in scope with no count yet: for ITEMS the uncounted lines; otherwise the
 * stock-list items (active, or archived with stock) that have no counted line.
 */
async function uncountedInScope(orgId: string, count: CountRow, uncountedLines: number): Promise<number> {
  if (count.scope === "ITEMS") return uncountedLines;
  const categorySql =
    count.scope === "CATEGORY" && count.categoryId
      ? Prisma.sql`AND p."categoryId" IN ${categoryTree(orgId, count.categoryId)}`
      : Prisma.empty;
  const rows = await getDb().$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM "Product" p
    LEFT JOIN "ProductVariant" v ON p."hasVariants" AND v."orgId" = p."orgId" AND v."productId" = p.id
    LEFT JOIN "StockBalance" b ON b."orgId" = p."orgId" AND b."branchId" = ${count.branchId}::uuid
      AND b."productId" = p.id AND b."variantId" IS NOT DISTINCT FROM v.id
    WHERE p."orgId" = ${orgId}::uuid AND (NOT p."hasVariants" OR v.id IS NOT NULL) ${categorySql}
      AND ((CASE WHEN v.id IS NULL THEN p."isActive" ELSE p."isActive" AND v."isActive" END) OR COALESCE(b.qty, 0) <> 0)
      AND NOT EXISTS (
        SELECT 1 FROM "StockCountLine" l
        WHERE l."orgId" = p."orgId" AND l."countId" = ${count.id}::uuid AND l."productId" = p.id
          AND l."variantId" IS NOT DISTINCT FROM v.id AND l."countedQty" IS NOT NULL)`;
  return rows[0]?.n ?? 0;
}

/** Adds items to a chosen-items draft. Items already on the list are skipped. */
export async function addCountItems(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof CountItemsInput>,
  meta?: AuditRequestMeta,
): Promise<{ items: number }> {
  await requirePermission(ctx, "inventory.adjust", write("count.items", meta));
  const parsed = CountItemsInput.parse(input);
  assertNoDuplicateRefs(parsed.refs);
  await findCount(ctx, id);
  return getDb().$transaction(async (tx) => {
    const count = await lockCount(tx, ctx.orgId, id);
    requireStatus(count, "DRAFT");
    if (count.scope !== "ITEMS") throw invalidInput("COUNT_SCOPE", "Only a chosen-items count takes an item list");
    await assertKnownItems(tx, ctx.orgId, parsed.refs);
    const existing = await tx.stockCountLine.findMany({
      where: { orgId: ctx.orgId, countId: id },
      select: { productId: true, variantId: true },
    });
    const has = new Set(existing.map((row) => `${row.productId}|${row.variantId ?? ""}`));
    const fresh = parsed.refs.filter((ref) => !has.has(`${ref.productId}|${ref.variantId ?? ""}`));
    await tx.stockCountLine.createMany({
      data: fresh.map((ref) => ({ orgId: ctx.orgId, countId: id, productId: ref.productId, variantId: ref.variantId })),
    });
    return { items: existing.length + fresh.length };
  });
}

export async function removeCountItem(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof CountItemInput>,
  meta?: AuditRequestMeta,
): Promise<void> {
  await requirePermission(ctx, "inventory.adjust", write("count.items", meta));
  const parsed = CountItemInput.parse(input);
  await findCount(ctx, id);
  await getDb().$transaction(async (tx) => {
    const count = await lockCount(tx, ctx.orgId, id);
    requireStatus(count, "DRAFT");
    await tx.stockCountLine.deleteMany({
      where: { orgId: ctx.orgId, countId: id, productId: parsed.ref.productId, variantId: parsed.ref.variantId },
    });
  });
}

export async function startCount(ctx: TenantContext, id: string, meta?: AuditRequestMeta): Promise<void> {
  await requirePermission(ctx, "inventory.adjust", write("count.start", meta));
  await findCount(ctx, id);
  await getDb().$transaction(async (tx) => {
    const count = await lockCount(tx, ctx.orgId, id);
    requireStatus(count, "DRAFT");
    if (
      count.scope === "ITEMS" &&
      (await tx.stockCountLine.count({ where: { orgId: ctx.orgId, countId: id } })) === 0
    ) {
      throw countEmpty();
    }
    await tx.stockCount.update({ where: { id }, data: { status: "COUNTING" } });
    await record(tx, {
      ctx: { ...ctx, branchId: count.branchId },
      meta,
      action: "inventory.count.started",
      entityType: "StockCount",
      entityId: id,
      metadata: { branchId: count.branchId },
    });
  });
}

/**
 * One count entry (C4, C5). `add` sums scans, `set` replaces, `set: null` clears. The first count
 * of an item snapshots on-hand as its expected quantity; clearing drops the snapshot.
 */
export async function recordCountEntry(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof CountEntryInput>,
  meta?: AuditRequestMeta,
): Promise<{ countedQty: number | null }> {
  await requirePermission(ctx, "inventory.adjust", write("count.entry", meta));
  const parsed = CountEntryInput.parse(input);
  await findCount(ctx, id);
  return getDb().$transaction(async (tx) => {
    const count = await lockCount(tx, ctx.orgId, id);
    requireStatus(count, "COUNTING");
    if (!(await inScope(tx, ctx, count, parsed.ref))) throw itemNotInCount();

    const line = await tx.stockCountLine.findFirst({
      where: { orgId: ctx.orgId, countId: id, productId: parsed.ref.productId, variantId: parsed.ref.variantId },
      select: { id: true, countedQty: true, expectedQty: true, countedAt: true },
    });
    const next = parsed.add !== undefined ? (line?.countedQty ?? 0) + parsed.add : (parsed.set ?? null);
    if (next !== null && next > MAX_QTY) throw invalidInput("QTY_INVALID", "Quantity must be at most 1,000,000");

    let snapshot = { expectedQty: line?.expectedQty ?? null, countedAt: line?.countedAt ?? null };
    if (next === null) snapshot = { expectedQty: null, countedAt: null };
    else if (snapshot.expectedQty === null) {
      const [onHand] = await getOnHand(tx, ctx.orgId, count.branchId, [parsed.ref]);
      snapshot = { expectedQty: onHand, countedAt: new Date() };
    }
    const data = { countedQty: next, ...snapshot };
    if (line) await tx.stockCountLine.update({ where: { id: line.id }, data });
    else {
      await tx.stockCountLine.create({
        data: {
          orgId: ctx.orgId,
          countId: id,
          productId: parsed.ref.productId,
          variantId: parsed.ref.variantId,
          ...data,
        },
      });
    }
    return { countedQty: next };
  });
}

/**
 * Posts the count (C6, C8–C10): one ADJUSTMENT/COUNT_CORRECTION row per line whose counted
 * quantity differs from its snapshot, applied to live on-hand, all in one transaction with the
 * status change and the audit row. A second post of a posted count replays the result.
 */
export async function postCount(ctx: TenantContext, id: string, meta?: AuditRequestMeta): Promise<PostResult> {
  await requirePermission(ctx, "inventory.adjust", write("count.post", meta));
  await findCount(ctx, id);
  return getDb().$transaction(
    async (tx) => {
      // Second guard (integration spec I18), inside the transaction like recordMovements.
      await assertBuiltIn(ctx.orgId, tx);
      const count = await lockCount(tx, ctx.orgId, id);
      if (count.status === "POSTED") return { ...(await postedTotals(tx, ctx.orgId, id)), replayed: true };
      requireStatus(count, "COUNTING");

      const lines = await tx.stockCountLine.findMany({
        where: { orgId: ctx.orgId, countId: id, countedQty: { not: null } },
        select: { id: true, productId: true, variantId: true, countedQty: true, expectedQty: true },
      });
      const changes = lines
        .map((line) => ({
          line,
          ref: { productId: line.productId, variantId: line.variantId },
          qtyDelta: countDelta(line.countedQty, line.expectedQty) ?? 0,
        }))
        .filter((change) => change.qtyDelta !== 0);

      // Lock the changing rows first, so on-hand at posting is read under the same lock the write uses.
      await lockBalances(
        tx,
        ctx.orgId,
        changes.map((change) => ({ branchId: count.branchId, ...change.ref })),
      );
      const refs = lines.map((line) => ({ productId: line.productId, variantId: line.variantId }));
      const onHand = await getOnHand(tx, ctx.orgId, count.branchId, refs);

      await applyLines(tx, ctx, {
        branchId: count.branchId,
        reason: "ADJUSTMENT",
        adjustmentReason: "COUNT_CORRECTION",
        refType: "StockCount",
        refId: id,
        policy: "block",
        lines: changes.map((change) => ({ ref: change.ref, qtyDelta: change.qtyDelta })),
      });

      // ponytail: one UPDATE per line; batch with a VALUES join if very large counts get slow.
      for (const [index, line] of lines.entries()) {
        await tx.stockCountLine.update({
          where: { id: line.id },
          data: { onHandAtPost: onHand[index], qtyDelta: countDelta(line.countedQty, line.expectedQty) },
        });
      }
      await tx.stockCount.update({
        where: { id },
        data: { status: "POSTED", postedAt: new Date(), postedByUserId: ctx.userId },
      });

      const totalDelta = changes.reduce((sum, change) => sum + change.qtyDelta, 0);
      await record(tx, {
        ctx: { ...ctx, branchId: count.branchId },
        meta,
        action: "inventory.count.posted",
        entityType: "StockCount",
        entityId: id,
        metadata: {
          branchId: count.branchId,
          counted: lines.length,
          lines: changes.map((change) => ({ ref: change.ref, qtyDelta: change.qtyDelta })),
          totalDelta,
        },
      });
      return { lines: changes.length, totalDelta, replayed: false };
    },
    { timeout: POST_TIMEOUT_MS },
  );
}

async function postedTotals(tx: Tx, orgId: string, id: string): Promise<{ lines: number; totalDelta: number }> {
  const rows = await tx.stockCountLine.findMany({
    where: { orgId, countId: id, qtyDelta: { not: 0 }, NOT: { qtyDelta: null } },
    select: { qtyDelta: true },
  });
  return { lines: rows.length, totalDelta: rows.reduce((sum, row) => sum + (row.qtyDelta ?? 0), 0) };
}

export async function cancelCount(ctx: TenantContext, id: string, meta?: AuditRequestMeta): Promise<void> {
  await requirePermission(ctx, "inventory.adjust", write("count.cancel", meta));
  await findCount(ctx, id);
  await getDb().$transaction(async (tx) => {
    const count = await lockCount(tx, ctx.orgId, id);
    requireStatus(count, ...OPEN);
    await tx.stockCount.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await record(tx, {
      ctx: { ...ctx, branchId: count.branchId },
      meta,
      action: "inventory.count.cancelled",
      entityType: "StockCount",
      entityId: id,
      metadata: { branchId: count.branchId },
    });
  });
}
