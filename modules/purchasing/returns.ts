import "server-only";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { multiply } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { recordMovements } from "@/modules/inventory";
import { requestHashOf } from "@/modules/sales";
import { branchIdsInScope, requirePermission, VIEW, type Tx } from "./access";
import { lockPo, loadPurchaseOrder, type PoDetail, type PoReturn } from "./orders";
import { loadDirectReceipt, requireScopedDirectReceipt, type DirectReceiptDetail } from "./receipts";
import { purchasingConflict, purchasingInvalid } from "./errors";
import { formatDirectReceiptNumber, formatReturnNumber, returnable } from "./rules";
import { DirectReturnInput, IdempotencyKey, ReturnInput, Uuid, type PurchaseReturnReason } from "./schemas";

/**
 * Returning received goods to the supplier (purchase-returns-spec.md). One transaction: lock the PO,
 * re-check what is returnable, write the return, bump the PO lines, take the stock out through the
 * inventory seam, audit. Valued at the PO line cost; last cost is left alone (R4). The
 * Idempotency-Key makes a retry return the first return instead of sending goods back twice (R7).
 *
 * A direct receipt's goods go back the same way (direct-receipt-returns-spec): the receipt row is
 * locked instead of the PO, and what went back already is summed from the return lines (DR4).
 */

export type ReturnResult = { po: PoDetail; returnId: string; created: boolean };
export type DirectReturnResult = { returnId: string; created: boolean };

export type ReturnLine = { poItemId: string; qty: number; unitCostMinor: number; lineTotalMinor: number };
export type PurchaseReturnDetail = { po: PoDetail; ret: PoReturn; lines: ReturnLine[] };

export type DirectReturnLine = {
  goodsReceiptItemId: string;
  qty: number;
  unitCostMinor: number;
  lineTotalMinor: number;
};
export type DirectReturnDetail = { receipt: DirectReceiptDetail; ret: PoReturn; lines: DirectReturnLine[] };

type Stored = { returnId: string; purchaseOrderId: string | null; created: boolean };

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

async function requireScopedPo(ctx: TenantContext, poId: string): Promise<string> {
  const parsed = Uuid.safeParse(poId);
  if (!parsed.success) throw notFound("Purchase order");
  const po = await getDb().purchaseOrder.findFirst({
    where: { id: parsed.data, orgId: ctx.orgId },
    select: { branchId: true },
  });
  if (!po || !(await branchIdsInScope(ctx)).includes(po.branchId)) throw notFound("Purchase order");
  return parsed.data;
}

/** Replay first; on a lost race for the key, return the winner (R7). */
async function idempotent(
  db: Db,
  ctx: TenantContext,
  idempotencyKey: string,
  requestHash: string,
  write: (tx: Tx) => Promise<string>,
): Promise<Stored> {
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) return replayed;
  try {
    const returnId = await db.$transaction(write);
    return { returnId, purchaseOrderId: null, created: true };
  } catch (err) {
    // A concurrent request with the same key won the unique index; our transaction rolled back.
    if (!isUniqueViolation(err)) throw err;
    const winner = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
    if (winner) return winner;
    throw err;
  }
}

