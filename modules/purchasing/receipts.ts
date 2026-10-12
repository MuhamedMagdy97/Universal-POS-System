import "server-only";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { applyReceivedCosts } from "@/modules/catalog";
import { recordMovements } from "@/modules/inventory";
import { requestHashOf } from "@/modules/sales";
import { requirePermission, type Tx } from "./access";
import { lockPo, loadPurchaseOrder, type PoDetail } from "./orders";
import { purchasingConflict, purchasingInvalid } from "./errors";
import { canReceive, outstanding, statusAfterReceipt } from "./rules";
import { IdempotencyKey, ReceiptInput, Uuid } from "./schemas";

/**
 * Receiving against a PO (T5, purchasing-data-model-and-api.md §3). One transaction: lock the PO,
 * re-check outstanding quantities, write the receipt, bump the PO lines, add the stock through
 * the inventory seam, set last cost through the catalog seam, move the status, audit. The
 * Idempotency-Key makes a retry return the first receipt instead of receiving twice (P10).
 */

export type ReceiveResult = { po: PoDetail; receiptId: string; created: boolean };

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
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
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) return replayed;

  try {
    return await db.$transaction((tx) => writeReceipt(tx, ctx, id, parsed, idempotencyKey, requestHash, meta));
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
): Promise<ReceiveResult | null> {
  const existing = await db.goodsReceipt.findUnique({
    where: { orgId_idempotencyKey: { orgId: ctx.orgId, idempotencyKey } },
    select: { id: true, requestHash: true, purchaseOrderId: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw purchasingConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different receipt");
  }
  return {
    po: await loadPurchaseOrder(db, ctx.orgId, existing.purchaseOrderId),
    receiptId: existing.id,
    created: false,
  };
}

async function writeReceipt(
  tx: Tx,
  ctx: TenantContext,
  poId: string,
  input: ReturnType<typeof ReceiptInput.parse>,
  idempotencyKey: string,
  requestHash: string,
  meta: AuditRequestMeta | undefined,
): Promise<ReceiveResult> {
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

  const receiptId = randomUUID();
  await tx.goodsReceipt.create({
    data: {
      id: receiptId,
      orgId: ctx.orgId,
      branchId: po.branchId,
      purchaseOrderId: po.id,
      idempotencyKey,
      requestHash,
      receivedById: ctx.userId,
      note: input.note,
    },
  });
  await tx.goodsReceiptItem.createMany({
    data: lines.map((line) => ({
      orgId: ctx.orgId,
      goodsReceiptId: receiptId,
      poItemId: line.item.id,
      productId: line.item.productId,
      variantId: line.item.variantId,
      qtyReceived: line.qty,
      unitCostMinor: line.unitCostMinor,
    })),
  });
  for (const line of lines) {
    await tx.pOItem.update({ where: { id: line.item.id }, data: { qtyReceived: { increment: line.qty } } });
  }

  const refs = lines.map((line) => ({ productId: line.item.productId, variantId: line.item.variantId }));
  await recordMovements(tx, ctx, {
    branchId: po.branchId,
    reason: "PURCHASE_RECEIPT",
    refType: "GoodsReceipt",
    refId: receiptId,
    policy: "block",
    lines: lines.map((line, index) => ({ ref: refs[index], qty: line.qty })),
  });
  await applyReceivedCosts(
    tx,
    ctx,
    { receiptId, lines: lines.map((line, index) => ({ ref: refs[index], unitCostMinor: line.unitCostMinor })) },
    meta,
  );

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

  return { po: await loadPurchaseOrder(tx, ctx.orgId, po.id), receiptId, created: true };
}
