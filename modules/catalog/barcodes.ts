import "server-only";
/**
 * Barcode services (T3.4). Codes are unique per org across products and
 * variants and stay reserved while their item is archived; removing a barcode
 * is the one hard delete in the catalog (sales snapshot the SKU, not the code).
 * The scanner lookup (`lookupCode`) is part of the cross-module seam (T3.5).
 */
import type { z } from "zod";
import { notFound } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import { invalid } from "./errors";
import { audit, inTx, parseId, requirePermission, toBarcode, withUniqueMapping, type CatalogMeta } from "./internal";
import { AddBarcode, type BarcodeDetail } from "./schemas";

/**
 * Attach a code to a product or one of its variants. A product with variants
 * needs a `variantId` (422 VARIANT_REQUIRED); a variant of another product is
 * 422 VARIANT_PRODUCT_MISMATCH. `isPrimary` demotes the item's previous primary
 * barcode in the same transaction.
 */
export async function addBarcode(
  ctx: TenantContext,
  input: z.input<typeof AddBarcode>,
  meta?: CatalogMeta,
): Promise<BarcodeDetail> {
  await requirePermission(ctx, "products.create", { entityType: "Barcode", operation: "add", meta });
  const data = AddBarcode.parse(input);

  return withUniqueMapping(ctx, { codes: [data.code], barcodeField: "code" }, () =>
    inTx(async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: data.productId, orgId: ctx.orgId },
        select: { id: true, hasVariants: true },
      });
      if (!product) throw notFound("Product");

      if (data.variantId) {
        const variant = await tx.productVariant.findFirst({
          where: { id: data.variantId, orgId: ctx.orgId },
          select: { productId: true },
        });
        if (!variant) throw notFound("Variant");
        if (variant.productId !== product.id) throw invalid("VARIANT_PRODUCT_MISMATCH", { field: "variantId" });
      } else if (product.hasVariants) {
        throw invalid("VARIANT_REQUIRED", { field: "variantId" });
      }

      if (data.isPrimary) {
        await tx.barcode.updateMany({
          where: { orgId: ctx.orgId, productId: product.id, variantId: data.variantId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      const barcode = await tx.barcode.create({
        data: {
          orgId: ctx.orgId,
          code: data.code,
          productId: product.id,
          variantId: data.variantId,
          isPrimary: data.isPrimary,
        },
      });
      await audit(tx, ctx, meta, "catalog.barcode.added", "Barcode", barcode.id, {
        code: barcode.code,
        productId: barcode.productId,
        variantId: barcode.variantId,
        isPrimary: barcode.isPrimary,
      });
      return toBarcode(barcode);
    }),
  );
}

/** Hard delete (audited). The code becomes reusable. */
export async function removeBarcode(ctx: TenantContext, barcodeId: string, meta?: CatalogMeta): Promise<void> {
  await requirePermission(ctx, "products.update", { entityType: "Barcode", operation: "remove", meta });
  const id = parseId(barcodeId, "Barcode");
  await inTx(async (tx) => {
    const barcode = await tx.barcode.findFirst({ where: { id, orgId: ctx.orgId } });
    if (!barcode) throw notFound("Barcode");
    await tx.barcode.delete({ where: { id: barcode.id } });
    await audit(tx, ctx, meta, "catalog.barcode.removed", "Barcode", barcode.id, {
      code: barcode.code,
      productId: barcode.productId,
      variantId: barcode.variantId,
    });
  });
}
