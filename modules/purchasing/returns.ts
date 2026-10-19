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
import { purchasingConflict, purchasingInvalid } from "./errors";
import { formatReturnNumber, returnable } from "./rules";
import { IdempotencyKey, ReturnInput, Uuid } from "./schemas";

/**
 * Returning received goods to the supplier (purchase-returns-spec.md). One transaction: lock the PO,
 * re-check what is returnable, write the return, bump the PO lines, take the stock out through the
 * inventory seam, audit. Valued at the PO line cost; last cost is left alone (R4). The
 * Idempotency-Key makes a retry return the first return instead of sending goods back twice (R7).
 */

export type ReturnResult = { po: PoDetail; returnId: string; created: boolean };

export type ReturnLine = { poItemId: string; qty: number; unitCostMinor: number; lineTotalMinor: number };
export type PurchaseReturnDetail = { po: PoDetail; ret: PoReturn; lines: ReturnLine[] };

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
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) return replayed;

  try {
    const returnId = await db.$transaction((tx) => writeReturn(tx, ctx, id, parsed, idempotencyKey, requestHash, meta));
    // Read after commit: nested includes inside a transaction run concurrently on its one connection.
    return { po: await loadPurchaseOrder(db, ctx.orgId, id), returnId, created: true };
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
): Promise<ReturnResult | null> {
  const existing = await db.purchaseReturn.findUnique({
    where: { orgId_idempotencyKey: { orgId: ctx.orgId, idempotencyKey } },
    select: { id: true, requestHash: true, purchaseOrderId: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw purchasingConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different return");
  }
  return {
    po: await loadPurchaseOrder(db, ctx.orgId, existing.purchaseOrderId),
    returnId: existing.id,
    created: false,
  };
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

  const itemById = new Map(po.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const lines: { item: (typeof po.items)[number]; qty: number }[] = [];
  for (const [index, line] of input.lines.entries()) {
    const item = itemById.get(line.poItemId);
    if (!item || seen.has(line.poItemId)) throw notFound("Purchase order line");
    seen.add(line.poItemId);
    if (line.qty > returnable(item)) {
      throw purchasingConflict("QTY_EXCEEDS_RETURNABLE", "More than can still be returned on this line", {
        index,
        poItemId: item.id,
        returnable: returnable(item),
        requested: line.qty,
      });
    }
    if (line.qty > 0) lines.push({ item, qty: line.qty });
  }
  if (lines.length === 0) throw purchasingInvalid("NOTHING_TO_RETURN", "Enter a quantity for at least one line");

  // Under the PO lock, so two returns of one PO cannot take the same number.
  const seq = (await tx.purchaseReturn.count({ where: { orgId: ctx.orgId, purchaseOrderId: po.id } })) + 1;
  const returnId = randomUUID();
  await tx.purchaseReturn.create({
    data: {
      id: returnId,
      orgId: ctx.orgId,
      branchId: po.branchId,
      purchaseOrderId: po.id,
      seq,
      reason: input.reason,
      note: input.note,
      idempotencyKey,
      requestHash,
      returnedById: ctx.userId,
    },
  });
  await tx.purchaseReturnItem.createMany({
    data: lines.map((line) => ({
      orgId: ctx.orgId,
      purchaseReturnId: returnId,
      poItemId: line.item.id,
      productId: line.item.productId,
      variantId: line.item.variantId,
      qty: line.qty,
      unitCostMinor: line.item.unitCostMinor,
    })),
  });
  for (const line of lines) {
    await tx.pOItem.update({ where: { id: line.item.id }, data: { qtyReturned: { increment: line.qty } } });
  }

  const org = await tx.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { blockNegativeStock: true },
  });
  await recordMovements(tx, ctx, {
    branchId: po.branchId,
    reason: "PURCHASE_RETURN",
    refType: "PurchaseReturn",
    refId: returnId,
    // The shop's negative-stock rule, as for a sale (R3).
    policy: org.blockNegativeStock ? "block" : "allow",
    lines: lines.map((line) => ({
      ref: { productId: line.item.productId, variantId: line.item.variantId },
      qty: line.qty,
    })),
  });

  await record(tx, {
    ctx,
    meta,
    action: "purchasing.return.created",
    entityType: "PurchaseReturn",
    entityId: returnId,
    metadata: {
      purchaseOrderId: po.id,
      number: formatReturnNumber(po.number, seq),
      reason: input.reason,
      lineCount: lines.length,
      units: lines.reduce((total, line) => total + line.qty, 0),
      valueMinor: lines.reduce((total, line) => total + multiply(line.item.unitCostMinor, line.qty), 0),
    },
  });

  return returnId;
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
    lines: row.items.map((item) => ({ ...item, lineTotalMinor: multiply(item.unitCostMinor, item.qty) })),
  };
}
