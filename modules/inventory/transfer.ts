import "server-only";
import type { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { AuditRequestMeta } from "@/modules/audit";
import { record } from "@/modules/audit";
import { isUniqueViolation, requireActiveBranch, requireBranch, requirePermission } from "./access";
import { idempotencyConflict, invalidInput } from "./errors";
import { applyLines } from "./ledger";
import { lockBalances } from "./locking";
import { TransferInput, assertNoDuplicateRefs } from "./schemas";
import type { ItemRef } from "./types";

type Line = { ref: ItemRef; qty: number };
type TransferResult = { transferId: string; replayed: boolean; lines: Line[] };

/**
 * Instant transfer (D1): one OUT row at the source and one IN row at the destination per line,
 * sharing a transferGroupId, in one transaction. Retrying the same transferId replays the
 * original result and never applies twice (I-7).
 */
export async function transferStock(
  ctx: TenantContext,
  input: z.input<typeof TransferInput>,
  meta?: AuditRequestMeta,
): Promise<TransferResult> {
  await requirePermission(ctx, "inventory.transfer", { operation: "transfer", entityType: "InventoryMovement", meta });
  const parsed = TransferInput.parse(input);
  if (parsed.fromBranchId === parsed.toBranchId) {
    throw invalidInput("SAME_BRANCH", "Choose a different branch to transfer to");
  }
  await requireBranch(ctx, parsed.fromBranchId);
  await requireActiveBranch(getDb(), ctx.orgId, parsed.toBranchId);
  assertNoDuplicateRefs(parsed.lines.map((line) => line.ref));

  const requested: Line[] = parsed.lines.map((line) => ({ ref: line.ref, qty: line.qty }));
  const earlier = await findTransfer(getDb(), ctx.orgId, parsed.transferId);
  if (earlier) return replayOrConflict(earlier, parsed, requested);

  try {
    await getDb().$transaction((tx) => applyTransfer(tx, ctx, parsed, requested, meta));
    return { transferId: parsed.transferId, replayed: false, lines: requested };
  } catch (err) {
    // A concurrent copy of the same transferId won the unique index: return its result.
    if (isUniqueViolation(err)) {
      const winner = await findTransfer(getDb(), ctx.orgId, parsed.transferId);
      if (winner) return replayOrConflict(winner, parsed, requested);
    }
    throw err;
  }
}

async function applyTransfer(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  parsed: z.infer<typeof TransferInput>,
  requested: Line[],
  meta?: AuditRequestMeta,
): Promise<void> {
  // Lock every row on both branches in one global order, so crossing transfers cannot deadlock (D7).
  await lockBalances(tx, ctx.orgId, [
    ...requested.map((line) => ({ branchId: parsed.fromBranchId, ...line.ref })),
    ...requested.map((line) => ({ branchId: parsed.toBranchId, ...line.ref })),
  ]);
  await applyLines(tx, ctx, {
    branchId: parsed.fromBranchId,
    reason: "TRANSFER_OUT",
    transferGroupId: parsed.transferId,
    note: parsed.note ?? null,
    policy: "block",
    lines: requested.map((line) => ({ ref: line.ref, qtyDelta: -line.qty })),
  });
  await applyLines(tx, ctx, {
    branchId: parsed.toBranchId,
    reason: "TRANSFER_IN",
    transferGroupId: parsed.transferId,
    note: parsed.note ?? null,
    policy: "block",
    lines: requested.map((line) => ({ ref: line.ref, qtyDelta: line.qty })),
  });
  await record(tx, {
    ctx: { ...ctx, branchId: parsed.fromBranchId },
    meta,
    action: "inventory.transferred",
    entityType: "InventoryMovement",
    entityId: parsed.transferId,
    metadata: {
      transferId: parsed.transferId,
      fromBranchId: parsed.fromBranchId,
      toBranchId: parsed.toBranchId,
      lines: requested,
      note: parsed.note ?? null,
    },
  });
}

/** The ledger rows an applied transfer must have, as sortable signatures. */
function signaturesOf(branches: { from: string; to: string }, lines: Line[]): string[] {
  return lines
    .flatMap((line) => [
      ["TRANSFER_OUT", branches.from, line.ref.productId, line.ref.variantId ?? "", -line.qty],
      ["TRANSFER_IN", branches.to, line.ref.productId, line.ref.variantId ?? "", line.qty],
    ])
    .map((parts) => parts.join("|"))
    .sort();
}

async function findTransfer(
  client: Db,
  orgId: string,
  transferId: string,
): Promise<{ from: string; to: string; signatures: string[] } | null> {
  const rows = await client.inventoryMovement.findMany({
    where: { orgId, transferGroupId: transferId },
    select: { reason: true, branchId: true, productId: true, variantId: true, qtyDelta: true },
  });
  if (rows.length === 0) return null;
  const from = rows.find((row) => row.reason === "TRANSFER_OUT")?.branchId ?? "";
  const to = rows.find((row) => row.reason === "TRANSFER_IN")?.branchId ?? "";
  return {
    from,
    to,
    signatures: rows
      .map((row) => [row.reason, row.branchId, row.productId, row.variantId ?? "", row.qtyDelta].join("|"))
      .sort(),
  };
}

function replayOrConflict(
  earlier: { from: string; to: string; signatures: string[] },
  parsed: z.infer<typeof TransferInput>,
  requested: Line[],
): TransferResult {
  const same = signaturesOf({ from: parsed.fromBranchId, to: parsed.toBranchId }, requested);
  const matches =
    earlier.from === parsed.fromBranchId &&
    earlier.to === parsed.toBranchId &&
    earlier.signatures.length === same.length &&
    earlier.signatures.every((value, index) => value === same[index]);
  if (!matches) throw idempotencyConflict();
  return { transferId: parsed.transferId, replayed: true, lines: requested };
}
