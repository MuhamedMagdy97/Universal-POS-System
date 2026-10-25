import "server-only";
/**
 * Variant services (T3.4). Flat variants with free-text names; `null`
 * price/cost = inherit from the product. The variant must belong to the given
 * product in the caller's org, otherwise 404.
 */
import type { z } from "zod";
import { notFound } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import { assertBuiltIn, assertSyncedFieldsUnchanged } from "@/modules/integrations/inventory-sys/source";
import { assertFresh, conflict, invalid } from "./errors";
import {
  audit,
  canSeeCost,
  db,
  inTx,
  parseId,
  requirePermission,
  toVariant,
  visibleWarnings,
  withUniqueMapping,
  type CatalogMeta,
  type Tx,
} from "./internal";
import { insertBarcode } from "./barcodes";
import { hasUnvariantedStock } from "@/modules/inventory/queries";
import { lockProducts } from "./seam";
import { diffFields, nextUpdatedAt, priceWarnings, type CatalogWarning } from "./rules";
import {
  ArchiveInput,
  CreateVariant,
  UpdateVariant,
  type CreateVariant as CreateVariantData,
  type CreateVariantInput,
  type UpdateVariant as UpdateVariantData,
  type VariantDetail,
} from "./schemas";

export type VariantWriteResult = VariantDetail & { warnings: CatalogWarning[] };
export type UpdateVariantInput = z.input<typeof UpdateVariant>;

type ProductRecord = NonNullable<Awaited<ReturnType<Tx["product"]["findFirst"]>>>;
export type VariantRecord = NonNullable<Awaited<ReturnType<Tx["productVariant"]["findFirst"]>>>;
export type VariantPatch = Omit<UpdateVariantData, "expectedUpdatedAt">;

async function loadProduct(tx: Tx, ctx: TenantContext, productId: string) {
  const product = await tx.product.findFirst({ where: { id: productId, orgId: ctx.orgId } });
  if (!product) throw notFound("Product");
  return product;
}

export async function loadVariant(tx: Tx, ctx: TenantContext, productId: string, variantId: string) {
  const variant = await tx.productVariant.findFirst({ where: { id: variantId, orgId: ctx.orgId, productId } });
  if (!variant) throw notFound("Variant");
  return variant;
}

async function variantOrThrow(ctx: TenantContext, productId: string, variantId: string): Promise<VariantDetail> {
  const row = await db().productVariant.findFirst({ where: { id: variantId, orgId: ctx.orgId, productId } });
  if (!row) throw notFound("Variant");
  return toVariant(row, canSeeCost(ctx));
}

/**
 * Inserts a variant and its barcodes inside `tx` (sets `product.hasVariants`),
 * with the `catalog.variant.created` / `catalog.barcode.added` audit rows.
 * Shared by `createVariant` and the aggregate save. Returns the price warnings
 * resolved against the product. Unique violations surface as raw P2002.
 */
export async function insertVariant(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  product: Pick<ProductRecord, "id" | "hasVariants" | "priceMinor" | "costMinor" | "unitType">,
  data: CreateVariantData,
): Promise<{ variant: VariantRecord; warnings: CatalogWarning[] }> {
  // A weighed product is sold by its own weight: no variants (weighed-selling-spec W4).
  if (product.unitType === "KG") throw invalid("UNIT_NOT_SUPPORTED");
  // A service is one priced item (salon-spec S2).
  if ((await tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { isService: true } })).isService) {
    throw invalid("SERVICE_NOT_SUPPORTED");
  }
  // Options and variants do not mix (restaurant-cafe-spec R7).
  if (await tx.productOptionGroup.count({ where: { orgId: ctx.orgId, productId: product.id } })) {
    throw invalid("OPTIONS_NOT_SUPPORTED");
  }
  if (!product.hasVariants) {
    // Lock, then re-read: a sale that was in flight must commit (or not) before we look (R1).
    await lockProducts(tx, ctx.orgId, [product.id]);
    const current = await tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { hasVariants: true } });
    if (!current.hasVariants) {
      // Stock and ledger rows recorded without a variant would be orphaned by the switch (T4, I-10).
      if (await hasUnvariantedStock(tx, ctx.orgId, product.id)) throw conflict("PRODUCT_HAS_STOCK");
      await tx.product.update({ where: { id: product.id }, data: { hasVariants: true } });
    }
  }
  const variant = await tx.productVariant.create({
    data: {
      orgId: ctx.orgId,
      productId: product.id,
      sku: data.sku,
      name: data.name,
      nameAr: data.nameAr ?? null,
      priceMinor: data.priceMinor,
      costMinor: data.costMinor,
    },
  });
  await audit(tx, ctx, meta, "catalog.variant.created", "ProductVariant", variant.id, {
    productId: product.id,
    sku: variant.sku,
    name: variant.name,
    priceMinor: variant.priceMinor,
    costMinor: variant.costMinor,
  });
  for (const code of data.barcodes) {
    await insertBarcode(tx, ctx, meta, { code, productId: product.id, variantId: variant.id, isPrimary: false });
  }
  return {
    variant,
    warnings: priceWarnings(variant.priceMinor ?? product.priceMinor, variant.costMinor ?? product.costMinor),
  };
}

