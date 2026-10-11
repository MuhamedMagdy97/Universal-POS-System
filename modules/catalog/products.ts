import "server-only";
/**
 * Product services (T3.4). Signatures: `(ctx, input, meta?)`. Each function
 * checks its own permission; inputs are parsed with the zod schemas here, so
 * callers cannot skip normalisation (SKU upper-casing, trimming).
 * See catalog-api-and-rules.md §2, §4, §5, §6.
 */
import type { z } from "zod";
import { notFound } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import type { Prisma } from "@/lib/generated/prisma/client";
import { assertFresh, conflict } from "./errors";
import {
  audit,
  canSeeCost,
  db,
  inTx,
  loadProductDetail,
  parseId,
  requirePermission,
  toSummary,
  visibleWarnings,
  withUniqueMapping,
  type CatalogMeta,
  type Tx,
} from "./internal";
import { insertBarcode } from "./barcodes";
import { assertAssignableCategory } from "./categories";
import {
  diffFields,
  escapeLike,
  isBarcodeCandidate,
  nextUpdatedAt,
  priceWarnings,
  sortKeyOf,
  startCursorKey,
} from "./rules";
import type { CatalogWarning } from "./rules";
import {
  ArchiveInput,
  CreateProduct,
  encodeCursor,
  ListProductsQuery,
  UpdateProduct,
  type CreateProduct as CreateProductData,
  type CreateProductInput,
  type ListProductsQueryInput,
  type Page,
  type ProductDetail,
  type ProductSort,
  type ProductSummary,
  type UpdateProduct as UpdateProductData,
} from "./schemas";

export type ProductWriteResult = ProductDetail & { warnings: CatalogWarning[] };

type ArchiveInputType = z.input<typeof ArchiveInput>;
export type UpdateProductInput = z.input<typeof UpdateProduct>;

export async function detailOrThrow(ctx: TenantContext, productId: string): Promise<ProductDetail> {
  const detail = await loadProductDetail(db(), ctx, productId);
  if (!detail) throw notFound("Product");
  return detail;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Cursor-paginated list/search. With `q`: an exact barcode hit comes first
 * (page 1 only), then a case-insensitive contains-match over sku/name/nameAr.
 * Sort `name` = name ASC, id ASC; `updatedAt` = updatedAt DESC, id DESC.
 */
export async function listProducts(
  ctx: TenantContext,
  input: ListProductsQueryInput = {},
): Promise<Page<ProductSummary>> {
  await requirePermission(ctx, "products.read");
  const query = ListProductsQuery.parse(input);
  const withCost = canSeeCost(ctx);

  const base: Prisma.ProductWhereInput = { orgId: ctx.orgId };
  if (query.status === "active") base.isActive = true;
  if (query.status === "archived") base.isActive = false;
  if (query.categoryId) base.categoryId = query.categoryId;

  // Exact barcode match (case-sensitive, like the scanner lookup).
  let barcodeHit: string | null = null;
  if (query.q && isBarcodeCandidate(query.q)) {
    const barcode = await db().barcode.findFirst({
      where: { orgId: ctx.orgId, code: query.q, product: base },
      select: { productId: true },
    });
    barcodeHit = barcode?.productId ?? null;
  }

  const where: Prisma.ProductWhereInput = { ...base };
  const and: Prisma.ProductWhereInput[] = [];
  if (query.q) {
    const pattern = escapeLike(query.q);
    and.push({
      OR: [
        { sku: { contains: pattern, mode: "insensitive" } },
        { name: { contains: pattern, mode: "insensitive" } },
        { nameAr: { contains: pattern, mode: "insensitive" } },
      ],
    });
  }
  if (barcodeHit) and.push({ id: { not: barcodeHit } });

  const prependHit = barcodeHit !== null && !query.cursor;
  const cursor = query.cursor ?? null;
  if (cursor) and.push(afterCursor(query.sort, cursor));
  if (and.length > 0) where.AND = and;

  const take = query.limit - (prependHit ? 1 : 0);
  const select = {
    id: true,
    sku: true,
    name: true,
    nameAr: true,
    categoryId: true,
    unitType: true,
    priceMinor: true,
    costMinor: true,
    vatCategory: true,
    vatApplicable: true,
    hasVariants: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { variants: { where: { isActive: true } } } },
  } satisfies Prisma.ProductSelect;

  const rows = await db().product.findMany({
    where,
    select,
    orderBy: query.sort === "name" ? [{ name: "asc" }, { id: "asc" }] : [{ updatedAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });

  const hasMore = rows.length > take;
  const pageRows = rows.slice(0, take);
  const items = pageRows.map((r) => toSummary(r, r._count.variants, withCost));

  if (prependHit && barcodeHit) {
    const hit = await db().product.findFirst({ where: { id: barcodeHit, orgId: ctx.orgId }, select });
    if (hit) items.unshift(toSummary(hit, hit._count.variants, withCost));
  }

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows.at(-1);
    if (last) {
      nextCursor = encodeCursor(sortKeyOf(last, query.sort), last.id);
    } else {
      // Page 1 held only the barcode hit; the contains-match stream starts from the top.
      const start = startCursorKey(query.sort);
      nextCursor = encodeCursor(start.sortKey, start.id);
    }
  }
  return { items, nextCursor };
}

function afterCursor(sort: ProductSort, cursor: { sortKey: string; id: string }): Prisma.ProductWhereInput {
  if (sort === "name") {
    return { OR: [{ name: { gt: cursor.sortKey } }, { name: cursor.sortKey, id: { gt: cursor.id } }] };
  }
  const at = new Date(cursor.sortKey);
  if (Number.isNaN(at.getTime())) return { id: { in: [] } };
  return { OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: cursor.id } }] };
}

