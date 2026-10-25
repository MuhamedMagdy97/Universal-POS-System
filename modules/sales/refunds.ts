import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { AppError, notFound } from "@/lib/errors";
import { divideRoundHalfUp } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { recordMovements } from "@/modules/inventory";
import { postAfterCommit, recordRefundReturn, recordVoidReturn } from "@/modules/integrations/inventory-sys/postings";
import { inventorySourceOf } from "@/modules/integrations/inventory-sys/source";
import { Uuid } from "@/modules/inventory/schemas";
import { lockShift } from "@/modules/registers";
import { isUniqueViolation, requireBranch, requirePermission, requireRegister } from "./access";
import { loadSale, requestHashOf, type SaleDetail } from "./create";
import { salesConflict } from "./errors";
import { IdempotencyKey, RefundInput, VoidInput } from "./schemas";
import { stockLinesOf } from "./options";

/**
 * Refunds of some lines of a completed sale and voids of whole sales (T8, returns-void-spec.md).
 * A refund and a void both take the shift row lock, then the sale row lock, then the inventory
 * locks, the same order as a sale. Closed shifts are never changed (business rule 9).
 * A shop linked to the inventory system writes no POS stock: the goods go back as an IMS sales
 * return (or a cancelled hold), queued in the same transaction and never blocked by an outage (I14, I15).
 */

type Tx = Prisma.TransactionClient;

export type RefundLineDetail = { saleItemId: string; qty: number; amountMinor: number; vatMinor: number };

export type RefundDetail = {
  id: string;
  saleId: string;
  shiftId: string | null;
  method: "CASH" | "CARD_MANUAL" | "WALLET";
  reference: string | null;
  reason: string;
  totalMinor: number;
  vatMinor: number;
  createdAt: string;
  lines: RefundLineDetail[];
};

export type RefundResult = { refund: RefundDetail; created: boolean };

/** Refunded so far on one sale line, read under the locks. */
type Prior = { qty: number; amountMinor: number; vatMinor: number };

