import "server-only";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import type { CurrencyCode } from "@/lib/money";
import { lineMinor, type QtyUnit } from "@/lib/quantity";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { applyReceivedCosts, itemNames } from "@/modules/catalog";
import { recordMovements } from "@/modules/inventory";
import { requestHashOf } from "@/modules/sales";
import { branchIdsInScope, requirePermission, VIEW, type Tx } from "./access";
import { lockPo, loadPurchaseOrder, prepareLines, requireActiveSupplier, type PoDetail, type PoReturn } from "./orders";
import { purchasingConflict, purchasingInvalid } from "./errors";
import {
  canReceive,
  formatDirectReceiptNumber,
  formatReturnNumber,
  outstanding,
  returnable,
  statusAfterReceipt,
} from "./rules";
import { DirectReceiptInput, IdempotencyKey, ReceiptInput, Uuid } from "./schemas";

/**
 * Receiving against a PO (T5, purchasing-data-model-and-api.md §3). One transaction: lock the PO,
 * re-check outstanding quantities, write the receipt, bump the PO lines, add the stock through
 * the inventory seam, set last cost through the catalog seam, move the status, audit. The
 * Idempotency-Key makes a retry return the first receipt instead of receiving twice (P10).
 *
 * A direct receipt (direct-receipt-spec) is the same receipt with no PO: supplier, branch and lines
 * come from the form, and it goes through the same `postReceipt` and the same key table.
 */

export type ReceiveResult = { po: PoDetail; receiptId: string; created: boolean };
export type DirectReceiveResult = { receiptId: string; created: boolean };

type Stored = { receiptId: string; purchaseOrderId: string | null; created: boolean };

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** Replay first; on a lost race for the key, return the winner (P10). */
async function idempotent(
  db: Db,
  ctx: TenantContext,
  idempotencyKey: string,
  requestHash: string,
  write: (tx: Tx) => Promise<Stored>,
): Promise<Stored> {
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) return replayed;
  try {
    return await db.$transaction(write);
  } catch (err) {
    // A concurrent request with the same key won the unique index; our transaction rolled back.
    if (!isUniqueViolation(err)) throw err;
    const winner = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
    if (winner) return winner;
    throw err;
  }
}

