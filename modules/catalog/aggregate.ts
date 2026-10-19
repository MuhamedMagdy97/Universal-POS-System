import "server-only";
/**
 * Aggregate product save: product fields, variant creates/edits/archives and
 * barcode adds/removes in ONE transaction, so a failing variant or barcode
 * rolls back everything (audit rows included). Reuses the per-entity write
 * helpers, so validation, concurrency checks and audit events are the same as
 * the single-entity services. Errors carry a `details.field` that names the
 * failing row: `sku`, `barcodes[0]`, `variants[1].sku`, `variants[1].barcodes[0]`.
 */
import { AppError, notFound } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import { assertBuiltIn, assertSyncedFieldsUnchanged } from "@/modules/integrations/inventory-sys/source";
import { assertFresh, uniqueViolation } from "./errors";
import {
  inTx,
  parseId,
  requirePermission,
  rethrowUnique,
  visibleWarnings,
  type CatalogMeta,
  type UniqueHints,
} from "./internal";
import { assertBarcodeTarget, deleteBarcode, insertBarcode, makePrimaryBarcode } from "./barcodes";
import {
  applyProductUpdate,
  detailOrThrow,
  syncedProductChanges,
  insertProduct,
  loadFreshProduct,
  type ProductWriteResult,
} from "./products";
import { diffFields, priceWarnings, type CatalogWarning } from "./rules";
import {
  CreateProductAggregate,
  UpdateProductAggregate,
  type CreateProductAggregateInput,
  type ProductDetail,
  type UpdateProductAggregateInput,
  type VariantUpsert,
} from "./schemas";
import { applyVariantActive, applyVariantUpdate, insertVariant, type VariantRecord } from "./variants";

/** Where the write in progress belongs in the request, for error mapping. */
type Step = {
  /** Path prefix for the error's own `field` (e.g. `variants[1]`). */
  prefix: string;
  /** Replaces the error's field entirely (e.g. `variants[1].barcodes[0]`). */
  field?: string;
  /** Unique-violation hints for this write (see `rethrowUnique`). */
  hints: UniqueHints;
};

type Track = (step: Step) => void;

function joinField(prefix: string, field: string): string {
  if (!prefix) return field;
  return field ? `${prefix}.${field}` : prefix;
}

/** Re-roots an AppError's `details.field` to the request row of `step`. */
function scoped(err: unknown, step: Step): unknown {
  if (!(err instanceof AppError) || (!step.prefix && !step.field)) return err;
  if (Array.isArray(err.details)) return err;
  const details = (err.details ?? {}) as Record<string, unknown>;
  const own = typeof details.field === "string" ? details.field : "";
  return new AppError(err.code, err.message, { ...details, field: step.field ?? joinField(step.prefix, own) });
}

/**
 * Runs `fn` (which wraps one transaction) and maps a failure to the step that
 * was in progress. Unique violations are translated after the rollback, so the
 * `existingId` lookup sees only committed rows of the caller's org.
 */
async function runSteps<T>(ctx: TenantContext, fn: (track: Track) => Promise<T>): Promise<T> {
  let step: Step = { prefix: "", hints: {} };
  try {
    return await fn((next) => {
      step = next;
    });
  } catch (err) {
    let mapped: unknown = err;
    if (uniqueViolation(err)) {
      mapped = await rethrowUnique(err, ctx, step.hints).catch((e: unknown) => e);
    }
    throw scoped(mapped, step);
  }
}

function result(ctx: TenantContext, detail: ProductDetail, warnings: Set<CatalogWarning>): ProductWriteResult {
  return { ...detail, warnings: visibleWarnings(ctx, [...warnings]) };
}

/**
 * Creates a product, its barcodes and its variants (each with barcodes) in one
 * transaction. Needs `products.create`. Writes the same audit events as
 * `createProduct` + `createVariant`.
 */