export async function refundSale(
  ctx: TenantContext,
  saleId: string,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<RefundResult> {
  await requirePermission(ctx, "sales.refund", { operation: "refund.create", entityType: "Sale", meta });
  const key = IdempotencyKey.parse(idempotencyKeyInput);
  const parsed = RefundInput.parse(input);
  await requireSaleInScope(ctx, saleId);

  const requestHash = requestHashOf({ saleId, ...parsed });
  const db = getDb();
  const replayed = await replayRefund(db, ctx, key, requestHash);
  if (replayed) return replayed;

  let result: RefundResult;
  try {
    result = await db.$transaction((tx) => writeRefund(tx, ctx, saleId, key, requestHash, parsed, meta));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A concurrent request with the same key won the race: answer it as a replay.
    const winner = await replayRefund(db, ctx, key, requestHash);
    if (winner) return winner;
    throw err;
  }
  if ((await inventorySourceOf(ctx.orgId)) === "EXTERNAL") await postAfterCommit(ctx.orgId, [result.refund.id, saleId]);
  return result;
}

/**
 * Voids a whole sale made on a shift that is still open. Voids are replayed by state: a sale
 * that is already VOIDED returns as it is (200). A sale with refunds cannot be voided.
 */
export async function voidSale(
  ctx: TenantContext,
  saleId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<{ sale: SaleDetail; created: boolean }> {
  await requirePermission(ctx, "sales.void", { operation: "sale.void", entityType: "Sale", meta });
  const parsed = VoidInput.parse(input);
  const scope = await requireSaleInScope(ctx, saleId);

  const result = await getDb().$transaction(async (tx) => {
    // Lock order: shift, then sale. The shift id comes from the sale, read before the lock.
    const current = await tx.sale.findFirst({ where: { id: saleId, orgId: ctx.orgId }, select: { shiftId: true } });
    if (!current) throw notFound("Sale");
    await lockShift(tx, ctx.orgId, current.shiftId);
    await lockSale(tx, ctx.orgId, saleId);

    const sale = await tx.sale.findFirstOrThrow({
      where: { id: saleId, orgId: ctx.orgId },
      select: { status: true, shiftId: true, totalMinor: true },
    });
    if (sale.status === "VOIDED") return { sale: await loadSale(tx, ctx.orgId, saleId), created: false };

    const shift = await tx.registerShift.findFirstOrThrow({
      where: { id: sale.shiftId, orgId: ctx.orgId },
      select: { status: true },
    });
    if (shift.status !== "OPEN")
      throw salesConflict("VOID_SHIFT_CLOSED", "The sale's shift is closed; refund it instead");

    const refunds = await tx.refund.count({ where: { orgId: ctx.orgId, saleId } });
    if (refunds > 0) {
      throw salesConflict(
        "SALE_HAS_REFUNDS",
        "A sale with refunds cannot be voided; refund the remaining lines instead",
      );
    }

    const items = await tx.saleItem.findMany({
      where: { orgId: ctx.orgId, saleId },
      select: { productId: true, variantId: true, qty: true },
    });
    if ((await inventorySourceOf(ctx.orgId, tx)) === "EXTERNAL") {
      await recordVoidReturn(tx, ctx.orgId, saleId);
    } else {
      await recordMovements(tx, ctx, {
        branchId: scope.branchId,
        reason: "SALE_VOID",
        refType: "Sale",
        refId: saleId,
        policy: "allow",
        lines: stockLinesOf(
          items.map((item) => ({ ref: { productId: item.productId, variantId: item.variantId }, qty: item.qty })),
        ),
      });
    }
    await tx.sale.update({
      where: { id: saleId },
      data: { status: "VOIDED", voidedAt: new Date(), voidedById: ctx.userId, voidReason: parsed.reason },
    });
    await record(tx, {
      ctx,
      meta,
      action: "sale.void",
      entityType: "Sale",
      entityId: saleId,
      metadata: { reason: parsed.reason, totalMinor: sale.totalMinor, lines: items.length },
    });
    return { sale: await loadSale(tx, ctx.orgId, saleId), created: true };
  });
  if (result.created && (await inventorySourceOf(ctx.orgId)) === "EXTERNAL") await postAfterCommit(ctx.orgId, [saleId]);
  return result;
}

async function writeRefund(
  tx: Tx,
  ctx: TenantContext,
  saleId: string,
  key: string,
  requestHash: string,
  input: RefundInput,
  meta: AuditRequestMeta | undefined,
): Promise<RefundResult> {
  const scope = await tx.sale.findFirst({
    where: { id: saleId, orgId: ctx.orgId },
    select: { branchId: true, registerId: true },
  });
  if (!scope) throw notFound("Sale");

  // The refund books against the open shift of the till paying it out: the one chosen, which must
  // be in the sale's branch, or else the sale's own till (V6, as changed by the owner 2026-10-12).
  const registerId = input.registerId ?? scope.registerId;
  if (input.registerId !== null) await requireRegister(tx, ctx.orgId, scope.branchId, registerId);
  const open = await tx.registerShift.findFirst({
    where: { orgId: ctx.orgId, registerId, status: "OPEN" },
    select: { id: true },
  });
  if (!open) throw salesConflict("SHIFT_NOT_OPEN", "Open a shift on this register to refund");
  await lockShift(tx, ctx.orgId, open.id);
  const shift = await tx.registerShift.findFirst({
    where: { id: open.id, orgId: ctx.orgId, status: "OPEN" },
    select: { id: true },
  });
  if (!shift) throw salesConflict("SHIFT_NOT_OPEN", "Open a shift on this register to refund");

  await lockSale(tx, ctx.orgId, saleId);
  const sale = await tx.sale.findFirstOrThrow({ where: { id: saleId, orgId: ctx.orgId }, select: { status: true } });
  if (sale.status !== "COMPLETED") throw salesConflict("SALE_NOT_COMPLETED", "A voided sale cannot be refunded");

  const items = await tx.saleItem.findMany({
    where: { orgId: ctx.orgId, saleId },
    select: { id: true, productId: true, variantId: true, qty: true, lineTotalMinor: true, vatMinor: true },
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  const done = await tx.refundItem.groupBy({
    by: ["saleItemId"],
    where: { orgId: ctx.orgId, saleItemId: { in: items.map((item) => item.id) } },
    _sum: { qty: true, amountMinor: true, vatMinor: true },
  });
  const prior = new Map<string, Prior>(
    done.map((row) => [
      row.saleItemId,
      { qty: row._sum.qty ?? 0, amountMinor: row._sum.amountMinor ?? 0, vatMinor: row._sum.vatMinor ?? 0 },
    ]),
  );

  const exceeded: { saleItemId: string; requested: number; refundable: number }[] = [];
  for (const line of input.lines) {
    const item = byId.get(line.saleItemId);
    if (!item) throw notFound("Sale line");
    const refundable = item.qty - (prior.get(item.id)?.qty ?? 0);
    if (line.qty > refundable) exceeded.push({ saleItemId: item.id, requested: line.qty, refundable });
  }
  if (exceeded.length > 0) {
    throw salesConflict("REFUND_QTY_EXCEEDED", "More than the remaining quantity was asked for", { lines: exceeded });
  }

  const lines: RefundLineDetail[] = input.lines.map((line) => {
    const item = byId.get(line.saleItemId) as (typeof items)[number];
    const before = prior.get(item.id) ?? { qty: 0, amountMinor: 0, vatMinor: 0 };
    // The last refund of a line takes the remainder, so the line never over- or under-refunds by a unit (V4).
    const isLast = line.qty === item.qty - before.qty;
    return {
      saleItemId: item.id,
      qty: line.qty,
      amountMinor: isLast ? item.lineTotalMinor - before.amountMinor : share(item.lineTotalMinor, line.qty, item.qty),
      vatMinor: isLast ? item.vatMinor - before.vatMinor : share(item.vatMinor, line.qty, item.qty),
    };
  });
  const totalMinor = lines.reduce((total, line) => total + line.amountMinor, 0);
  const vatMinor = lines.reduce((total, line) => total + line.vatMinor, 0);
  // A free item, or a share that rounds to nothing, has no money to give back. The database
  // requires a refund total above zero (`Refund_money_valid`), so say so before writing.
  if (totalMinor === 0) {
    throw new AppError("VALIDATION_FAILED", "This refund comes to zero; there is no money to give back", {
      reason: "REFUND_ZERO_TOTAL",
    });
  }

  const refund = await tx.refund.create({
    data: {
      orgId: ctx.orgId,
      branchId: scope.branchId,
      saleId,
      shiftId: open.id,
      processedById: ctx.userId,
      idempotencyKey: key,
      requestHash,
      method: input.method,
      reference: input.reference,
      reason: input.reason,
      totalMinor,
      vatMinor,
    },
    select: { id: true },
  });

  await tx.refundItem.createMany({
    data: lines.map((line) => ({
      orgId: ctx.orgId,
      refundId: refund.id,
      saleItemId: line.saleItemId,
      qty: line.qty,
      amountMinor: line.amountMinor,
      vatMinor: line.vatMinor,
    })),
  });

  if ((await inventorySourceOf(ctx.orgId, tx)) === "EXTERNAL") {
    await recordRefundReturn(tx, ctx.orgId, refund.id, key);
  } else {
    await recordMovements(tx, ctx, {
      branchId: scope.branchId,
      reason: "REFUND",
      refType: "Refund",
      refId: refund.id,
      policy: "allow",
      lines: stockLinesOf(
        lines.map((line) => {
          const item = byId.get(line.saleItemId) as (typeof items)[number];
          return { ref: { productId: item.productId, variantId: item.variantId }, qty: line.qty };
        }),
      ),
    });
  }
  await record(tx, {
    ctx,
    meta,
    action: "refund.create",
    entityType: "Refund",
    entityId: refund.id,
    metadata: { saleId, shiftId: open.id, method: input.method, totalMinor, vatMinor, lines: lines.length },
  });
  return { refund: await loadRefund(tx, ctx.orgId, refund.id), created: true };
}

/** Lines of a refund: `amount = round(lineTotal × qty ÷ soldQty)`, and the same for VAT. */
function share(total: number, qty: number, soldQty: number): number {
  return Number(divideRoundHalfUp(BigInt(total) * BigInt(qty), BigInt(soldQty)));
}

async function replayRefund(
  client: Db,
  ctx: TenantContext,
  key: string,
  requestHash: string,
): Promise<RefundResult | null> {
  const existing = await client.refund.findUnique({
    where: { orgId_idempotencyKey: { orgId: ctx.orgId, idempotencyKey: key } },
    select: { id: true, requestHash: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw salesConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different refund");
  }
  return { refund: await loadRefund(client, ctx.orgId, existing.id), created: false };
}

export async function loadRefund(client: Db | Tx, orgId: string, refundId: string): Promise<RefundDetail> {
  const refund = await client.refund.findFirstOrThrow({
    where: { id: refundId, orgId },
    include: { items: { orderBy: { id: "asc" } } },
  });
  return {
    id: refund.id,
    saleId: refund.saleId,
    shiftId: refund.shiftId,
    method: refund.method,
    reference: refund.reference,
    reason: refund.reason,
    totalMinor: refund.totalMinor,
    vatMinor: refund.vatMinor,
    createdAt: refund.createdAt.toISOString(),
    lines: refund.items.map((item) => ({
      saleItemId: item.saleItemId,
      qty: item.qty,
      amountMinor: item.amountMinor,
      vatMinor: item.vatMinor,
    })),
  };
}

/** Row lock on the sale (`SELECT … FOR UPDATE`), taken after the shift lock. */
async function lockSale(tx: Tx, orgId: string, saleId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Sale" WHERE "orgId" = ${orgId}::uuid AND "id" = ${saleId}::uuid FOR UPDATE`;
}

/** Bad uuid, unknown id, other-tenant id and out-of-scope branch all answer 404. */
async function requireSaleInScope(
  ctx: TenantContext,
  saleId: string,
): Promise<{ branchId: string; registerId: string }> {
  if (!Uuid.safeParse(saleId).success) throw notFound("Sale");
  const sale = await getDb().sale.findFirst({
    where: { id: saleId, orgId: ctx.orgId },
    select: { branchId: true, registerId: true },
  });
  if (!sale) throw notFound("Sale");
  await requireBranch(ctx, sale.branchId);
  return sale;
}
