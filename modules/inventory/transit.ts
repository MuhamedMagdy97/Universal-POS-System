import "server-only";
import type { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { prismaTenantRepository, type TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/errors";
import type { Prisma, StockTransferStatus } from "@/lib/generated/prisma/client";
import type { AuditRequestMeta } from "@/modules/audit";
import { record } from "@/modules/audit";
import { assertBuiltIn } from "@/modules/integrations/inventory-sys/source";
import { isUniqueViolation, requireActiveBranch, requireBranch, requirePermission } from "./access";
import { idempotencyConflict, invalidInput, transferState } from "./errors";
import { applyLines, assertKnownItems } from "./ledger";
import {
  TransferInput,
  TransferListQuery,
  TransferReceiveInput,
  Uuid,
  assertNoDuplicateRefs,
  planReceipt,
  transferReference,
  type ShortfallReason,
} from "./schemas";
import type { ItemRef } from "./types";

/**
 * Two-step transfers (docs/planning/transfers/transit-transfers-spec.md). Send writes TRANSFER_OUT at
 * the source; receive writes TRANSFER_IN for what was sent at the destination and writes the shortfall
 * off there; cancel writes TRANSFER_IN back at the source. Receive and cancel lock the transfer row
 * before any balance row (T10), so exactly one of them applies.
 */

type Tx = Prisma.TransactionClient;
type TransferRow = {
  id: string;
  fromBranchId: string;
  toBranchId: string;
  status: StockTransferStatus;
  receiveKey: string | null;
};

const REF_TYPE = "StockTransfer";

export type TransferSummary = {
  id: string;
  reference: string;
  status: StockTransferStatus;
  fromBranch: { id: string; name: string };
  toBranch: { id: string; name: string };
  note: string | null;
  sentAt: Date;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  lineCount: number;
  unitsSent: number;
};

export type TransferLineView = {
  ref: ItemRef;
  name: string;
  nameAr: string | null;
  variantName: string | null;
  sku: string;
  qtySent: number;
  qtyReceived: number | null;
  shortfallReason: ShortfallReason | null;
};

export type TransferDetail = TransferSummary & {
  sentByName: string;
  receivedByName: string | null;
  cancelledByName: string | null;
  receiveNote: string | null;
  lines: TransferLineView[];
};

export type ReceiveResult = { replayed: boolean; received: number; shortfall: number };

const write = (operation: string, meta?: AuditRequestMeta) => ({ operation, entityType: REF_TYPE, meta });

/** Same-org transfer, without the scope check (callers check the side they act on). */
async function findTransfer(ctx: TenantContext, id: string): Promise<TransferRow> {
  if (!Uuid.safeParse(id).success) throw notFound("Transfer");
  const row = await getDb().stockTransfer.findFirst({
    where: { id, orgId: ctx.orgId },
    select: { id: true, fromBranchId: true, toBranchId: true, status: true, receiveKey: true },
  });
  if (!row) throw notFound("Transfer");
  return row;
}

async function lockTransfer(tx: Tx, orgId: string, id: string): Promise<TransferRow> {
  const rows = await tx.$queryRaw<TransferRow[]>`
    SELECT id, "fromBranchId", "toBranchId", status, "receiveKey" FROM "StockTransfer"
    WHERE "orgId" = ${orgId}::uuid AND id = ${id}::uuid FOR UPDATE`;
  if (!rows[0]) throw notFound("Transfer");
  return rows[0];
}

/** Branch ids the caller may see (null = all branches of the org). */
async function scopeOf(ctx: TenantContext): Promise<Set<string> | null> {
  const repo = prismaTenantRepository(getDb());
  const membership = await repo.findMembership(ctx.orgId, ctx.userId);
  if (!membership || !membership.isActive) return new Set();
  if (membership.allBranches) return null;
  const rows = await getDb().membershipBranch.findMany({
    where: { orgId: ctx.orgId, membershipId: membership.id },
    select: { branchId: true },
  });
  return new Set(rows.map((row) => row.branchId));
}

/** T3: create the transfer and take the stock out of the source, in one transaction. */
export async function sendTransfer(
  ctx: TenantContext,
  input: z.input<typeof TransferInput>,
  meta?: AuditRequestMeta,
): Promise<{ transferId: string; replayed: boolean }> {
  await requirePermission(ctx, "inventory.transfer", write("transfer.send", meta));
  const parsed = TransferInput.parse(input);
  if (parsed.fromBranchId === parsed.toBranchId) {
    throw invalidInput("SAME_BRANCH", "Choose a different branch to transfer to");
  }
  await requireBranch(ctx, parsed.fromBranchId);
  await requireActiveBranch(getDb(), ctx.orgId, parsed.toBranchId);
  assertNoDuplicateRefs(parsed.lines.map((line) => line.ref));

  const earlier = await replayOf(ctx, parsed);
  if (earlier) return earlier;
  // Ledger rows without a transfer are an instant transfer's; re-read first, a concurrent copy may just have committed.
  if (await getDb().inventoryMovement.findFirst({ where: { orgId: ctx.orgId, transferGroupId: parsed.transferId } })) {
    const winner = await replayOf(ctx, parsed);
    if (winner) return winner;
    throw idempotencyConflict();
  }

  try {
    await getDb().$transaction(async (tx) => {
      await assertBuiltIn(ctx.orgId, tx);
      await assertKnownItems(
        tx,
        ctx.orgId,
        parsed.lines.map((line) => line.ref),
      );
      await tx.stockTransfer.create({
        data: {
          id: parsed.transferId,
          orgId: ctx.orgId,
          fromBranchId: parsed.fromBranchId,
          toBranchId: parsed.toBranchId,
          note: parsed.note?.trim() || null,
          sentByUserId: ctx.userId,
        },
      });
      await tx.stockTransferLine.createMany({
        data: parsed.lines.map((line) => ({
          orgId: ctx.orgId,
          transferId: parsed.transferId,
          productId: line.ref.productId,
          variantId: line.ref.variantId,
          qtySent: line.qty,
        })),
      });
      await applyLines(tx, ctx, {
        branchId: parsed.fromBranchId,
        reason: "TRANSFER_OUT",
        transferGroupId: parsed.transferId,
        refType: REF_TYPE,
        refId: parsed.transferId,
        note: parsed.note?.trim() || null,
        policy: "block",
        lines: parsed.lines.map((line) => ({ ref: line.ref, qtyDelta: -line.qty })),
      });
      await record(tx, {
        ctx: { ...ctx, branchId: parsed.fromBranchId },
        meta,
        action: "inventory.transfer.sent",
        entityType: REF_TYPE,
        entityId: parsed.transferId,
        metadata: {
          fromBranchId: parsed.fromBranchId,
          toBranchId: parsed.toBranchId,
          lines: parsed.lines,
          note: parsed.note ?? null,
        },
      });
    });
    return { transferId: parsed.transferId, replayed: false };
  } catch (err) {
    // A concurrent copy of the same send won the primary key: replay it.
    if (isUniqueViolation(err)) {
      const winner = await replayOf(ctx, parsed);
      if (winner) return winner;
      throw idempotencyConflict();
    }
    throw err;
  }
}

/** Replay of an earlier send with the same id and content; a different content is a conflict (T9). */
async function replayOf(
  ctx: TenantContext,
  parsed: z.infer<typeof TransferInput>,
): Promise<{ transferId: string; replayed: true } | null> {
  const earlier = await getDb().stockTransfer.findFirst({
    where: { id: parsed.transferId, orgId: ctx.orgId },
    select: {
      fromBranchId: true,
      toBranchId: true,
      lines: { select: { productId: true, variantId: true, qtySent: true } },
    },
  });
  if (!earlier) return null;
  const sig = (lines: { productId: string; variantId: string | null; qty: number }[]) =>
    lines
      .map((line) => `${line.productId}|${line.variantId ?? ""}|${line.qty}`)
      .sort()
      .join(",");
  const same =
    earlier.fromBranchId === parsed.fromBranchId &&
    earlier.toBranchId === parsed.toBranchId &&
    sig(earlier.lines.map((line) => ({ ...line, qty: line.qtySent }))) ===
      sig(parsed.lines.map((line) => ({ ...line.ref, qty: line.qty })));
  if (!same) throw idempotencyConflict();
  return { transferId: parsed.transferId, replayed: true };
}

/** Receiving writes off the shortfall, so `inventory.adjust` may receive as well (T11). */
function receivePermission(ctx: TenantContext): "inventory.transfer" | "inventory.adjust" {
  return hasPermission(ctx.role, "inventory.transfer") ? "inventory.transfer" : "inventory.adjust";
}

/** T4, T5: received stock in at the destination, shortfall written off there, in one transaction. */
export async function receiveTransfer(
  ctx: TenantContext,
  id: string,
  input: z.input<typeof TransferReceiveInput>,
  meta?: AuditRequestMeta,
): Promise<ReceiveResult> {
  await requirePermission(ctx, receivePermission(ctx), write("transfer.receive", meta));
  const parsed = TransferReceiveInput.parse(input);
  const found = await findTransfer(ctx, id);
  await requireBranch(ctx, found.toBranchId);

  return getDb().$transaction(async (tx) => {
    await assertBuiltIn(ctx.orgId, tx);
    const transfer = await lockTransfer(tx, ctx.orgId, id);
    if (transfer.status === "RECEIVED" && transfer.receiveKey === parsed.receiveKey) {
      return { ...(await receivedTotals(tx, ctx.orgId, id)), replayed: true };
    }
    if (transfer.status !== "SENT") throw transferState(transfer.status);

    const sent = await tx.stockTransferLine.findMany({
      where: { orgId: ctx.orgId, transferId: id },
      select: { id: true, productId: true, variantId: true, qtySent: true },
    });
    const plan = planReceipt(sent, parsed.lines);
    const note = parsed.note?.trim() || null;

    // Everything sent arrives in the ledger, then the shortfall leaves again as a write-off (T5).
    await applyLines(tx, ctx, {
      branchId: transfer.toBranchId,
      reason: "TRANSFER_IN",
      transferGroupId: id,
      refType: REF_TYPE,
      refId: id,
      note,
      policy: "block",
      lines: plan.map((line) => ({ ref: refOf(line), qtyDelta: line.qtySent })),
    });
    for (const reason of new Set(plan.flatMap((line) => (line.shortfallReason ? [line.shortfallReason] : [])))) {
      await applyLines(tx, ctx, {
        branchId: transfer.toBranchId,
        reason: "ADJUSTMENT",
        adjustmentReason: reason,
        refType: REF_TYPE,
        refId: id,
        note,
        policy: "block",
        lines: plan
          .filter((line) => line.shortfallReason === reason)
          .map((line) => ({ ref: refOf(line), qtyDelta: -line.shortfall })),
      });
    }

    for (const [index, line] of plan.entries()) {
      await tx.stockTransferLine.update({
        where: { id: sent[index].id },
        data: { qtyReceived: line.qtyReceived, shortfallReason: line.shortfallReason },
      });
    }
    await tx.stockTransfer.update({
      where: { id },
      data: {
        status: "RECEIVED",
        receivedAt: new Date(),
        receivedByUserId: ctx.userId,
        receiveKey: parsed.receiveKey,
        receiveNote: note,
      },
    });

    const received = plan.reduce((sum, line) => sum + line.qtyReceived, 0);
    const shortfall = plan.reduce((sum, line) => sum + line.shortfall, 0);
    await record(tx, {
      ctx: { ...ctx, branchId: transfer.toBranchId },
      meta,
      action: "inventory.transfer.received",
      entityType: REF_TYPE,
      entityId: id,
      metadata: {
        fromBranchId: transfer.fromBranchId,
        toBranchId: transfer.toBranchId,
        lines: plan.map((line) => ({
          ref: refOf(line),
          qtySent: line.qtySent,
          qtyReceived: line.qtyReceived,
          shortfallReason: line.shortfallReason,
        })),
        received,
        shortfall,
        note,
      },
    });
    return { replayed: false, received, shortfall };
  });
}

const refOf = (line: { productId: string; variantId: string | null }): ItemRef => ({
  productId: line.productId,
  variantId: line.variantId,
});

async function receivedTotals(tx: Tx, orgId: string, id: string): Promise<{ received: number; shortfall: number }> {
  const lines = await tx.stockTransferLine.findMany({
    where: { orgId, transferId: id },
    select: { qtySent: true, qtyReceived: true },
  });
  const received = lines.reduce((sum, line) => sum + (line.qtyReceived ?? 0), 0);
  return { received, shortfall: lines.reduce((sum, line) => sum + line.qtySent, 0) - received };
}

/** T7: the source recalls a transfer that has not been received; the stock returns to the source. */
export async function cancelTransfer(
  ctx: TenantContext,
  id: string,
  meta?: AuditRequestMeta,
): Promise<{ replayed: boolean }> {
  await requirePermission(ctx, "inventory.transfer", write("transfer.cancel", meta));
  const found = await findTransfer(ctx, id);
  await requireBranch(ctx, found.fromBranchId);

  return getDb().$transaction(async (tx) => {
    await assertBuiltIn(ctx.orgId, tx);
    const transfer = await lockTransfer(tx, ctx.orgId, id);
    if (transfer.status === "CANCELLED") return { replayed: true };
    if (transfer.status !== "SENT") throw transferState(transfer.status);

    const lines = await tx.stockTransferLine.findMany({
      where: { orgId: ctx.orgId, transferId: id },
      select: { productId: true, variantId: true, qtySent: true },
    });
    await applyLines(tx, ctx, {
      branchId: transfer.fromBranchId,
      reason: "TRANSFER_IN",
      transferGroupId: id,
      refType: REF_TYPE,
      refId: id,
      policy: "block",
      lines: lines.map((line) => ({ ref: refOf(line), qtyDelta: line.qtySent })),
    });
    await tx.stockTransfer.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: ctx.userId },
    });
    await record(tx, {
      ctx: { ...ctx, branchId: transfer.fromBranchId },
      meta,
      action: "inventory.transfer.cancelled",
      entityType: REF_TYPE,
      entityId: id,
      metadata: { fromBranchId: transfer.fromBranchId, toBranchId: transfer.toBranchId },
    });
    return { replayed: false };
  });
}

