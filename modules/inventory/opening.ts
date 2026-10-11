import "server-only";
import type { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import type { AuditRequestMeta } from "@/modules/audit";
import { record } from "@/modules/audit";
import { requireBranch, requirePermission } from "./access";
import { openingExists } from "./errors";
import { applyLines } from "./ledger";
import { lockBalances } from "./locking";
import { OpeningInput, assertNoDuplicateRefs } from "./schemas";

/**
 * Opening stock (D3): one time per item and branch. Allowed only while the item has no ledger
 * rows at that branch. All lines succeed or none do.
 */
export async function recordOpeningBalances(
  ctx: TenantContext,
  input: z.input<typeof OpeningInput>,
  meta?: AuditRequestMeta,
): Promise<{ lines: { ref: { productId: string; variantId: string | null }; qty: number }[] }> {
  await requirePermission(ctx, "inventory.adjust", { operation: "opening", entityType: "InventoryMovement", meta });
  const parsed = OpeningInput.parse(input);
  await requireBranch(ctx, parsed.branchId);
  assertNoDuplicateRefs(parsed.lines.map((line) => line.ref));

  return getDb().$transaction(async (tx) => {
    // Lock first, then look: a concurrent opening waits here and then sees the rows it wrote.
    await lockBalances(
      tx,
      ctx.orgId,
      parsed.lines.map((line) => ({ branchId: parsed.branchId, ...line.ref })),
    );
    const existing = await tx.inventoryMovement.findMany({
      where: {
        orgId: ctx.orgId,
        branchId: parsed.branchId,
        productId: { in: parsed.lines.map((line) => line.ref.productId) },
      },
      select: { productId: true, variantId: true },
    });
    const taken = parsed.lines
      .map((line) => line.ref)
      .filter((ref) => existing.some((row) => row.productId === ref.productId && row.variantId === ref.variantId));
    if (taken.length > 0) throw openingExists(taken);

    const after = await applyLines(tx, ctx, {
      branchId: parsed.branchId,
      reason: "OPENING_BALANCE",
      policy: "block",
      lines: parsed.lines.map((line) => ({ ref: line.ref, qtyDelta: line.qty })),
    });

    await record(tx, {
      ctx,
      meta,
      action: "inventory.opening.recorded",
      entityType: "InventoryMovement",
      metadata: {
        branchId: parsed.branchId,
        lines: parsed.lines.map((line) => ({ ref: line.ref, qty: line.qty })),
      },
    });
    return { lines: after };
  });
}
