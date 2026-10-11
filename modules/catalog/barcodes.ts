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
  lockKey,
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

type BarcodeItem = { productId: string; variantId: string | null };

/**
 * Serialises primary-barcode bookkeeping per item (product-level or one
 * variant) for the rest of `tx`, so concurrent adds/removes on the same item
 * never race on the `Barcode_one_primary_per_item` partial unique index.
 */
async function lockItem(tx: Tx, ctx: TenantContext, item: BarcodeItem): Promise<void> {
  await lockKey(tx, "catalog.barcode.item", `${ctx.orgId}:${item.productId}:${item.variantId ?? ""}`);
}

function primaryOf(tx: Tx, ctx: TenantContext, item: BarcodeItem) {
  return tx.barcode.findFirst({
    where: { orgId: ctx.orgId, productId: item.productId, variantId: item.variantId, isPrimary: true },
    select: { id: true, code: true },
  });
}

type PrimaryReason = "first" | "explicit" | "promoted";

async function auditPrimaryChange(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  item: BarcodeItem,
  next: { id: string; code: string },
  previous: { id: string; code: string } | null,
  reason: PrimaryReason,
): Promise<void> {
  await audit(tx, ctx, meta, "catalog.barcode.primary_changed", "Barcode", next.id, {
    productId: item.productId,
    variantId: item.variantId,
    code: next.code,
    previousId: previous?.id ?? null,
    previousCode: previous?.code ?? null,
    reason,
  });
}

/**
 * Inserts one barcode (already validated) with its `catalog.barcode.added`
 * audit row. "First barcode is primary": the item's first barcode becomes its
 * primary automatically; `isPrimary` moves the primary to the new code (the
 * old one is demoted first). Both write `catalog.barcode.primary_changed`.
 * Unique violations surface as raw P2002 for the caller to map.
 */
export async function insertBarcode(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  data: { code: string; productId: string; variantId: string | null; isPrimary: boolean },
): Promise<BarcodeRecord> {
  const item = { productId: data.productId, variantId: data.variantId };
  await lockItem(tx, ctx, item);
  const previous = await primaryOf(tx, ctx, item);
  const makePrimary = data.isPrimary || previous === null;
  if (makePrimary && previous) {
    await tx.barcode.update({ where: { id: previous.id }, data: { isPrimary: false } });
  }
  const barcode = await tx.barcode.create({
    data: {
      orgId: ctx.orgId,
      code: data.code,
      productId: data.productId,
      variantId: data.variantId,
      isPrimary: makePrimary,
    },
  });
  await audit(tx, ctx, meta, "catalog.barcode.added", "Barcode", barcode.id, {
    code: barcode.code,
    productId: barcode.productId,
    variantId: barcode.variantId,
    isPrimary: barcode.isPrimary,
  });
  if (makePrimary) {
    await auditPrimaryChange(tx, ctx, meta, item, barcode, previous, previous ? "explicit" : "first");
  }
  return barcode;
}

/**
 * Hard-deletes one barcode row with its `catalog.barcode.removed` audit row.
 * When it was the item's primary, the item's next barcode (oldest `createdAt`,
 * then `id`) is promoted in the same transaction.
 */
export async function deleteBarcode(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  barcode: Pick<BarcodeRecord, "id" | "code" | "productId" | "variantId">,
): Promise<void> {
  const item = { productId: barcode.productId, variantId: barcode.variantId };
  await lockItem(tx, ctx, item);
  // The returned row has `isPrimary` as of now (after the lock), not as first loaded.
  const deleted = await tx.barcode.delete({ where: { id: barcode.id } });
  await audit(tx, ctx, meta, "catalog.barcode.removed", "Barcode", barcode.id, {
    code: barcode.code,
    productId: barcode.productId,
    variantId: barcode.variantId,
  });
  if (!deleted.isPrimary) return;
  const next = await tx.barcode.findFirst({
    where: { orgId: ctx.orgId, productId: item.productId, variantId: item.variantId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, code: true },
  });
  if (!next) return;
  await tx.barcode.update({ where: { id: next.id }, data: { isPrimary: true } });
  await auditPrimaryChange(tx, ctx, meta, item, next, { id: deleted.id, code: deleted.code }, "promoted");
}

/**
 * Makes the existing barcode `code` of `item` its primary (demoting the old
 * one first). No-op when it already is, or when the item has no such code.
 */
export async function makePrimaryBarcode(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  item: BarcodeItem,
  code: string,
): Promise<void> {
  await lockItem(tx, ctx, item);
  const target = await tx.barcode.findFirst({
    where: { orgId: ctx.orgId, productId: item.productId, variantId: item.variantId, code },
    select: { id: true, code: true, isPrimary: true },
  });
  if (!target || target.isPrimary) return;
  const previous = await primaryOf(tx, ctx, item);
  if (previous) await tx.barcode.update({ where: { id: previous.id }, data: { isPrimary: false } });
  await tx.barcode.update({ where: { id: target.id }, data: { isPrimary: true } });
  await auditPrimaryChange(tx, ctx, meta, item, target, previous, "explicit");
}

/**
 * Attach a code to a product or one of its variants. A product with variants
 * needs a `variantId` (422 VARIANT_REQUIRED); a variant of another product is
 * 422 VARIANT_PRODUCT_MISMATCH. The item's first barcode becomes its primary;
 * `isPrimary` moves the primary to this code (same transaction).
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

/** Hard delete (audited). The code becomes reusable; a removed primary passes to the item's next barcode. */
export async function removeBarcode(ctx: TenantContext, barcodeId: string, meta?: CatalogMeta): Promise<void> {
  await requirePermission(ctx, "products.update", { entityType: "Barcode", operation: "remove", meta });
  const id = parseId(barcodeId, "Barcode");
  await inTx(async (tx) => {
    const barcode = await tx.barcode.findFirst({ where: { id, orgId: ctx.orgId } });
    if (!barcode) throw notFound("Barcode");
    await deleteBarcode(tx, ctx, meta, barcode);
  });
}