export async function createProductAggregate(
  ctx: TenantContext,
  input: CreateProductAggregateInput,
  meta?: CatalogMeta,
): Promise<ProductWriteResult> {
  await requirePermission(ctx, "products.create", { entityType: "Product", operation: "create", meta });
  const { barcodes, variants, ...data } = CreateProductAggregate.parse(input);
  const warnings = new Set<CatalogWarning>(priceWarnings(data.priceMinor, data.costMinor));
  await assertBuiltIn(ctx.orgId);

  const productId = await runSteps(ctx, (track) =>
    inTx(async (tx) => {
      track({ prefix: "", hints: { sku: data.sku, codes: barcodes } });
      const product = await insertProduct(tx, ctx, meta, data, barcodes);
      let hasVariants = product.hasVariants;
      for (const [index, variant] of variants.entries()) {
        track({ prefix: `variants[${index}]`, hints: { sku: variant.sku, codes: variant.barcodes } });
        const created = await insertVariant(tx, ctx, meta, { ...product, hasVariants }, variant);
        hasVariants = true;
        created.warnings.forEach((w) => warnings.add(w));
      }
      return product.id;
    }),
  );

  return result(ctx, await detailOrThrow(ctx, productId), warnings);
}

type VariantEdit = { index: number; row: VariantUpsert; existing: VariantRecord };
type BarcodePlan = {
  variantId: string | null;
  /** Field path of the list, e.g. `barcodes` or `variants[1].barcodes`. */
  path: string;
  desired: string[];
  current: { id: string; code: string; productId: string; variantId: string | null; isPrimary: boolean }[];
};

function variantChanged(edit: VariantEdit): boolean {
  const { row, existing } = edit;
  const changes = diffFields(
    {
      sku: existing.sku,
      name: existing.name,
      nameAr: existing.nameAr,
      priceMinor: existing.priceMinor,
      costMinor: existing.costMinor,
    },
    { sku: row.sku, name: row.name, nameAr: row.nameAr, priceMinor: row.priceMinor, costMinor: row.costMinor },
  );
  return Object.keys(changes).length > 0 || (row.isActive !== undefined && row.isActive !== existing.isActive);
}

/**
 * Saves the whole edit form in one transaction: product fields
 * (`expectedUpdatedAt`), product-level barcodes (desired list), variant edits
 * (each with its own `expectedUpdatedAt`; `isActive` archives/restores),
 * variant barcodes and new variants. Needs `products.update`, plus
 * `products.create` when it adds a variant or barcode. The first code of each
 * barcode list is that item's primary barcode.
 *
 * Order: product → barcode removals → barcode additions → variant edits →
 * new variants, so a code can move between items in one save. Any change
 * bumps the product's `updatedAt`, so another open form of it becomes stale.
 */