const summarySelect = {
  id: true,
  status: true,
  note: true,
  sentAt: true,
  receivedAt: true,
  cancelledAt: true,
  fromBranch: { select: { id: true, name: true } },
  toBranch: { select: { id: true, name: true } },
} as const;

function summaryOf(
  row: Prisma.StockTransferGetPayload<{ select: typeof summarySelect }>,
  lines: { qtySent: number }[],
): TransferSummary {
  return {
    ...row,
    reference: transferReference(row.id),
    lineCount: lines.length,
    unitsSent: lines.reduce((sum, line) => sum + line.qtySent, 0),
  };
}

/** Outgoing or incoming transfers of one branch in scope, newest first (last 50). */
export async function listTransfers(
  ctx: TenantContext,
  query: z.input<typeof TransferListQuery>,
): Promise<TransferSummary[]> {
  await requirePermission(ctx, "inventory.read");
  const parsed = TransferListQuery.parse(query);
  await requireBranch(ctx, parsed.branchId);
  const rows = await getDb().stockTransfer.findMany({
    where: {
      orgId: ctx.orgId,
      ...(parsed.direction === "outgoing" ? { fromBranchId: parsed.branchId } : { toBranchId: parsed.branchId }),
      ...(parsed.status ? { status: parsed.status } : {}),
    },
    orderBy: { sentAt: "desc" },
    take: 50,
    select: { ...summarySelect, lines: { select: { qtySent: true } } },
  });
  return rows.map(({ lines, ...row }) => summaryOf(row, lines));
}

