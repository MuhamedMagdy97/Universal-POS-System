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
import {
  audit,
  inTx,
  parseId,
  requirePermission,
  toBarcode,
  withUniqueMapping,
  type CatalogMeta,
  type Tx,
} from "./internal";
import { AddBarcode, type BarcodeDetail } from "./schemas";

type BarcodeRecord = NonNullable<Awaited<ReturnType<Tx["barcode"]["findFirst"]>>>;

/**
 * Checks that a code may be attached to `productId` / `variantId` in `tx`:
 * the variant must belong to the product (422 VARIANT_PRODUCT_MISMATCH), and a
 * product with variants needs one (422 VARIANT_REQUIRED). 404 for unknown ids.
 */
export async function assertBarcodeTarget(
  tx: Tx,
  ctx: TenantContext,
  productId: string,
  variantId: string | null,
): Promise<void> {
  const product = await tx.product.findFirst({
    where: { id: productId, orgId: ctx.orgId },
    select: { id: true, hasVariants: true },
  });
  if (!product) throw notFound("Product");

  if (variantId) {
    const variant = await tx.productVariant.findFirst({
      where: { id: variantId, orgId: ctx.orgId },
      select: { productId: true },
    });
    if (!variant) throw notFound("Variant");
    if (variant.productId !== product.id) throw invalid("VARIANT_PRODUCT_MISMATCH", { field: "variantId" });
  } else if (product.hasVariants) {
    throw invalid("VARIANT_REQUIRED", { field: "variantId" });
  }
}

/**
 * Inserts one barcode (already validated) with its `catalog.barcode.added`
 * audit row. `isPrimary` demotes the item's previous primary barcode first.
 * Unique violations surface as raw P2002 for the caller to map.
 */
export async function insertBarcode(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  data: { code: string; productId: string; variantId: string | null; isPrimary: boolean },
): Promise<BarcodeRecord> {
  if (data.isPrimary) {
    await tx.barcode.updateMany({
      where: { orgId: ctx.orgId, productId: data.productId, variantId: data.variantId, isPrimary: true },
      data: { isPrimary: false },
    });
  }
  const barcode = await tx.barcode.create({
    data: {
      orgId: ctx.orgId,
      code: data.code,
      productId: data.productId,
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
  return barcode;
}

/** Hard-deletes one barcode row (already loaded in `tx`) with its `catalog.barcode.removed` audit row. */
export async function deleteBarcode(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  barcode: Pick<BarcodeRecord, "id" | "code" | "productId" | "variantId">,
): Promise<void> {
  await tx.barcode.delete({ where: { id: barcode.id } });
  await audit(tx, ctx, meta, "catalog.barcode.removed", "Barcode", barcode.id, {
    code: barcode.code,
    productId: barcode.productId,
    variantId: barcode.variantId,
  });
}

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
      await assertBarcodeTarget(tx, ctx, data.productId, data.variantId);
      return toBarcode(await insertBarcode(tx, ctx, meta, data));
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
    await deleteBarcode(tx, ctx, meta, barcode);
  });
}