export async function getProduct(ctx: TenantContext, productId: string): Promise<ProductDetail> {
  await requirePermission(ctx, "products.read");
  return detailOrThrow(ctx, parseId(productId, "Product"));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createProduct(
  ctx: TenantContext,
  input: CreateProductInput,
  meta?: CatalogMeta,
): Promise<ProductWriteResult> {
  await requirePermission(ctx, "products.create", { entityType: "Product", operation: "create", meta });
  const { barcodes, ...data } = CreateProduct.parse(input);

  const productId = await withUniqueMapping(ctx, { sku: data.sku, codes: barcodes }, () =>
    inTx(async (tx) => (await insertProduct(tx, ctx, meta, data, barcodes)).id),
  );

  const detail = await detailOrThrow(ctx, productId);
  return { ...detail, warnings: visibleWarnings(ctx, priceWarnings(data.priceMinor, data.costMinor)) };
}

/** Product fields of a create, already parsed by `CreateProduct`. */
export type ProductCreateData = Omit<CreateProductData, "barcodes">;

/**
 * Inserts a product and its product-level barcodes inside `tx`, with the
 * `catalog.product.created` / `catalog.barcode.added` audit rows. Shared by
 * `createProduct` and the aggregate save; unique violations surface as raw P2002.
 */
export async function insertProduct(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  data: ProductCreateData,
  barcodes: readonly string[],
): Promise<ProductRecord> {
  if (data.categoryId) await assertAssignableCategory(tx, ctx, data.categoryId);
  const vatApplicable = data.vatCategory === "STANDARD";
  const product = await tx.product.create({
    data: {
      orgId: ctx.orgId,
      sku: data.sku,
      name: data.name,
      nameAr: data.nameAr ?? null,
      categoryId: data.categoryId,
      unitType: data.unitType,
      priceMinor: data.priceMinor,
      costMinor: data.costMinor,
      vatCategory: data.vatCategory,
      vatApplicable,
    },
  });
  await audit(tx, ctx, meta, "catalog.product.created", "Product", product.id, {
    sku: product.sku,
    name: product.name,
    priceMinor: product.priceMinor,
    costMinor: product.costMinor,
    vatCategory: product.vatCategory,
    vatApplicable,
    categoryId: product.categoryId,
  });
  for (const code of barcodes) {
    await insertBarcode(tx, ctx, meta, { code, productId: product.id, variantId: null, isPrimary: false });
  }
  return product;
}

export type ProductRecord = NonNullable<Awaited<ReturnType<Tx["product"]["findFirst"]>>>;
export type ProductPatch = Omit<UpdateProductData, "expectedUpdatedAt">;

/** Loads a product of the caller's org inside `tx` (404 otherwise) and checks `expectedUpdatedAt` (409 STALE_WRITE). */
export async function loadFreshProduct(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  expectedUpdatedAt: string,
): Promise<ProductRecord> {
  const current = await tx.product.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!current) throw notFound("Product");
  assertFresh(current.updatedAt, expectedUpdatedAt);
  return current;
}

/**
 * Applies a PATCH to `current` (loaded and freshness-checked in `tx`). Writes
 * `catalog.product.updated` / `.price_changed` as needed. With `touch`, bumps
 * `updatedAt` even when no product field changed: the aggregate save does this
 * so any other open form of the same product becomes stale.
 */