export async function updateProductAggregate(
  ctx: TenantContext,
  productId: string,
  input: UpdateProductAggregateInput,
  meta?: CatalogMeta,
): Promise<ProductWriteResult> {
  await requirePermission(ctx, "products.update", { entityType: "Product", operation: "update", meta });
  const id = parseId(productId, "Product");
  const {
    expectedUpdatedAt,
    barcodes: desiredCodes,
    variants: rows = [],
    ...patch
  } = UpdateProductAggregate.parse(input);
  const warnings = new Set<CatalogWarning>();

  await runSteps(ctx, (track) =>
    inTx(async (tx) => {
      track({ prefix: "", hints: { sku: patch.sku } });
      const current = await loadFreshProduct(tx, ctx, id, expectedUpdatedAt);
      const [variants, barcodes] = [
        await tx.productVariant.findMany({ where: { orgId: ctx.orgId, productId: id } }),
        await tx.barcode.findMany({ where: { orgId: ctx.orgId, productId: id } }),
      ];

      const edits: VariantEdit[] = [];
      const creates: { index: number; row: VariantUpsert }[] = [];
      for (const [index, row] of rows.entries()) {
        if (!row.id) {
          creates.push({ index, row });
          continue;
        }
        track({ prefix: `variants[${index}]`, hints: {} });
        const existing = variants.find((v) => v.id === row.id);
        if (!existing) throw notFound("Variant");
        assertFresh(existing.updatedAt, row.expectedUpdatedAt ?? "");
        edits.push({ index, row, existing });
      }

      const plans: BarcodePlan[] = [];
      const codesOf = (variantId: string | null) => barcodes.filter((b) => b.variantId === variantId);
      if (desiredCodes)
        plans.push({ variantId: null, path: "barcodes", desired: desiredCodes, current: codesOf(null) });
      for (const { index, row, existing } of edits) {
        if (row.barcodes) {
          plans.push({
            variantId: existing.id,
            path: `variants[${index}].barcodes`,
            desired: row.barcodes,
            current: codesOf(existing.id),
          });
        }
      }
      const removals = plans.flatMap((plan) =>
        plan.current.filter((b) => !plan.desired.includes(b.code)).map((barcode) => ({ plan, barcode })),
      );
      const additions = plans.flatMap((plan) =>
        plan.desired.flatMap((code, index) =>
          plan.current.some((b) => b.code === code) ? [] : [{ plan, code, index }],
        ),
      );
      // The first code of each list is the item's primary barcode.
      const promotions = plans.flatMap((plan) => {
        const first = plan.current.find((b) => b.code === plan.desired[0]);
        return first && !first.isPrimary ? [{ plan, code: first.code }] : [];
      });
      const changedEdits = edits.filter(variantChanged);

      // Linked shop (integration spec I8): only the POS-owned fields (Arabic names, VAT) may change.
      await assertSyncedFieldsUnchanged(
        ctx.orgId,
        [
          ...syncedProductChanges(current, patch),
          ...(removals.length + additions.length + promotions.length > 0 ? ["barcodes"] : []),
          ...(creates.length > 0 ? ["variants"] : []),
          ...changedEdits.flatMap(({ index, row, existing }) =>
            Object.keys(
              diffFields(
                {
                  sku: existing.sku,
                  name: existing.name,
                  priceMinor: existing.priceMinor,
                  costMinor: existing.costMinor,
                  isActive: existing.isActive,
                },
                {
                  sku: row.sku,
                  name: row.name,
                  priceMinor: row.priceMinor,
                  costMinor: row.costMinor,
                  isActive: row.isActive,
                },
              ),
            ).map((field) => `variants[${index}].${field}`),
          ),
        ],
        tx,
      );

      if (additions.length > 0 || creates.length > 0) {
        await requirePermission(ctx, "products.create", { entityType: "Product", operation: "update", meta });
      }

      track({ prefix: "", hints: { sku: patch.sku } });
      const touch =
        removals.length > 0 ||
        additions.length > 0 ||
        promotions.length > 0 ||
        changedEdits.length > 0 ||
        creates.length > 0;
      const { finalPrice, finalCost } = await applyProductUpdate(tx, ctx, meta, current, patch, { touch });
      priceWarnings(finalPrice, finalCost).forEach((w) => warnings.add(w));
      const priced = { priceMinor: finalPrice, costMinor: finalCost };

      // An existing first code is promoted before removals, so removing the
      // old primary does not promote some other code first.
      for (const { plan, code } of promotions) {
        track({ prefix: "", field: `${plan.path}[0]`, hints: {} });
        await makePrimaryBarcode(tx, ctx, meta, { productId: id, variantId: plan.variantId }, code);
      }
      for (const { plan, barcode } of removals) {
        track({ prefix: plan.path, hints: {} });
        await deleteBarcode(tx, ctx, meta, barcode);
      }
      for (const { plan, code, index } of additions) {
        track({ prefix: "", field: `${plan.path}[${index}]`, hints: { codes: [code], barcodeField: "code" } });
        await assertBarcodeTarget(tx, ctx, id, plan.variantId);
        await insertBarcode(tx, ctx, meta, {
          code,
          productId: id,
          variantId: plan.variantId,
          isPrimary: index === 0,
        });
      }

      for (const edit of changedEdits) {
        const { index, row, existing } = edit;
        track({ prefix: `variants[${index}]`, hints: { sku: row.sku } });
        const updated = await applyVariantUpdate(tx, ctx, meta, priced, existing, {
          sku: row.sku,
          name: row.name,
          nameAr: row.nameAr,
          priceMinor: row.priceMinor,
          costMinor: row.costMinor,
        });
        updated.warnings.forEach((w) => warnings.add(w));
        if (row.isActive !== undefined && row.isActive !== existing.isActive) {
          await applyVariantActive(tx, ctx, meta, updated.variant, row.isActive);
        }
      }

      let hasVariants = current.hasVariants;
      for (const { index, row } of creates) {
        const codes = row.barcodes ?? [];
        track({ prefix: `variants[${index}]`, hints: { sku: row.sku, codes } });
        const created = await insertVariant(
          tx,
          ctx,
          meta,
          { id, hasVariants, ...priced },
          {
            sku: row.sku,
            name: row.name,
            nameAr: row.nameAr ?? undefined,
            priceMinor: row.priceMinor ?? null,
            costMinor: row.costMinor ?? null,
            barcodes: codes,
          },
        );
        hasVariants = true;
        created.warnings.forEach((w) => warnings.add(w));
      }
    }),
  );

  return result(ctx, await detailOrThrow(ctx, id), warnings);
}