/**
 * Applies a variant PATCH to `current` (loaded and freshness-checked in `tx`).
 * Price/cost changes write `catalog.variant.price_changed`; other fields
 * `catalog.variant.updated`. Returns the (possibly unchanged) row and warnings
 * resolved against `product`.
 */
export async function applyVariantUpdate(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  product: Pick<ProductRecord, "priceMinor" | "costMinor">,
  current: VariantRecord,
  patch: VariantPatch,
): Promise<{ variant: VariantRecord; warnings: CatalogWarning[] }> {
  const { priceMinor, costMinor, ...rest } = patch;
  const priceChanges = diffFields(
    { priceMinor: current.priceMinor, costMinor: current.costMinor },
    { priceMinor, costMinor },
  );
  const otherChanges = diffFields({ sku: current.sku, name: current.name, nameAr: current.nameAr }, rest);
  const finalPrice = priceMinor !== undefined ? priceMinor : current.priceMinor;
  const finalCost = costMinor !== undefined ? costMinor : current.costMinor;
  const warnings = priceWarnings(finalPrice ?? product.priceMinor, finalCost ?? product.costMinor);
  if (Object.keys(priceChanges).length === 0 && Object.keys(otherChanges).length === 0) {
    return { variant: current, warnings };
  }

  const where = { id: current.id, orgId: ctx.orgId, productId: current.productId };
  const updated = await tx.productVariant.updateMany({
    where: { ...where, updatedAt: current.updatedAt },
    data: { ...rest, priceMinor: finalPrice, costMinor: finalCost, updatedAt: nextUpdatedAt(current.updatedAt) },
  });
  if (updated.count !== 1) throw conflict("STALE_WRITE");

  if (Object.keys(otherChanges).length > 0) {
    await audit(tx, ctx, meta, "catalog.variant.updated", "ProductVariant", current.id, {
      productId: current.productId,
      changes: otherChanges,
    });
  }
  if (Object.keys(priceChanges).length > 0) {
    await audit(tx, ctx, meta, "catalog.variant.price_changed", "ProductVariant", current.id, {
      productId: current.productId,
      ...priceChanges,
    });
  }
  return { variant: await loadVariant(tx, ctx, current.productId, current.id), warnings };
}

/**
 * Archives/restores `current` (loaded and freshness-checked in `tx`) with its
 * audit row. 409 ALREADY_ARCHIVED / NOT_ARCHIVED when it already has that state.
 * `hasVariants` stays true even when the last variant is archived (resolution R10).
 */
export async function applyVariantActive(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  current: VariantRecord,
  active: boolean,
): Promise<void> {
  if (current.isActive === active) throw conflict(active ? "NOT_ARCHIVED" : "ALREADY_ARCHIVED");
  const updated = await tx.productVariant.updateMany({
    where: { id: current.id, orgId: ctx.orgId, productId: current.productId, updatedAt: current.updatedAt },
    data: { isActive: active, updatedAt: nextUpdatedAt(current.updatedAt) },
  });
  if (updated.count !== 1) throw conflict("STALE_WRITE");
  await audit(
    tx,
    ctx,
    meta,
    active ? "catalog.variant.restored" : "catalog.variant.archived",
    "ProductVariant",
    current.id,
    { productId: current.productId, sku: current.sku },
  );
}