export async function applyProductUpdate(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  current: ProductRecord,
  patch: ProductPatch,
  options: { touch?: boolean } = {},
): Promise<{ finalPrice: number; finalCost: number }> {
  const id = current.id;
  if (patch.categoryId && patch.categoryId !== current.categoryId) {
    await assertAssignableCategory(tx, ctx, patch.categoryId);
  }

  const { priceMinor, costMinor, ...rest } = patch;
  const priceChanges = diffFields(
    { priceMinor: current.priceMinor, costMinor: current.costMinor },
    { priceMinor, costMinor },
  );
  const otherChanges = diffFields(
    {
      sku: current.sku,
      name: current.name,
      nameAr: current.nameAr,
      categoryId: current.categoryId,
      vatCategory: current.vatCategory,
    },
    rest,
  );
  const hasPriceChange = Object.keys(priceChanges).length > 0;
  const hasOtherChange = Object.keys(otherChanges).length > 0;
  const finalPrice = priceMinor ?? current.priceMinor;
  const finalCost = costMinor ?? current.costMinor;
  if (!hasPriceChange && !hasOtherChange && !options.touch) return { finalPrice, finalCost };

  const vatCategory = rest.vatCategory ?? current.vatCategory;
  const updated = await tx.product.updateMany({
    where: { id, orgId: ctx.orgId, updatedAt: current.updatedAt },
    data: {
      ...rest,
      priceMinor: finalPrice,
      costMinor: finalCost,
      vatApplicable: vatCategory === "STANDARD",
      updatedAt: nextUpdatedAt(current.updatedAt),
    },
  });
  if (updated.count !== 1) throw conflict("STALE_WRITE");

  if (hasOtherChange) {
    await audit(tx, ctx, meta, "catalog.product.updated", "Product", id, { changes: otherChanges });
  }
  if (hasPriceChange) {
    await audit(tx, ctx, meta, "catalog.product.price_changed", "Product", id, priceChanges);
  }
  return { finalPrice, finalCost };
}

/**
 * PATCH. A price/cost change writes `catalog.product.price_changed`; any other
 * field change writes `catalog.product.updated` (both when both change).
 * `unitType` is not an input: the strict schema rejects it.
 */
export async function updateProduct(
  ctx: TenantContext,
  productId: string,
  input: UpdateProductInput,
  meta?: CatalogMeta,
): Promise<ProductWriteResult> {
  await requirePermission(ctx, "products.update", { entityType: "Product", operation: "update", meta });
  const id = parseId(productId, "Product");
  const { expectedUpdatedAt, ...patch } = UpdateProduct.parse(input);

  const result = await withUniqueMapping(ctx, { sku: patch.sku }, () =>
    inTx(async (tx) => {
      const current = await loadFreshProduct(tx, ctx, id, expectedUpdatedAt);
      return applyProductUpdate(tx, ctx, meta, current, patch);
    }),
  );

  const detail = await detailOrThrow(ctx, id);
  return { ...detail, warnings: visibleWarnings(ctx, priceWarnings(result.finalPrice, result.finalCost)) };
}

async function setProductActive(
  ctx: TenantContext,
  productId: string,
  input: ArchiveInputType,
  active: boolean,
  meta?: CatalogMeta,
): Promise<ProductDetail> {
  const operation = active ? "restore" : "archive";
  await requirePermission(ctx, "products.update", { entityType: "Product", operation, meta });
  const id = parseId(productId, "Product");
  const { expectedUpdatedAt } = ArchiveInput.parse(input);

  await inTx(async (tx) => {
    const current = await tx.product.findFirst({ where: { id, orgId: ctx.orgId } });
    if (!current) throw notFound("Product");
    if (current.isActive === active) throw conflict(active ? "NOT_ARCHIVED" : "ALREADY_ARCHIVED");
    assertFresh(current.updatedAt, expectedUpdatedAt);
    const updated = await tx.product.updateMany({
      where: { id, orgId: ctx.orgId, updatedAt: current.updatedAt },
      data: { isActive: active, updatedAt: nextUpdatedAt(current.updatedAt) },
    });
    if (updated.count !== 1) throw conflict("STALE_WRITE");
    await audit(tx, ctx, meta, active ? "catalog.product.restored" : "catalog.product.archived", "Product", id, {
      sku: current.sku,
    });
  });
  return detailOrThrow(ctx, id);
}

/** Archive (never delete). 409 ALREADY_ARCHIVED when already archived. Variants keep their own flag. */
export function archiveProduct(
  ctx: TenantContext,
  productId: string,
  input: ArchiveInputType,
  meta?: CatalogMeta,
): Promise<ProductDetail> {
  return setProductActive(ctx, productId, input, false, meta);
}

/** Restore an archived product. 409 NOT_ARCHIVED when it is active. */
export function restoreProduct(
  ctx: TenantContext,
  productId: string,
  input: ArchiveInputType,
  meta?: CatalogMeta,
): Promise<ProductDetail> {
  return setProductActive(ctx, productId, input, true, meta);
}
