import "server-only";
import type { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import type { AuditRequestMeta } from "@/modules/audit";
import { record } from "@/modules/audit";
import { requireBranch, requirePermission } from "./access";
import { noChange, staleStock } from "./errors";
import { applyLines } from "./ledger";
import { lockBalances, keyOf } from "./locking";
import { AdjustInput, checkAdjustmentDirection } from "./schemas";

/**
 * Stock adjustment (D2, D4, D7). Under the row lock it checks `expectedOnHand` (stale ⇒ 409),
 * turns a counted quantity into a delta, checks the sub-reason's direction, then writes.
 * Adjustments always block negative stock, whatever the org setting says.
 */
export async function adjustStock(
  ctx: TenantContext,
  input: z.input<typeof AdjustInput>,
  meta?: AuditRequestMeta,
): Promise<{ qty: number }> {
  await requirePermission(ctx, "inventory.adjust", { operation: "adjust", entityType: "InventoryMovement", meta });
  const parsed = AdjustInput.parse(input);
  await requireBranch(ctx, parsed.branchId);

  return getDb().$transaction(async (tx) => {
    const key = { branchId: parsed.branchId, ...parsed.ref };
    const locked = await lockBalances(tx, ctx.orgId, [key]);
    const balance = locked.get(keyOf(key));
    if (!balance) throw new Error("balance row missing after lock");

    if (balance.qty !== parsed.expectedOnHand) throw staleStock(balance.qty);

    const delta = parsed.countedQty !== undefined ? parsed.countedQty - balance.qty : (parsed.qtyDelta ?? 0);
    if (delta === 0) throw noChange();
    checkAdjustmentDirection(parsed.adjustmentReason, delta);

    const [after] = await applyLines(tx, ctx, {
      branchId: parsed.branchId,
      reason: "ADJUSTMENT",
      adjustmentReason: parsed.adjustmentReason,
      note: parsed.note ?? null,
      policy: "block",
      lines: [{ ref: parsed.ref, qtyDelta: delta }],
    });

    await record(tx, {
      ctx,
      meta,
      action: "inventory.adjusted",
      entityType: "InventoryMovement",
      metadata: {
        branchId: parsed.branchId,
        ref: parsed.ref,
        adjustmentReason: parsed.adjustmentReason,
        qtyDelta: delta,
        before: balance.qty,
        after: after.qty,
        note: parsed.note ?? null,
      },
    });
    return { qty: after.qty };
  });
}