export async function receivePurchaseOrder(
  ctx: TenantContext,
  poId: string,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<ReceiveResult> {
  await requirePermission(ctx, "purchases.receive", { operation: "po.receive", entityType: "GoodsReceipt", meta });
  const parsedId = Uuid.safeParse(poId);
  if (!parsedId.success) throw notFound("Purchase order");
  const id = parsedId.data;
  const parsed = ReceiptInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  const requestHash = requestHashOf({ purchaseOrderId: id, ...parsed });

  const db = getDb();
  // Scope before replay, like sales and refunds: a stored receipt is never shown outside the caller's branches.
  const scoped = await db.purchaseOrder.findFirst({ where: { id, orgId: ctx.orgId }, select: { branchId: true } });
  if (!scoped || !(await branchIdsInScope(ctx)).includes(scoped.branchId)) throw notFound("Purchase order");

  const stored = await idempotent(db, ctx, idempotencyKey, requestHash, (tx) =>
    writeReceipt(tx, ctx, id, parsed, idempotencyKey, requestHash, meta),
  );
  // A key first used for a direct receipt carries a different hash, so it never lands here.
  // Read after commit: nested includes inside a transaction run concurrently on its one connection.
  return {
    po: await loadPurchaseOrder(db, ctx.orgId, stored.purchaseOrderId ?? id),
    receiptId: stored.receiptId,
    created: stored.created,
  };
}

/** Receiving without a PO (direct-receipt-spec D1–D6): `purchases.receive`, a branch in scope, an active supplier. */
export async function receiveWithoutPo(
  ctx: TenantContext,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<DirectReceiveResult> {
  await requirePermission(ctx, "purchases.receive", {
    operation: "receipt.direct",
    entityType: "GoodsReceipt",
    meta,
  });
  const parsed = DirectReceiptInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  const requestHash = requestHashOf({ direct: true, ...parsed });
  if (!(await branchIdsInScope(ctx)).includes(parsed.branchId)) throw notFound("Branch");

  const stored = await idempotent(getDb(), ctx, idempotencyKey, requestHash, async (tx) => {
    await requireActiveSupplier(tx, ctx.orgId, parsed.supplierId);
    const lines = await prepareLines(tx, ctx.orgId, parsed.lines);
    const receiptId = await postReceipt(
      tx,
      ctx,
      {
        branchId: parsed.branchId,
        supplierId: parsed.supplierId,
        purchaseOrderId: null,
        idempotencyKey,
        requestHash,
        note: parsed.note,
        lines: lines.map((line) => ({
          poItemId: null,
          productId: line.ref.productId,
          variantId: line.ref.variantId ?? null,
          qty: line.qty,
          unitCostMinor: line.unitCostMinor,
        })),
      },
      meta,
    );
    await record(tx, {
      ctx,
      meta,
      action: "purchasing.receipt.created",
      entityType: "GoodsReceipt",
      entityId: receiptId,
      metadata: {
        direct: true,
        number: formatDirectReceiptNumber(receiptId),
        branchId: parsed.branchId,
        supplierId: parsed.supplierId,
        lineCount: lines.length,
        units: lines.reduce((total, line) => total + line.qty, 0),
      },
    });
    return { receiptId, purchaseOrderId: null, created: true };
  });
  return { receiptId: stored.receiptId, created: stored.created };
}

async function replayIfKnown(
  db: Db,
  ctx: TenantContext,
  idempotencyKey: string,
  requestHash: string,
): Promise<Stored | null> {
  const existing = await db.goodsReceipt.findUnique({
    where: { orgId_idempotencyKey: { orgId: ctx.orgId, idempotencyKey } },
    select: { id: true, requestHash: true, purchaseOrderId: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw purchasingConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different receipt");
  }
  return { receiptId: existing.id, purchaseOrderId: existing.purchaseOrderId, created: false };
}

type ReceiptLine = {
  poItemId: string | null;
  productId: string;
  variantId: string | null;
  qty: number;
  unitCostMinor: number;
};

/** The receipt rows, the stock in (inventory seam) and last cost (catalog seam): shared by PO and direct receipts. */
async function postReceipt(
  tx: Tx,
  ctx: TenantContext,
  receipt: {
    branchId: string;
    supplierId: string;
    purchaseOrderId: string | null;
    idempotencyKey: string;
    requestHash: string;
    note: string | null;
    lines: readonly ReceiptLine[];
  },
  meta: AuditRequestMeta | undefined,
): Promise<string> {
  const receiptId = randomUUID();
  await tx.goodsReceipt.create({
    data: {
      id: receiptId,
      orgId: ctx.orgId,
      branchId: receipt.branchId,
      supplierId: receipt.supplierId,
      purchaseOrderId: receipt.purchaseOrderId,
      idempotencyKey: receipt.idempotencyKey,
      requestHash: receipt.requestHash,
      receivedById: ctx.userId,
      note: receipt.note,
    },
  });
  await tx.goodsReceiptItem.createMany({
    data: receipt.lines.map((line) => ({
      orgId: ctx.orgId,
      goodsReceiptId: receiptId,
      poItemId: line.poItemId,
      productId: line.productId,
      variantId: line.variantId,
      qtyReceived: line.qty,
      unitCostMinor: line.unitCostMinor,
    })),
  });
  const refs = receipt.lines.map((line) => ({ productId: line.productId, variantId: line.variantId }));
  await recordMovements(tx, ctx, {
    branchId: receipt.branchId,
    reason: "PURCHASE_RECEIPT",
    refType: "GoodsReceipt",
    refId: receiptId,
    policy: "block",
    lines: receipt.lines.map((line, index) => ({ ref: refs[index], qty: line.qty })),
  });
  await applyReceivedCosts(
    tx,
    ctx,
    { receiptId, lines: receipt.lines.map((line, index) => ({ ref: refs[index], unitCostMinor: line.unitCostMinor })) },
    meta,
  );
  return receiptId;
}

async function writeReceipt(
  tx: Tx,
  ctx: TenantContext,
  poId: string,
  input: ReturnType<typeof ReceiptInput.parse>,
  idempotencyKey: string,
  requestHash: string,
  meta: AuditRequestMeta | undefined,
): Promise<Stored> {
  const po = await lockPo(tx, ctx, poId);
  if (!canReceive(po)) {
    throw purchasingConflict("PO_NOT_RECEIVABLE", "This purchase order cannot be received now", { status: po.status });
  }

  const itemById = new Map(po.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const lines: { item: (typeof po.items)[number]; qty: number; unitCostMinor: number }[] = [];
  for (const [index, line] of input.lines.entries()) {
    const item = itemById.get(line.poItemId);
    if (!item || seen.has(line.poItemId)) throw notFound("Purchase order line");
    seen.add(line.poItemId);
    if (line.qty > outstanding(item)) {
      throw purchasingConflict("QTY_EXCEEDS_OUTSTANDING", "More than is still outstanding on this line", {
        index,
        poItemId: item.id,
        outstanding: outstanding(item),
        requested: line.qty,
      });
    }
    if (line.qty > 0) lines.push({ item, qty: line.qty, unitCostMinor: line.unitCostMinor ?? item.unitCostMinor });
  }
  if (lines.length === 0) throw purchasingInvalid("NOTHING_TO_RECEIVE", "Enter a quantity for at least one line");

  const receiptId = await postReceipt(
    tx,
    ctx,
    {
      branchId: po.branchId,
      supplierId: po.supplierId,
      purchaseOrderId: po.id,
      idempotencyKey,
      requestHash,
      note: input.note,
      lines: lines.map((line) => ({
        poItemId: line.item.id,
        productId: line.item.productId,
        variantId: line.item.variantId,
        qty: line.qty,
        unitCostMinor: line.unitCostMinor,
      })),
    },
    meta,
  );
  for (const line of lines) {
    await tx.pOItem.update({ where: { id: line.item.id }, data: { qtyReceived: { increment: line.qty } } });
  }

  const received = new Map(lines.map((line) => [line.item.id, line.qty]));
  const status = statusAfterReceipt(
    po.items.map((item) => ({
      qtyOrdered: item.qtyOrdered,
      qtyReceived: item.qtyReceived + (received.get(item.id) ?? 0),
    })),
  );
  await tx.purchaseOrder.update({
    where: { id: po.id },
    data: { status, ...(status === "RECEIVED" ? { closedAt: new Date() } : {}) },
  });
  await record(tx, {
    ctx,
    meta,
    action: "purchasing.receipt.created",
    entityType: "GoodsReceipt",
    entityId: receiptId,
    metadata: {
      purchaseOrderId: po.id,
      number: po.number,
      lineCount: lines.length,
      units: lines.reduce((total, line) => total + line.qty, 0),
      status,
    },
  });

  return { receiptId, purchaseOrderId: po.id, created: true };
}

// ---------- direct receipts list ----------

export type DirectReceiptRow = {
  id: string;
  number: string;
  receivedAt: string;
  branch: { id: string; name: string };
  supplier: { id: string; name: string };
  note: string | null;
  units: number;
  /** A KG line is on it: `units` adds grams to pieces (shown as "—"). */
  weighed: boolean;
  valueMinor: number;
};

export const DIRECT_RECEIPTS_SHOWN = 50;

/** The latest direct receipts in the caller's branches, newest first (D7). */
export async function listDirectReceipts(
  ctx: TenantContext,
): Promise<{ rows: DirectReceiptRow[]; currency: CurrencyCode }> {
  await requirePermission(ctx, VIEW, { operation: "receipt.list", entityType: "GoodsReceipt" });
  const db = getDb();
  const [rows, org] = await Promise.all([
    db.goodsReceipt.findMany({
      where: { orgId: ctx.orgId, purchaseOrderId: null, branchId: { in: await branchIdsInScope(ctx) } },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: DIRECT_RECEIPTS_SHOWN,
      select: {
        id: true,
        receivedAt: true,
        note: true,
        branch: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
        items: { select: { qtyReceived: true, unitCostMinor: true, product: { select: { unitType: true } } } },
      },
    }),
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { currency: true } }),
  ]);
  return {
    currency: org.currency,
    rows: rows.map((row) => ({
      id: row.id,
      number: formatDirectReceiptNumber(row.id),
      receivedAt: row.receivedAt.toISOString(),
      branch: row.branch,
      supplier: row.supplier,
      note: row.note,
      units: row.items.reduce((total, item) => total + item.qtyReceived, 0),
      weighed: row.items.some((item) => item.product.unitType === "KG"),
      valueMinor: row.items.reduce(
        (total, item) => total + lineMinor(item.unitCostMinor, item.qtyReceived, item.product.unitType),
        0,
      ),
    })),
  };
}

// ---------- one direct receipt (direct-receipt-returns-spec DR11) ----------

export type DirectReceiptLine = {
  id: string;
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  nameAr: string | null;
  qtyReceived: number;
  qtyReturned: number;
  returnable: number;
  /** Quantities are pieces, or grams for KG; `unitCostMinor` is then per kg (weighed-selling-spec W2). */
  unitType: QtyUnit;
  unitCostMinor: number;
  lineTotalMinor: number;
};

export type DirectReceiptDetail = {
  id: string;
  number: string;
  currency: CurrencyCode;
  branch: { id: string; name: string };
  supplier: { id: string; name: string; isActive: boolean; phone: string | null; taxNumber: string | null };
  receivedAt: string;
  receivedByName: string;
  note: string | null;
  lines: DirectReceiptLine[];
  returns: PoReturn[];
  units: number;
  valueMinor: number;
};

/** 404 unless `receiptId` is a direct receipt of this org in the caller's branches. */
export async function requireScopedDirectReceipt(ctx: TenantContext, receiptId: string): Promise<string> {
  const parsed = Uuid.safeParse(receiptId);
  const receipt = parsed.success
    ? await getDb().goodsReceipt.findFirst({
        where: { id: parsed.data, orgId: ctx.orgId, purchaseOrderId: null },
        select: { branchId: true },
      })
    : null;
  if (!parsed.success || !receipt || !(await branchIdsInScope(ctx)).includes(receipt.branchId)) {
    throw notFound("Goods receipt");
  }
  return parsed.data;
}

export async function getDirectReceipt(ctx: TenantContext, receiptId: string): Promise<DirectReceiptDetail> {
  await requirePermission(ctx, VIEW, { operation: "receipt.read", entityType: "GoodsReceipt" });
  return loadDirectReceipt(getDb(), ctx.orgId, await requireScopedDirectReceipt(ctx, receiptId));
}

/** A direct receipt with what has gone back on each line. Callers have checked access already. */
export async function loadDirectReceipt(db: Db, orgId: string, id: string): Promise<DirectReceiptDetail> {
  const receipt = await db.goodsReceipt.findFirstOrThrow({
    where: { id, orgId, purchaseOrderId: null },
    include: {
      org: { select: { currency: true } },
      branch: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true, isActive: true, phone: true, taxNumber: true } },
      items: {
        orderBy: { id: "asc" },
        include: {
          product: { select: { sku: true, name: true, nameAr: true, unitType: true } },
          variant: { select: { sku: true, name: true, nameAr: true } },
        },
      },
      returns: { orderBy: { seq: "asc" }, include: { items: true } },
    },
  });
  // Return items are of the receipt's own products (weighed-selling-spec W3).
  const units = new Map(receipt.items.map((item) => [item.productId, item.product.unitType]));
  const unitOf = (productId: string) => units.get(productId) ?? "EACH";
  const users = await db.user.findMany({
    where: { id: { in: [...new Set([receipt.receivedById, ...receipt.returns.map((r) => r.returnedById)])] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((user) => [user.id, user.name]));
  const returned = new Map<string, number>();
  for (const item of receipt.returns.flatMap((r) => r.items)) {
    if (item.goodsReceiptItemId) {
      returned.set(item.goodsReceiptItemId, (returned.get(item.goodsReceiptItemId) ?? 0) + item.qty);
    }
  }
  const number = formatDirectReceiptNumber(receipt.id);
  const lines: DirectReceiptLine[] = receipt.items
    .map((item) => {
      const qtyReturned = returned.get(item.id) ?? 0;
      return {
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        sku: item.variant?.sku ?? item.product.sku,
        ...itemNames(item.product, item.variant),
        qtyReceived: item.qtyReceived,
        qtyReturned,
        returnable: returnable({ qtyReceived: item.qtyReceived, qtyReturned }),
        unitType: item.product.unitType,
        unitCostMinor: item.unitCostMinor,
        lineTotalMinor: lineMinor(item.unitCostMinor, item.qtyReceived, item.product.unitType),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  return {
    id: receipt.id,
    number,
    currency: receipt.org.currency,
    branch: receipt.branch,
    supplier: receipt.supplier,
    receivedAt: receipt.receivedAt.toISOString(),
    receivedByName: nameOf.get(receipt.receivedById) ?? "",
    note: receipt.note,
    lines,
    returns: receipt.returns.map((ret) => ({
      id: ret.id,
      number: formatReturnNumber(number, ret.seq),
      returnedAt: ret.returnedAt.toISOString(),
      returnedByName: nameOf.get(ret.returnedById) ?? "",
      reason: ret.reason,
      note: ret.note,
      units: ret.items.reduce((total, item) => total + item.qty, 0),
      valueMinor: ret.items.reduce(
        (total, item) => total + lineMinor(item.unitCostMinor, item.qty, unitOf(item.productId)),
        0,
      ),
    })),
    units: lines.reduce((total, line) => total + line.qtyReceived, 0),
    valueMinor: lines.reduce((total, line) => total + line.lineTotalMinor, 0),
  };
}
