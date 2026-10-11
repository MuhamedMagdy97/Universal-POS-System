import "server-only";
/**
 * Shared plumbing for the catalog services: permission checks, transactions,
 * audit wiring, output mapping (cost stripping) and P2002 → 409 translation.
 * Not exported from modules/catalog/index.ts.
 */
import { getDb, type Db } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import type { RouteMeta } from "@/lib/http";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import type { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditAction } from "@/modules/audit";
import { conflict, uniqueViolation } from "./errors";
import { Uuid, type BarcodeDetail, type ProductDetail, type ProductSummary, type VariantDetail } from "./schemas";
import type { CatalogWarning } from "./rules";

export type Tx = Prisma.TransactionClient;
export type CatalogMeta = Pick<RouteMeta, "requestId"> | undefined;

export function db(): Db {
  return getDb();
}

/** Interactive transaction; every write and its audit rows commit or roll back together. */
export function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().$transaction(fn);
}

/**
 * Permission gate. Write-permission denials are audit-logged (C-14) outside any
 * transaction, so the attempt is recorded even though nothing changes.
 */
export async function requirePermission(
  ctx: TenantContext,
  permission: Permission,
  attempt?: { entityType: string; operation: string; meta?: CatalogMeta },
): Promise<void> {
  if (hasPermission(ctx.role, permission)) return;
  if (attempt) {
    try {
      await record(db(), {
        ctx,
        meta: attempt.meta,
        action: "catalog.permission.denied",
        entityType: attempt.entityType,
        metadata: { permission, operation: attempt.operation },
      });
    } catch {
      // A failed audit write must not turn a 403 into a 500.
    }
  }
  throw forbidden("Missing permission for this action");
}

/** Bad uuid, unknown id and other-tenant id all answer 404. */
export function parseId(id: string, entity: string): string {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound(entity);
  return parsed.data;
}

export function canSeeCost(ctx: TenantContext): boolean {
  return hasPermission(ctx.role, "products.update");
}

export async function audit(
  tx: Tx,
  ctx: TenantContext,
  meta: CatalogMeta,
  action: AuditAction,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await record(tx, { ctx, meta, action, entityType, entityId, metadata });
}

