import "server-only";
/**
 * Cross-module seam (T3.5): the only way other modules read catalog data.
 * See catalog-api-and-rules.md §4 (lookup), §7 (module boundary), catalog-spec.md R8, R10, R12.
 *
 * Two kinds of function:
 * - `lookupCode`, `searchSellable` take a `TenantContext` and check `products.read`
 *   themselves (POS scan / quick search).
 * - `getSellableItems`, `getItemsForHistory`, `assertStockable` are tx-aware and take
 *   an `orgId` plus a Prisma client or transaction. They do NOT check permissions:
 *   the calling module must already have authorised the operation (e.g. sales.create)
 *   and must pass the orgId from its verified `TenantContext`, never from the client.
 *
 * Catalog never joins stock: the POS combines `lookupCode` with inventory itself.
 */
import type { Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/tenant";
import type { Prisma } from "@/lib/generated/prisma/client";
import { invalid } from "./errors";
import { db, requirePermission, type Tx } from "./internal";
import { escapeLike, isBarcodeCandidate } from "./rules";
import {
  BarcodeCode,
  SearchSellableQuery,
  BrowseSellableQuery,
  Uuid,
  type CatalogItemRef,
  type LookupResult,
  type SearchSellableQueryInput,
  type SellableItem,
  type SellableSummary,
} from "./schemas";
import {
  itemRefViolation,
  lookupReason,
  toSellableItem,
  toSellableSummary,
  variantOptions,
  type SeamProduct,
  type SeamVariant,
} from "./sellable";

/** A Prisma client or an interactive-transaction client. */
export type CatalogClient = Db | Tx;

const PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  nameAr: true,
  unitType: true,
  priceMinor: true,
  costMinor: true,
  vatCategory: true,
  vatApplicable: true,
  hasVariants: true,
  isActive: true,
  categoryId: true,
  isService: true,
  durationMin: true,
  optionGroups: {
    orderBy: [{ sortOrder: "asc" }, { groupId: "asc" }],
    select: {
      group: {
        select: {
          id: true,
          name: true,
          nameAr: true,
          minSelect: true,
          maxSelect: true,
          isActive: true,
          choices: {
            where: { isActive: true },
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
            select: { id: true, name: true, nameAr: true, priceDeltaMinor: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductSelect;

const VARIANT_SELECT = {
  id: true,
  productId: true,
  sku: true,
  name: true,
  nameAr: true,
  priceMinor: true,
  costMinor: true,
  isActive: true,
  sortOrder: true,
} satisfies Prisma.ProductVariantSelect;

const VARIANT_ORDER = [
  { sortOrder: "asc" },
  { name: "asc" },
  { id: "asc" },
] satisfies Prisma.ProductVariantOrderByWithRelationInput[];

function unknownCode(): AppError {
  return new AppError("NOT_FOUND", "No item matches this code", { reason: "UNKNOWN_CODE" });
}

// ---------------------------------------------------------------------------
// Scanner lookup
// ---------------------------------------------------------------------------

/** Barcode (exact, case-sensitive) → product SKU → variant SKU (SKUs upper-cased). */
async function resolveCode(orgId: string, code: string): Promise<CatalogItemRef | null> {
  const barcode = await db().barcode.findFirst({
    where: { orgId, code },
    select: { productId: true, variantId: true },
  });
  if (barcode) return barcode;

  // Products and variants share one SKU namespace (trigger `sku_namespace`): at most one hit.
  const sku = code.toUpperCase();
  const [product, variant] = await Promise.all([
    db().product.findFirst({ where: { orgId, sku }, select: { id: true } }),
    db().productVariant.findFirst({ where: { orgId, sku }, select: { id: true, productId: true } }),
  ]);
  if (product) return { productId: product.id, variantId: null };
  if (variant) return { productId: variant.productId, variantId: variant.id };
  return null;
}

/**
 * POS scan. Archived items still resolve (`sellable:false`, R8) so the cashier
 * sees "Item archived — not for sale" rather than "unknown". A code that points
 * at a product with variants answers `VARIANT_REQUIRED` with a picker list.
 * Never returns cost or stock. Unknown → 404 `UNKNOWN_CODE`.
 */
export async function lookupCode(ctx: TenantContext, code: string): Promise<LookupResult> {
  await requirePermission(ctx, "products.read");
  const parsed = BarcodeCode.safeParse(code);
  if (!parsed.success) throw unknownCode();

  const ref = await resolveCode(ctx.orgId, parsed.data);
  if (!ref) throw unknownCode();

  const product = await db().product.findFirst({
    where: { id: ref.productId, orgId: ctx.orgId },
    select: {
      ...PRODUCT_SELECT,
      variants: {
        where: ref.variantId ? { id: ref.variantId } : { orgId: ctx.orgId },
        select: VARIANT_SELECT,
        orderBy: VARIANT_ORDER,
      },
    },
  });
  if (!product) throw unknownCode();
  const { variants, ...productRow } = product;
  const variant = ref.variantId ? (variants[0] ?? null) : null;
  if (ref.variantId && !variant) throw unknownCode();

  const reason = lookupReason(productRow, variant);
  const result: LookupResult = { ...toSellableSummary(productRow, variant), sellable: reason === null };
  if (reason) result.reason = reason;
  if (reason === "VARIANT_REQUIRED") result.variants = variantOptions(productRow, variants);
  return result;
}

// ---------------------------------------------------------------------------
// POS quick search
// ---------------------------------------------------------------------------

/**
 * Active items matching `q`: an exact barcode hit first, then a case-insensitive
 * contains-match over sku/name/nameAr (same matching as `listProducts`), ordered
 * by product name. Products with variants expand to their active variants (all of
 * them when the product matched; only the matching ones when just a variant did).
 * No cost. `limit` 1–50, default 20.
 */
export async function searchSellable(
  ctx: TenantContext,
  q: string,
  limit?: SearchSellableQueryInput["limit"],
): Promise<SellableSummary[]> {
  await requirePermission(ctx, "products.read");
  const query = SearchSellableQuery.parse({ q, limit });
  const orgId = ctx.orgId;
  const pattern = escapeLike(query.q);
  const contains = { contains: pattern, mode: "insensitive" } as const;
  const textMatch = [{ sku: contains }, { name: contains }, { nameAr: contains }];
  const activeVariants = { where: { isActive: true }, select: VARIANT_SELECT, orderBy: VARIANT_ORDER };

  const [barcode, products, variants] = await Promise.all([
    isBarcodeCandidate(query.q)
      ? db().barcode.findFirst({
          where: { orgId, code: query.q, product: { isActive: true } },
          select: {
            variant: { select: VARIANT_SELECT },
            product: { select: { ...PRODUCT_SELECT, variants: activeVariants } },
          },
        })
      : null,
    db().product.findMany({
      where: { orgId, isActive: true, OR: textMatch },
      select: { ...PRODUCT_SELECT, variants: activeVariants },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: query.limit,
    }),
    db().productVariant.findMany({
      where: { orgId, isActive: true, product: { isActive: true, hasVariants: true }, OR: textMatch },
      select: { ...VARIANT_SELECT, product: { select: PRODUCT_SELECT } },
      orderBy: [{ product: { name: "asc" } }, ...VARIANT_ORDER],
      take: query.limit,
    }),
  ]);

  const out: SellableSummary[] = [];
  const seen = new Set<string>();
  const push = (product: SeamProduct, variant: SeamVariant | null) => {
    if (itemRefViolation(product, variant, { requireActive: true })) return;
    const key = `${product.id}:${variant?.id ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(toSellableSummary(product, variant));
  };
  const pushProduct = (row: SeamProduct & { variants: SeamVariant[] }) => {
    if (row.hasVariants) for (const v of row.variants) push(row, v);
    else push(row, null);
  };

  if (barcode) {
    if (barcode.variant) push(barcode.product, barcode.variant);
    else pushProduct(barcode.product);
  }

  // Merge product matches and variant-only matches by product name (both lists are sorted).
  const productIds = new Set(products.map((p) => p.id));
  const variantOnly = variants.filter((v) => !productIds.has(v.productId));
  let vi = 0;
  for (const product of products) {
    while (vi < variantOnly.length && variantOnly[vi].product.name < product.name) {
      push(variantOnly[vi].product, variantOnly[vi]);
      vi += 1;
    }
    pushProduct(product);
  }
  for (; vi < variantOnly.length; vi += 1) push(variantOnly[vi].product, variantOnly[vi]);

  return out.slice(0, query.limit);
}

/**
 * Till tiles (business-profiles-spec BP7, BP8): active items in one category (or all), by product name, products
 * with variants expanded to their active variants, capped at `limit` (1–60, default 60). No cost.
 */
export async function browseSellable(ctx: TenantContext, input: unknown): Promise<SellableSummary[]> {
  await requirePermission(ctx, "products.read");
  const query = BrowseSellableQuery.parse(input);
  const products = await db().product.findMany({
    where: { orgId: ctx.orgId, isActive: true, ...(query.categoryId && { categoryId: query.categoryId }) },
    select: {
      ...PRODUCT_SELECT,
      variants: { where: { isActive: true }, select: VARIANT_SELECT, orderBy: VARIANT_ORDER },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: query.limit,
  });
  const out = products.flatMap((product) =>
    (product.hasVariants ? product.variants : [null]).flatMap((variant) =>
      itemRefViolation(product, variant, { requireActive: true }) ? [] : [toSellableSummary(product, variant)],
    ),
  );
  return out.slice(0, query.limit);
}

/**
 * Every sellable item with its barcodes, for the till's offline snapshot (offline-till-spec OF7). A product-level
 * barcode of a product with variants is listed on each variant, as `searchSellable` would find them all.
 */
export async function listSellable(ctx: TenantContext): Promise<(SellableSummary & { barcodes: string[] })[]> {
  await requirePermission(ctx, "products.read");
  const orgId = ctx.orgId;
  // ponytail: one unpaged read of the whole active catalog; page it if a shop outgrows a few thousand items.
  const [products, barcodes] = await Promise.all([
    db().product.findMany({
      where: { orgId, isActive: true },
      select: {
        ...PRODUCT_SELECT,
        variants: { where: { isActive: true }, select: VARIANT_SELECT, orderBy: VARIANT_ORDER },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    db().barcode.findMany({ where: { orgId }, select: { code: true, productId: true, variantId: true } }),
  ]);
  const codes = new Map<string, string[]>();
  for (const barcode of barcodes) {
    const key = `${barcode.productId}:${barcode.variantId ?? ""}`;
    codes.set(key, [...(codes.get(key) ?? []), barcode.code]);
  }
  return products.flatMap((product) =>
    (product.hasVariants ? product.variants : [null]).flatMap((variant) =>
      itemRefViolation(product, variant, { requireActive: true })
        ? []
        : [
            {
              ...toSellableSummary(product, variant),
              barcodes: [
                ...(codes.get(`${product.id}:${variant?.id ?? ""}`) ?? []),
                ...(variant ? (codes.get(`${product.id}:`) ?? []) : []),
              ],
            },
          ],
    ),
  );
}

// ---------------------------------------------------------------------------
// Tx-aware functions for other modules (no permission check; see file header)
// ---------------------------------------------------------------------------

function refNotFound(entity: "Product" | "Variant", index: number): AppError {
  return new AppError("NOT_FOUND", `${entity} not found`, { entity, index });
}

/**
 * Resolves refs with one query per entity type. 404 for unknown / other-org /
 * malformed ids; 422 ITEM_NOT_SELLABLE (`details.index`, `details.cause`) for the
 * variant rule and, when `requireActive`, archived items. Rows keep input order.
 */
async function resolveRefs(
  client: CatalogClient,
  orgId: string,
  refs: readonly CatalogItemRef[],
  requireActive: boolean,
): Promise<SellableItem[]> {
  if (refs.length === 0) return [];
  refs.forEach((ref, index) => {
    if (!Uuid.safeParse(ref.productId).success) throw refNotFound("Product", index);
    if (ref.variantId !== null && !Uuid.safeParse(ref.variantId).success) throw refNotFound("Variant", index);
  });

  const productIds = [...new Set(refs.map((r) => r.productId))];
  const variantIds = [...new Set(refs.flatMap((r) => (r.variantId ? [r.variantId] : [])))];
  const [products, variants] = await Promise.all([
    client.product.findMany({ where: { orgId, id: { in: productIds } }, select: PRODUCT_SELECT }),
    variantIds.length > 0
      ? client.productVariant.findMany({ where: { orgId, id: { in: variantIds } }, select: VARIANT_SELECT })
      : Promise.resolve([] as SeamVariant[]),
  ]);
  const productById = new Map<string, SeamProduct>(products.map((p) => [p.id, p]));
  const variantById = new Map<string, SeamVariant>(variants.map((v) => [v.id, v]));

  return refs.map((ref, index) => {
    const product = productById.get(ref.productId);
    if (!product) throw refNotFound("Product", index);
    let variant: SeamVariant | null = null;
    if (ref.variantId !== null) {
      variant = variantById.get(ref.variantId) ?? null;
      if (!variant) throw refNotFound("Variant", index);
    }
    const cause = itemRefViolation(product, variant, { requireActive });
    if (cause) throw invalid("ITEM_NOT_SELLABLE", { index, cause, productId: ref.productId, variantId: ref.variantId });
    return toSellableItem(product, variant);
  });
}

/**
 * Items to sell now (checkout, T6). Rows in input order, duplicates allowed; each
 * carries the SaleItem snapshot fields (`sku` → skuSnapshot, `name` → nameSnapshot,
 * `nameAr` → nameArSnapshot, `unitType`, `vatApplicable`/`vatCategory`), the
 * resolved `unitPriceMinor` and `costMinor` (internal use only).
 * 404 unknown/other-org ref; 422 ITEM_NOT_SELLABLE for archived items or a broken
 * variant rule. Caller must have authorised the operation already.
 */
export function getSellableItems(
  client: CatalogClient,
  orgId: string,
  refs: readonly CatalogItemRef[],
): Promise<SellableItem[]> {
  return resolveRefs(client, orgId, refs, true);
}

/**
 * Same as `getSellableItems` without the active check: archived items resolve
 * (refunds, reports). Caller must have authorised the operation already.
 */
export function getItemsForHistory(
  client: CatalogClient,
  orgId: string,
  refs: readonly CatalogItemRef[],
): Promise<SellableItem[]> {
  return resolveRefs(client, orgId, refs, false);
}

/**
 * Throws unless `ref` may carry stock (inventory T4, purchasing T5): active and
 * the variant rule holds. Same errors as `getSellableItems`.
 */
export async function assertStockable(client: CatalogClient, orgId: string, ref: CatalogItemRef): Promise<void> {
  await resolveRefs(client, orgId, [ref], true);
}

/**
 * Locks the product rows (`SELECT … FOR UPDATE`, in id order) for the rest of `client`'s
 * transaction. Every stock write takes these before its balance rows, and the variant switch
 * takes them before it checks stock, so a sale and a switch serialize (checkout R1).
 */
export async function lockProducts(client: Tx, orgId: string, productIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(productIds)].sort()) {
    await client.$queryRaw`SELECT "id" FROM "Product" WHERE "orgId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
  }
}