/** One transfer; either branch must be in the caller's scope (else 404, T11). */
export async function getTransfer(ctx: TenantContext, id: string): Promise<TransferDetail> {
  await requirePermission(ctx, "inventory.read");
  const found = await findTransfer(ctx, id);
  const scope = await scopeOf(ctx);
  if (scope && !scope.has(found.fromBranchId) && !scope.has(found.toBranchId)) throw notFound("Transfer");

  const db = getDb();
  const transfer = await db.stockTransfer.findFirstOrThrow({
    where: { id, orgId: ctx.orgId },
    select: {
      ...summarySelect,
      sentByUserId: true,
      receivedByUserId: true,
      cancelledByUserId: true,
      receiveNote: true,
      lines: {
        select: {
          productId: true,
          variantId: true,
          qtySent: true,
          qtyReceived: true,
          shortfallReason: true,
          product: { select: { name: true, nameAr: true, sku: true } },
          variant: { select: { name: true, sku: true } },
        },
      },
    },
  });
  const userIds = [transfer.sentByUserId, transfer.receivedByUserId, transfer.cancelledByUserId].filter(
    (value): value is string => value !== null,
  );
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const nameOf = (userId: string | null) => (userId ? (users.find((u) => u.id === userId)?.name ?? "") : null);

  const { lines, sentByUserId, receivedByUserId, cancelledByUserId, receiveNote, ...row } = transfer;
  return {
    ...summaryOf(row, lines),
    sentByName: nameOf(sentByUserId) ?? "",
    receivedByName: nameOf(receivedByUserId),
    cancelledByName: nameOf(cancelledByUserId),
    receiveNote,
    lines: lines
      .map((line) => ({
        ref: refOf(line),
        name: line.product.name,
        nameAr: line.product.nameAr,
        variantName: line.variant?.name ?? null,
        sku: line.variant?.sku ?? line.product.sku,
        qtySent: line.qtySent,
        qtyReceived: line.qtyReceived,
        shortfallReason: line.shortfallReason as ShortfallReason | null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || (a.variantName ?? "").localeCompare(b.variantName ?? "")),
  };
}