/** Postgres advisory lock scoped to this transaction (serialises e.g. category-tree edits per org). */
export async function lockKey(tx: Tx, scope: string, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scope}), hashtext(${key}))`;
}

// ---------------------------------------------------------------------------
// Output mapping
// ---------------------------------------------------------------------------

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  nameAr: string | null;
  categoryId: string | null;
  unitType: ProductSummary["unitType"];
  priceMinor: number;
  costMinor: number;
  vatCategory: ProductSummary["vatCategory"];
  vatApplicable: boolean;
  hasVariants: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type VariantRow = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  nameAr: string | null;
  priceMinor: number | null;
  costMinor: number | null;
  isActive: boolean;
  updatedAt: Date;
};

type BarcodeRow = { id: string; code: string; productId: string; variantId: string | null; isPrimary: boolean };

export function toSummary(
  row: ProductRow,
  variantCount: number,
  withCost: boolean,
  primaryBarcode: string | null,
): ProductSummary {
  const summary: ProductSummary = {
    id: row.id,
    sku: row.sku,
    name: row.name,
    nameAr: row.nameAr,
    categoryId: row.categoryId,
    unitType: row.unitType,
    priceMinor: row.priceMinor,
    vatCategory: row.vatCategory,
    vatApplicable: row.vatApplicable,
    hasVariants: row.hasVariants,
    variantCount,
    primaryBarcode,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
  if (withCost) summary.costMinor = row.costMinor;
  return summary;
}

export function toVariant(row: VariantRow, withCost: boolean): VariantDetail {
  const variant: VariantDetail = {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    name: row.name,
    nameAr: row.nameAr,
    priceMinor: row.priceMinor,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
  if (withCost) variant.costMinor = row.costMinor;
  return variant;
}

export function toBarcode(row: BarcodeRow): BarcodeDetail {
  return { id: row.id, code: row.code, productId: row.productId, variantId: row.variantId, isPrimary: row.isPrimary };
}

/**
 * Selects the product-level primary barcode (at most one per item, DB unique
 * index `Barcode_one_primary_per_item`). Prisma loads it for a whole page in one
 * batched query, not one per product.
 */
export const PRIMARY_BARCODE_SELECT = {
  where: { isPrimary: true, variantId: null },
  select: { code: true },
  take: 1,
} satisfies Prisma.Product$barcodesArgs;

/** The product-level primary barcode code among `barcodes`, else null. */
export function primaryBarcodeOf(barcodes: readonly BarcodeRow[]): string | null {
  return barcodes.find((b) => b.isPrimary && b.variantId === null)?.code ?? null;
}

export const PRODUCT_DETAIL_INCLUDE = {
  variants: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }] },
  barcodes: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.ProductInclude;

/** Loads a product with variants and barcodes; null when missing or owned by another org. */
export async function loadProductDetail(
  client: Tx | Db,
  ctx: TenantContext,
  productId: string,
): Promise<ProductDetail | null> {
  const row = await client.product.findFirst({
    where: { id: productId, orgId: ctx.orgId },
    include: PRODUCT_DETAIL_INCLUDE,
  });
  if (!row) return null;
  const withCost = canSeeCost(ctx);
  const activeVariants = row.variants.filter((v) => v.isActive).length;
  return {
    ...toSummary(row, activeVariants, withCost, primaryBarcodeOf(row.barcodes)),
    createdAt: row.createdAt.toISOString(),
    variants: row.variants.map((v) => toVariant(v, withCost)),
    barcodes: row.barcodes.map(toBarcode),
  };
}

/** Warnings are shown only to callers who may see cost (otherwise they would leak margin). */
export function visibleWarnings(ctx: TenantContext, warnings: CatalogWarning[]): CatalogWarning[] {
  return canSeeCost(ctx) ? warnings : [];
}

// ---------------------------------------------------------------------------
// P2002 → 409 with { reason, field, existingId }
// ---------------------------------------------------------------------------

export type UniqueHints = {
  sku?: string;
  /** Codes in request order; `field` becomes `barcodes[i]` (or `code` when `barcodeField` is "code"). */
  codes?: string[];
  barcodeField?: "barcodes" | "code";
  category?: { name: string; parentId: string | null };
};

/**
 * Translates a catalog unique violation into a specific 409. `existingId` is
 * looked up inside the caller's org only, after the failed transaction rolled back.
 * Anything else is rethrown unchanged.
 */
export async function rethrowUnique(err: unknown, ctx: TenantContext, hints: UniqueHints): Promise<never> {
  const constraint = uniqueViolation(err);
  if (!constraint) throw err;
  const orgId = ctx.orgId;

  switch (constraint) {
    case "Product_orgId_sku_key":
    case "ProductVariant_orgId_sku_key":
    case "sku_namespace": {
      const sku = hints.sku;
      if (!sku) throw conflict("SKU_TAKEN", { field: "sku", existingId: null });
      const product = await db().product.findFirst({ where: { orgId, sku }, select: { id: true } });
      if (product) throw conflict("SKU_TAKEN", { field: "sku", existingId: product.id, existingType: "product" });
      const variant = await db().productVariant.findFirst({
        where: { orgId, sku },
        select: { id: true, productId: true },
      });
      throw conflict("SKU_TAKEN", {
        field: "sku",
        existingId: variant?.id ?? null,
        existingType: variant ? "variant" : null,
        existingProductId: variant?.productId ?? null,
      });
    }
    case "Barcode_orgId_code_key": {
      const codes = hints.codes ?? [];
      const taken = await db().barcode.findMany({
        where: { orgId, code: { in: codes } },
        select: { code: true, productId: true, variantId: true },
      });
      const index = codes.findIndex((code) => taken.some((t) => t.code === code));
      const hit = taken.find((t) => t.code === codes[index]);
      throw conflict("BARCODE_TAKEN", {
        field: hints.barcodeField === "code" ? "code" : index >= 0 ? `barcodes[${index}]` : "barcodes",
        code: hit?.code ?? null,
        // The product that already owns the code (C-18 "names P").
        existingId: hit?.productId ?? null,
        existingVariantId: hit?.variantId ?? null,
      });
    }
    case "Category_sibling_name_key": {
      const category = hints.category;
      const siblings = category
        ? await db().category.findMany({
            where: { orgId, parentId: category.parentId },
            select: { id: true, name: true },
          })
        : [];
      const wanted = category?.name.toLowerCase();
      const sibling = siblings.find((s) => s.name.toLowerCase() === wanted);
      throw conflict("NAME_TAKEN", { field: "name", existingId: sibling?.id ?? null });
    }
    case "Barcode_one_primary_per_item":
      throw conflict("PRIMARY_BARCODE_TAKEN", { field: "isPrimary", existingId: null });
  }
}

/** Runs a write and maps unique violations to catalog 409s. */
export async function withUniqueMapping<T>(
  ctx: TenantContext,
  hints: UniqueHints | (() => UniqueHints),
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return rethrowUnique(err, ctx, typeof hints === "function" ? hints() : hints);
  }
}
