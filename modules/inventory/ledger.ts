import "server-only";
import { assertStockable, getItemsForHistory, lockProducts } from "@/modules/catalog";
import type { TenantContext } from "@/lib/auth/tenant";
import type { Prisma } from "@/lib/generated/prisma/client";
import { insufficientStock, invalidInput, type InsufficientLine } from "./errors";
import { keyOf, lockBalances } from "./locking";
import { Qty, assertNoDuplicateRefs } from "./schemas";
import type { ItemRef } from "./types";

/**
 * The single write path for stock (inventory-api-and-rules.md §2). Every change — back office
 * and seam — runs inside the caller's transaction: check catalog, lock, check stock, update the
 * balance cache, append the ledger rows.
 */

export type MovementReason =
  | "OPENING_BALANCE"
  | "SALE"
  | "SALE_VOID"
  | "REFUND"
  | "PURCHASE_RECEIPT"
  | "ADJUSTMENT"
  | "TRANSFER_OUT"
  | "TRANSFER_IN";

export type SignedLine = { ref: ItemRef; qtyDelta: number };

export type ApplyInput = {
  branchId: string;
  reason: MovementReason;
  adjustmentReason?: "DAMAGED" | "EXPIRED" | "LOST_OR_STOLEN" | "COUNT_CORRECTION" | "FOUND" | "OTHER" | null;
  refType?: string | null;
  refId?: string | null;
  transferGroupId?: string | null;
  note?: string | null;
  /** "block" never lets a line go below zero; "allow" lets a sale oversell (D4). */
  policy: "block" | "allow";
  lines: readonly SignedLine[];
};

/**
 * Reasons that may move an archived item's stock: a refund or void returns stock, and a
 * transfer moves what is left to another branch. Decreasing adjustments are allowed too (see
 * `archivedAllowed`), so archived stock can always be written off. Nothing may add new stock
 * to an archived item.
 */
const ARCHIVED_ALLOWED: ReadonlySet<MovementReason> = new Set(["SALE_VOID", "REFUND", "TRANSFER_OUT", "TRANSFER_IN"]);

function archivedAllowed(reason: MovementReason, qtyDelta: number): boolean {
  return ARCHIVED_ALLOWED.has(reason) || (reason === "ADJUSTMENT" && qtyDelta < 0);
}

/**
 * Existence and the variant rule only (archived items pass). Unknown or other-org refs answer
 * 404. Services call this before taking row locks, so a bad ref never reaches a raw INSERT.
 */
export async function assertKnownItems(
  tx: Prisma.TransactionClient,
  orgId: string,
  refs: readonly ItemRef[],
): Promise<void> {
  await getItemsForHistory(tx, orgId, refs);
}

export async function applyLines(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  input: ApplyInput,
): Promise<{ ref: ItemRef; qty: number }[]> {
  if (input.lines.length === 0) return [];
  assertNoDuplicateRefs(input.lines.map((line) => line.ref));

  // Product rows before the catalog check, so a concurrent variant switch is seen (checkout R1).
  await lockProducts(
    tx,
    ctx.orgId,
    input.lines.map((line) => line.ref.productId),
  );
  for (const line of input.lines) {
    if (archivedAllowed(input.reason, line.qtyDelta)) await assertKnownItems(tx, ctx.orgId, [line.ref]);
    else await assertStockable(tx, ctx.orgId, line.ref);
  }

  const locked = await lockBalances(
    tx,
    ctx.orgId,
    input.lines.map((line) => ({ branchId: input.branchId, ...line.ref })),
  );

  const failing: InsufficientLine[] = [];
  const balances = input.lines.map((line) => {
    const balance = locked.get(keyOf({ branchId: input.branchId, ...line.ref }));
    if (!balance) throw new Error("balance row missing after lock");
    return balance;
  });
  input.lines.forEach((line, index) => {
    const balance = balances[index];
    if (input.policy === "block" && line.qtyDelta < 0 && balance.qty + line.qtyDelta < 0) {
      failing.push({
        productId: line.ref.productId,
        variantId: line.ref.variantId,
        branchId: input.branchId,
        onHand: balance.qty,
        requested: -line.qtyDelta,
      });
    }
  });
  if (failing.length > 0) throw insufficientStock(failing);

  const after: { ref: ItemRef; qty: number }[] = [];
  for (const [index, line] of input.lines.entries()) {
    const balance = balances[index];
    await tx.stockBalance.update({ where: { id: balance.id }, data: { qty: { increment: line.qtyDelta } } });
    after.push({ ref: line.ref, qty: balance.qty + line.qtyDelta });
  }

  await tx.inventoryMovement.createMany({
    data: input.lines.map((line) => ({
      orgId: ctx.orgId,
      branchId: input.branchId,
      productId: line.ref.productId,
      variantId: line.ref.variantId,
      qtyDelta: line.qtyDelta,
      reason: input.reason,
      adjustmentReason: input.adjustmentReason ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      transferGroupId: input.transferGroupId ?? null,
      note: input.note ?? null,
      actorUserId: ctx.userId,
    })),
  });

  return after;
}

export type RecordMovementsInput = {
  branchId: string;
  reason: "SALE" | "SALE_VOID" | "REFUND" | "PURCHASE_RECEIPT";
  refType: "Sale" | "Refund" | "GoodsReceipt" | null;
  refId: string | null;
  /** Positive quantities; the sign comes from the reason. */
  lines: readonly { ref: ItemRef; qty: number }[];
  policy: "block" | "allow";
};

/**
 * Seam for sales, returns and receipts (T5, T6, T8). Tx-aware, no permission check: the calling
 * module has authorised the operation, and the calling document writes its own audit row.
 */
export async function recordMovements(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  input: RecordMovementsInput,
): Promise<{ ref: ItemRef; qty: number }[]> {
  for (const line of input.lines) {
    if (!Qty.safeParse(line.qty).success) throw invalidInput("QTY_INVALID", "Quantity must be a whole number from 1");
  }
  const sign = input.reason === "SALE" ? -1 : 1;
  return applyLines(tx, ctx, {
    branchId: input.branchId,
    reason: input.reason,
    refType: input.refType,
    refId: input.refId,
    policy: input.policy,
    lines: input.lines.map((line) => ({ ref: line.ref, qtyDelta: sign * line.qty })),
  });
}
