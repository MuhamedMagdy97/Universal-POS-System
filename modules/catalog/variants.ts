import "server-only";
/**
 * Variant services (T3.4). Flat variants with free-text names; `null`
 * price/cost = inherit from the product. The variant must belong to the given
 * product in the caller's org, otherwise 404.
 */
import type { z } from "zod";
import { notFound } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import { assertFresh, conflict } from "./errors";
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
import { diffFields, nextUpdatedAt, priceWarnings, type CatalogWarning } from "./rules";
import { ArchiveInput, CreateVariant, UpdateVariant, type CreateVariantInput, type VariantDetail } from "./schemas";

export type VariantWriteResult = VariantDetail & { warnings: CatalogWarning[] };
export type UpdateVariantInput = z.input<typeof UpdateVariant>;

async function loadProduct(tx: Tx, ctx: TenantContext, productId: string) {
  const product = await tx.product.findFirst({ where: { id: productId, orgId: ctx.orgId } });
  if (!product) throw notFound("Product");
  return product;
}

async function loadVariant(tx: Tx, ctx: TenantContext, productId: string, variantId: string) {
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

  const result = await withUniqueMapping(ctx, { sku: data.sku, codes: data.barcodes }, () =>
    inTx(async (tx) => {
      const product = await loadProduct(tx, ctx, pid);
      if (!product.hasVariants) {
        // TODO(T4): before switching a product to variants, ask inventory (and later
        // sales) through their module seam whether stock/sale rows with
        // variantId = NULL exist for it, and reject if so. Catalog must not query
        // those tables directly (seam rule, docs/architecture/system-architecture.md).
        await tx.product.update({ where: { id: product.id }, data: { hasVariants: true } });
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
        const barcode = await tx.barcode.create({
          data: { orgId: ctx.orgId, code, productId: product.id, variantId: variant.id },
        });
        await audit(tx, ctx, meta, "catalog.barcode.added", "Barcode", barcode.id, {
          code,
          productId: product.id,
          variantId: variant.id,
        });
      }
      return {
        variant,
        warnings: priceWarnings(variant.priceMinor ?? product.priceMinor, variant.costMinor ?? product.costMinor),
      };
    }),
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

      const updated = await tx.productVariant.updateMany({
        where: { id: vid, orgId: ctx.orgId, productId: pid, updatedAt: current.updatedAt },
        data: { ...rest, priceMinor: finalPrice, costMinor: finalCost, updatedAt: nextUpdatedAt(current.updatedAt) },
      });
      if (updated.count !== 1) throw conflict("STALE_WRITE");

      if (Object.keys(otherChanges).length > 0) {
        await audit(tx, ctx, meta, "catalog.variant.updated", "ProductVariant", vid, {
          productId: pid,
          changes: otherChanges,
        });
      }
      if (Object.keys(priceChanges).length > 0) {
        await audit(tx, ctx, meta, "catalog.variant.price_changed", "ProductVariant", vid, {
          productId: pid,
          ...priceChanges,
        });
      }
      return { variant: await loadVariant(tx, ctx, pid, vid), warnings };
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

  await inTx(async (tx) => {
    const current = await loadVariant(tx, ctx, pid, vid);
    if (current.isActive === active) throw conflict(active ? "NOT_ARCHIVED" : "ALREADY_ARCHIVED");
    assertFresh(current.updatedAt, expectedUpdatedAt);
    const updated = await tx.productVariant.updateMany({
      where: { id: vid, orgId: ctx.orgId, productId: pid, updatedAt: current.updatedAt },
      data: { isActive: active, updatedAt: nextUpdatedAt(current.updatedAt) },
    });
    if (updated.count !== 1) throw conflict("STALE_WRITE");
    // hasVariants stays true even when the last variant is archived (resolution R10).
    await audit(
      tx,
      ctx,
      meta,
      active ? "catalog.variant.restored" : "catalog.variant.archived",
      "ProductVariant",
      vid,
      { productId: pid, sku: current.sku },
    );
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