/**
 * Adds a variant (with optional barcodes) and sets `product.hasVariants` in the
 * same transaction. The flag never flips back off while variants exist.
 */
export async function createVariant(
  ctx: TenantContext,
  productId: string,
  input: CreateVariantInput,
  meta?: CatalogMeta,
): Promise<VariantWriteResult> {
  await requirePermission(ctx, "products.create", { entityType: "ProductVariant", operation: "create", meta });
  const pid = parseId(productId, "Product");
  const data = CreateVariant.parse(input);
  await assertBuiltIn(ctx.orgId);

  const result = await withUniqueMapping(ctx, { sku: data.sku, codes: data.barcodes }, () =>
    inTx(async (tx) => insertVariant(tx, ctx, meta, await loadProduct(tx, ctx, pid), data)),
  );

  return { ...toVariant(result.variant, canSeeCost(ctx)), warnings: visibleWarnings(ctx, result.warnings) };
}

/** PATCH. Price/cost changes write `catalog.variant.price_changed`; other fields `catalog.variant.updated`. */
export async function updateVariant(
  ctx: TenantContext,
  productId: string,
  variantId: string,
  input: UpdateVariantInput,
  meta?: CatalogMeta,
): Promise<VariantWriteResult> {
  await requirePermission(ctx, "products.update", { entityType: "ProductVariant", operation: "update", meta });
  const pid = parseId(productId, "Product");
  const vid = parseId(variantId, "Variant");
  const { expectedUpdatedAt, ...patch } = UpdateVariant.parse(input);

  const result = await withUniqueMapping(ctx, { sku: patch.sku }, () =>
    inTx(async (tx) => {
      const product = await loadProduct(tx, ctx, pid);
      const current = await loadVariant(tx, ctx, pid, vid);
      assertFresh(current.updatedAt, expectedUpdatedAt);
      const { sku, name, priceMinor, costMinor } = current;
      const synced = Object.keys(
        diffFields(
          { sku, name, priceMinor, costMinor },
          { sku: patch.sku, name: patch.name, priceMinor: patch.priceMinor, costMinor: patch.costMinor },
        ),
      );
      await assertSyncedFieldsUnchanged(ctx.orgId, synced, tx);
      return applyVariantUpdate(tx, ctx, meta, product, current, patch);
    }),
  );

  return { ...toVariant(result.variant, canSeeCost(ctx)), warnings: visibleWarnings(ctx, result.warnings) };
}

async function setVariantActive(
  ctx: TenantContext,
  productId: string,
  variantId: string,
  input: z.input<typeof ArchiveInput>,
  active: boolean,
  meta?: CatalogMeta,
): Promise<VariantDetail> {
  await requirePermission(ctx, "products.update", {
    entityType: "ProductVariant",
    operation: active ? "restore" : "archive",
    meta,
  });
  const pid = parseId(productId, "Product");
  const vid = parseId(variantId, "Variant");
  const { expectedUpdatedAt } = ArchiveInput.parse(input);
  await assertBuiltIn(ctx.orgId);

  await inTx(async (tx) => {
    const current = await loadVariant(tx, ctx, pid, vid);
    if (current.isActive === active) throw conflict(active ? "NOT_ARCHIVED" : "ALREADY_ARCHIVED");
    assertFresh(current.updatedAt, expectedUpdatedAt);
    await applyVariantActive(tx, ctx, meta, current, active);
  });
  return variantOrThrow(ctx, pid, vid);
}

export function archiveVariant(
  ctx: TenantContext,
  productId: string,
  variantId: string,
  input: z.input<typeof ArchiveInput>,
  meta?: CatalogMeta,
): Promise<VariantDetail> {
  return setVariantActive(ctx, productId, variantId, input, false, meta);
}

export function restoreVariant(
  ctx: TenantContext,
  productId: string,
  variantId: string,
  input: z.input<typeof ArchiveInput>,
  meta?: CatalogMeta,
): Promise<VariantDetail> {
  return setVariantActive(ctx, productId, variantId, input, true, meta);
}
