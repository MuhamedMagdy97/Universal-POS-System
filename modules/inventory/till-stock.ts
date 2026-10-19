import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { availableAtBranch } from "@/modules/integrations/inventory-sys/postings";
import { inventorySourceOf } from "@/modules/integrations/inventory-sys/source";
import { requireBranch, requirePermission } from "./access";
import { getOnHand } from "./queries";
import { Uuid } from "./schemas";

/**
 * On-hand quantities for the till (read-only). Gated on `sales.create`, not `inventory.read`: a
 * cashier who may sell at a branch may see what that branch holds of the items they scan. A shop
 * linked to the inventory system shows the IMS's available quantity there; null where it is unknown.
 */
export const TillStockInput = z
  .object({
    branchId: Uuid,
    refs: z.array(z.object({ productId: Uuid, variantId: Uuid.nullable() }).strict()).max(50),
  })
  .strict();

export async function getTillOnHand(
  ctx: TenantContext,
  input: z.input<typeof TillStockInput>,
): Promise<(number | null)[]> {
  await requirePermission(ctx, "sales.create");
  const parsed = TillStockInput.parse(input);
  await requireBranch(ctx, parsed.branchId);
  // Linked shop: POS stock is history only (integration spec I18); stock lives in the IMS.
  if ((await inventorySourceOf(ctx.orgId)) === "EXTERNAL") {
    return availableAtBranch(ctx.orgId, parsed.branchId, parsed.refs);
  }
  return getOnHand(getDb(), ctx.orgId, parsed.branchId, parsed.refs);
}