async function replayIfKnown(
  db: Db,
  ctx: TenantContext,
  idempotencyKey: string,
  requestHash: string,
): Promise<Stored | null> {
  const existing = await db.purchaseReturn.findUnique({
    where: { orgId_idempotencyKey: { orgId: ctx.orgId, idempotencyKey } },
    select: { id: true, requestHash: true, purchaseOrderId: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw purchasingConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different return");
  }
  return { returnId: existing.id, purchaseOrderId: existing.purchaseOrderId, created: false };
}

export async function returnToSupplier(
  ctx: TenantContext,
  poId: string,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<ReturnResult> {
  await requirePermission(ctx, "purchases.manage", { operation: "po.return", entityType: "PurchaseReturn", meta });
  const parsedId = Uuid.safeParse(poId);
  if (!parsedId.success) throw notFound("Purchase order");
  const parsed = ReturnInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  const requestHash = requestHashOf({ purchaseOrderId: parsedId.data, ...parsed });

  const db = getDb();
  // Scope before replay: a stored return is never shown outside the caller's branches.
  const id = await requireScopedPo(ctx, parsedId.data);
  const stored = await idempotent(db, ctx, idempotencyKey, requestHash, (tx) =>
    writeReturn(tx, ctx, id, parsed, idempotencyKey, requestHash, meta),
  );
  // Read after commit: nested includes inside a transaction run concurrently on its one connection.
  // A key first used for a direct return carries a different hash, so it never lands here.
  return {
    po: await loadPurchaseOrder(db, ctx.orgId, stored.purchaseOrderId ?? id),
    returnId: stored.returnId,
    created: stored.created,
  };
}

/** Returning goods from a direct receipt (direct-receipt-returns-spec DR1–DR9): the same rules as a PO return. */
export async function returnDirectReceipt(
  ctx: TenantContext,
  receiptId: string,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<DirectReturnResult> {
  await requirePermission(ctx, "purchases.manage", {
    operation: "receipt.return",
    entityType: "PurchaseReturn",
    meta,
  });
  const parsed = DirectReturnInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  // Scope before replay: a stored return is never shown outside the caller's branches.
  const id = await requireScopedDirectReceipt(ctx, receiptId);
  const requestHash = requestHashOf({ goodsReceiptId: id, ...parsed });
  const stored = await idempotent(getDb(), ctx, idempotencyKey, requestHash, (tx) =>
    writeDirectReturn(tx, ctx, id, parsed, idempotencyKey, requestHash, meta),
  );
  return { returnId: stored.returnId, created: stored.created };
}

type ReturnRowLine = {
  poItemId: string | null;
  goodsReceiptItemId: string | null;
  productId: string;
  variantId: string | null;
  qty: number;
  unitCostMinor: number;
};

/** The return rows, the stock out (inventory seam) and the audit row: shared by PO and direct returns. */
async function postReturn(
  tx: Tx,
  ctx: TenantContext,
  ret: {
    branchId: string;
    supplierId: string;
    purchaseOrderId: string | null;
    goodsReceiptId: string | null;
    number: (seq: number) => string;
    reason: PurchaseReturnReason;
    note: string | null;
    idempotencyKey: string;
    requestHash: string;
    lines: readonly ReturnRowLine[];
  },
  meta: AuditRequestMeta | undefined,
): Promise<string> {
  // Under the PO (or receipt) lock, so two returns of one source cannot take the same number.
  const seq =
    (await tx.purchaseReturn.count({
      where: ret.purchaseOrderId
        ? { orgId: ctx.orgId, purchaseOrderId: ret.purchaseOrderId }
        : { orgId: ctx.orgId, goodsReceiptId: ret.goodsReceiptId },
    })) + 1;
  const returnId = randomUUID();
  await tx.purchaseReturn.create({
    data: {
      id: returnId,
      orgId: ctx.orgId,
      branchId: ret.branchId,
      supplierId: ret.supplierId,
      purchaseOrderId: ret.purchaseOrderId,
      goodsReceiptId: ret.goodsReceiptId,
      seq,
      reason: ret.reason,
      note: ret.note,
      idempotencyKey: ret.idempotencyKey,
      requestHash: ret.requestHash,
      returnedById: ctx.userId,
    },
  });
  await tx.purchaseReturnItem.createMany({
    data: ret.lines.map((line) => ({ orgId: ctx.orgId, purchaseReturnId: returnId, ...line })),
  });

  const org = await tx.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { blockNegativeStock: true },
  });
  await recordMovements(tx, ctx, {
    branchId: ret.branchId,
    reason: "PURCHASE_RETURN",
    refType: "PurchaseReturn",
    refId: returnId,
    // The shop's negative-stock rule, as for a sale (R3).
    policy: org.blockNegativeStock ? "block" : "allow",
    lines: ret.lines.map((line) => ({ ref: { productId: line.productId, variantId: line.variantId }, qty: line.qty })),
  });

  await record(tx, {
    ctx,
    meta,
    action: "purchasing.return.created",
    entityType: "PurchaseReturn",
    entityId: returnId,
    metadata: {
      ...(ret.purchaseOrderId
        ? { purchaseOrderId: ret.purchaseOrderId }
        : { direct: true, goodsReceiptId: ret.goodsReceiptId }),
      number: ret.number(seq),
      reason: ret.reason,
      lineCount: ret.lines.length,
      units: ret.lines.reduce((total, line) => total + line.qty, 0),
      valueMinor: ret.lines.reduce((total, line) => total + multiply(line.unitCostMinor, line.qty), 0),
    },
  });
  return returnId;
}

/** Checks each requested line against what is still returnable (R1, DR1); at least one line above 0. */
function pickLines<T extends { id: string }>(
  requested: readonly { id: string; qty: number }[],
  items: readonly T[],
  returnableOf: (item: T) => number,
  missing: string,
): { item: T; qty: number }[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const lines: { item: T; qty: number }[] = [];
  for (const [index, line] of requested.entries()) {
    const item = itemById.get(line.id);
    if (!item || seen.has(line.id)) throw notFound(missing);
    seen.add(line.id);
    const left = returnableOf(item);
    if (line.qty > left) {
      throw purchasingConflict("QTY_EXCEEDS_RETURNABLE", "More than can still be returned on this line", {
        index,
        lineId: item.id,
        returnable: left,
        requested: line.qty,
      });
    }
    if (line.qty > 0) lines.push({ item, qty: line.qty });
  }
  if (lines.length === 0) throw purchasingInvalid("NOTHING_TO_RETURN", "Enter a quantity for at least one line");
  return lines;
}

async function writeReturn(
  tx: Tx,
  ctx: TenantContext,
  poId: string,
  input: ReturnInput,
  idempotencyKey: string,
  requestHash: string,
  meta: AuditRequestMeta | undefined,
): Promise<string> {
  const po = await lockPo(tx, ctx, poId);
  const lines = pickLines(
    input.lines.map((line) => ({ id: line.poItemId, qty: line.qty })),
    po.items,
    returnable,
    "Purchase order line",
  );
  const returnId = await postReturn(
    tx,
    ctx,
    {
      branchId: po.branchId,
      supplierId: po.supplierId,
      purchaseOrderId: po.id,
      goodsReceiptId: null,
      number: (seq) => formatReturnNumber(po.number, seq),
      reason: input.reason,
      note: input.note,
      idempotencyKey,
      requestHash,
      lines: lines.map(({ item, qty }) => ({
        poItemId: item.id,
        goodsReceiptItemId: null,
        productId: item.productId,
        variantId: item.variantId,
        qty,
        unitCostMinor: item.unitCostMinor,
      })),
    },
    meta,
  );
  for (const line of lines) {
    await tx.pOItem.update({ where: { id: line.item.id }, data: { qtyReturned: { increment: line.qty } } });
  }
  return returnId;
}

async function writeDirectReturn(
  tx: Tx,
  ctx: TenantContext,
  receiptId: string,
  input: DirectReturnInput,
  idempotencyKey: string,
  requestHash: string,
  meta: AuditRequestMeta | undefined,
): Promise<string> {
  // The receipt row is the lock (DR4): returned quantities are re-summed under it.
  await tx.$queryRaw`SELECT "id" FROM "GoodsReceipt" WHERE "orgId" = ${ctx.orgId}::uuid AND "id" = ${receiptId}::uuid FOR UPDATE`;
  const receipt = await tx.goodsReceipt.findFirstOrThrow({
    where: { id: receiptId, orgId: ctx.orgId, purchaseOrderId: null },
    select: { id: true, branchId: true, supplierId: true },
  });
  const items = await tx.goodsReceiptItem.findMany({
    where: { orgId: ctx.orgId, goodsReceiptId: receipt.id },
    select: { id: true, productId: true, variantId: true, qtyReceived: true, unitCostMinor: true },
  });
  const sums = await tx.purchaseReturnItem.groupBy({
    by: ["goodsReceiptItemId"],
    where: { orgId: ctx.orgId, goodsReceiptItemId: { in: items.map((item) => item.id) } },
    _sum: { qty: true },
  });
  const returned = new Map(sums.map((row) => [row.goodsReceiptItemId, row._sum.qty ?? 0]));
  const lines = pickLines(
    input.lines.map((line) => ({ id: line.goodsReceiptItemId, qty: line.qty })),
    items,
    (item) => returnable({ qtyReceived: item.qtyReceived, qtyReturned: returned.get(item.id) ?? 0 }),
    "Goods receipt line",
  );
  return postReturn(
    tx,
    ctx,
    {
      branchId: receipt.branchId,
      supplierId: receipt.supplierId,
      purchaseOrderId: null,
      goodsReceiptId: receipt.id,
      number: (seq) => formatReturnNumber(formatDirectReceiptNumber(receipt.id), seq),
      reason: input.reason,
      note: input.note,
      idempotencyKey,
      requestHash,
      lines: lines.map(({ item, qty }) => ({
        poItemId: null,
        goodsReceiptItemId: item.id,
        productId: item.productId,
        variantId: item.variantId,
        qty,
        unitCostMinor: item.unitCostMinor,
      })),
    },
    meta,
  );
}

/** One return with its lines, for the return page and its print. */
export async function getPurchaseReturn(
  ctx: TenantContext,
  poId: string,
  returnId: string,
): Promise<PurchaseReturnDetail> {
  await requirePermission(ctx, VIEW, { operation: "po.return.read", entityType: "PurchaseReturn" });
  const id = await requireScopedPo(ctx, poId);
  if (!Uuid.safeParse(returnId).success) throw notFound("Purchase return");
  const db = getDb();
  const row = await db.purchaseReturn.findFirst({
    where: { id: returnId, orgId: ctx.orgId, purchaseOrderId: id },
    select: { items: { select: { poItemId: true, qty: true, unitCostMinor: true }, orderBy: { id: "asc" } } },
  });
  if (!row) throw notFound("Purchase return");
  const po = await loadPurchaseOrder(db, ctx.orgId, id);
  const ret = po.returns.find((r) => r.id === returnId);
  if (!ret) throw notFound("Purchase return");
  return {
    po,
    ret,
    lines: row.items.flatMap((item) =>
      item.poItemId
        ? [{ ...item, poItemId: item.poItemId, lineTotalMinor: multiply(item.unitCostMinor, item.qty) }]
        : [],
    ),
  };
}

/** One return against a direct receipt, for its page and print (DR11). */
export async function getDirectReturn(
  ctx: TenantContext,
  receiptId: string,
  returnId: string,
): Promise<DirectReturnDetail> {
  await requirePermission(ctx, VIEW, { operation: "receipt.return.read", entityType: "PurchaseReturn" });
  const id = await requireScopedDirectReceipt(ctx, receiptId);
  if (!Uuid.safeParse(returnId).success) throw notFound("Purchase return");
  const db = getDb();
  const row = await db.purchaseReturn.findFirst({
    where: { id: returnId, orgId: ctx.orgId, goodsReceiptId: id },
    select: {
      items: { select: { goodsReceiptItemId: true, qty: true, unitCostMinor: true }, orderBy: { id: "asc" } },
    },
  });
  if (!row) throw notFound("Purchase return");
  const receipt = await loadDirectReceipt(db, ctx.orgId, id);
  const ret = receipt.returns.find((r) => r.id === returnId);
  if (!ret) throw notFound("Purchase return");
  return {
    receipt,
    ret,
    lines: row.items.flatMap((item) =>
      item.goodsReceiptItemId
        ? [
            {
              goodsReceiptItemId: item.goodsReceiptItemId,
              qty: item.qty,
              unitCostMinor: item.unitCostMinor,
              lineTotalMinor: multiply(item.unitCostMinor, item.qty),
            },
          ]
        : [],
    ),
  };
}
