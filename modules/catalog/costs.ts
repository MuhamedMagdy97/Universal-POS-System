import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { nextUpdatedAt } from "./rules";
import type { CatalogItemRef } from "./schemas";
import type { Tx } from "./internal";

/**
 * Last-cost update from a goods receipt (purchasing P2). Tx-aware seam writer with no permission
 * check: purchasing has authorised the receipt and passes its own transaction, in which the
 * inventory call has already locked these product rows.
 *
 * A variant line sets the variant's own cost; a product line sets the product's. An unchanged
 * cost writes nothing. A change bumps `updatedAt`, so a catalog editor holding the old version
 * gets its usual stale-write 409, and is audited as `catalog.cost.received`.
 */
export async function applyReceivedCosts(
  tx: Tx,
  ctx: TenantContext,
  input: { receiptId: string; lines: readonly { ref: CatalogItemRef; unitCostMinor: number }[] },
  meta?: AuditRequestMeta,
): Promise<void> {
  for (const { ref, unitCostMinor } of input.lines) {
    if (ref.variantId) {
      const variant = await tx.productVariant.findFirstOrThrow({
        where: { id: ref.variantId, orgId: ctx.orgId, productId: ref.productId },
        select: { costMinor: true, updatedAt: true },
      });
      if (variant.costMinor === unitCostMinor) continue;
      await tx.productVariant.update({
        where: { id: ref.variantId },
        data: { costMinor: unitCostMinor, updatedAt: nextUpdatedAt(variant.updatedAt) },
      });
      await audit(tx, ctx, meta, "ProductVariant", ref.variantId, variant.costMinor, unitCostMinor, input.receiptId);
    } else {
      const product = await tx.product.findFirstOrThrow({
        where: { id: ref.productId, orgId: ctx.orgId },
        select: { costMinor: true, updatedAt: true },
      });
      if (product.costMinor === unitCostMinor) continue;
      await tx.product.update({
        where: { id: ref.productId },
        data: { costMinor: unitCostMinor, updatedAt: nextUpdatedAt(product.updatedAt) },
      });
      await audit(tx, ctx, meta, "Product", ref.productId, product.costMinor, unitCostMinor, input.receiptId);
    }
  }
}

function audit(
  tx: Tx,
  ctx: TenantContext,
  meta: AuditRequestMeta | undefined,
  entityType: "Product" | "ProductVariant",
  entityId: string,
  fromMinor: number | null,
  toMinor: number,
  receiptId: string,
) {
  return record(tx, {
    ctx,
    meta,
    action: "catalog.cost.received",
    entityType,
    entityId,
    metadata: { fromMinor, toMinor, goodsReceiptId: receiptId },
  });
}
