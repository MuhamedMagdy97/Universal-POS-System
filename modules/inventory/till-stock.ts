import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { inventorySourceOf } from "@/modules/integrations/inventory-sys/source";
import { requireBranch, requirePermission } from "./access";
import { getOnHand } from "./queries";
import { Uuid } from "./schemas";

/**
 * On-hand quantities for the till (read-only). Gated on `sales.create`, not `inventory.read`: a
 * cashier who may sell at a branch may see what that branch holds of the items they scan.
 */
export const TillStockInput = z
  .object({
    branchId: Uuid,
    refs: z.array(z.object({ productId: Uuid, variantId: Uuid.nullable() }).strict()).max(50),
  })
  .strict();

export async function getTillOnHand(ctx: TenantContext, input: z.input<typeof TillStockInput>): Promise<number[]> {
  await requirePermission(ctx, "sales.create");
  const parsed = TillStockInput.parse(input);
  await requireBranch(ctx, parsed.branchId);
  // Linked shop: POS stock is history only (integration spec I18); the till shows none until slice 2.
  if ((await inventorySourceOf(ctx.orgId)) === "EXTERNAL") return [];
  return getOnHand(getDb(), ctx.orgId, parsed.branchId, parsed.refs);
}
