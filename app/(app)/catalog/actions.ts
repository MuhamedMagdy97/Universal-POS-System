"use server";
/**
 * Catalog Server Actions: thin adapters over modules/catalog
 * (catalog-api-and-rules.md §1.4). Every action is a public POST, so each one
 * re-resolves the tenant from the session (`requireTenant`), re-parses its
 * input with the catalog zod schemas, and relies on the service's own
 * permission check. Results are `{ ok: true, data } | { ok: false, error }`.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { AppError, toErrorBody, type ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import {
  archiveCategory,
  archiveProduct,
  archiveVariant,
  ArchiveInput,
  createCategory,
  CreateCategory,
  createProductAggregate,
  getProduct,
  restoreCategory,
  restoreProduct,
  restoreVariant,
  updateCategory,
  UpdateCategory,
  updateProductAggregate,
  MAX_VARIANTS_PER_SAVE,
  type CategoryDetail,
  type CreateProductAggregateInput,
  type ProductDetail,
  type ProductWriteResult,
  type UpdateProductAggregateInput,
} from "@/modules/catalog";
import { scopeError, type ActionResult } from "./_lib/form-errors";
import type { SavedProduct } from "./_lib/payloads";

const PRODUCTS_PATH = "/catalog/products";
const CATEGORIES_PATH = "/catalog/categories";

type Session = { ctx: TenantContext; meta: { requestId: string } };

async function session(): Promise<Session> {
  const h = await headers();
  const ctx = await requireTenant(h);
  return { ctx, meta: { requestId: getRequestId(h) } };
}

/** An error body that is already final (field paths scoped, holder named). */
class BodyError extends Error {
  constructor(readonly body: ErrorBody) {
    super(body.message);
  }
}

async function bodyOf(err: unknown, requestId?: string): Promise<ErrorBody> {
  if (err instanceof BodyError) return err.body;
  return actionError(err, "catalog", requestId);
}

async function run<T>(fn: (s: Session) => Promise<T>): Promise<ActionResult<T>> {
  let requestId: string | undefined;
  try {
    const s = await session();
    requestId = s.meta.requestId;
    return { ok: true, data: await fn(s) };
  } catch (err) {
    return { ok: false, error: await bodyOf(err, requestId) };
  }
}

/** Parses with `schema`; a failure becomes a 422 whose paths start at `prefix`. */
function parseAt<S extends z.ZodType>(schema: S, value: unknown, prefix: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BodyError(scopeError(toErrorBody(result.error).body, prefix));
  return result.data;
}

/**
 * Runs a product save and, on a SKU/barcode clash, names the product that
 * already holds it (looked up in the caller's own org only).
 */
async function withHolderName<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "CONFLICT") throw err;
    const body = toErrorBody(err).body;
    const details = body.details as Record<string, unknown> | null;
    if (!details || (details.reason !== "SKU_TAKEN" && details.reason !== "BARCODE_TAKEN")) throw err;
    const productId =
      details.existingType === "variant"
        ? details.existingProductId
        : (details.existingId ?? details.existingProductId);
    if (typeof productId !== "string") throw err;
    let holder: ProductDetail;
    try {
      holder = await getProduct(ctx, productId);
    } catch {
      throw err;
    }
    throw new BodyError({ ...body, details: { ...details, existingName: holder.name, existingNameAr: holder.nameAr } });
  }
}

/** Envelope of the product form; each part is validated by the aggregate schemas in the service. */
const ProductPayload = z.strictObject({
  product: z.record(z.string(), z.unknown()),
  barcodes: z.array(z.unknown()),
  variants: z.array(z.record(z.string(), z.unknown())).max(MAX_VARIANTS_PER_SAVE),
});

/** Drops a blank optional Arabic name (create schemas take `nameAr` as optional, not nullable). */
function withOptionalNameAr(value: Record<string, unknown>): Record<string, unknown> {
  const { nameAr, ...rest } = value;
  return nameAr === null || nameAr === undefined || (typeof nameAr === "string" && nameAr.trim() === "") ? rest : value;
}

/** An empty Arabic name clears it on edit. */
function blankNameArToNull(value: Record<string, unknown>): Record<string, unknown> {
  const { nameAr } = value;
  return typeof nameAr === "string" && nameAr.trim() === "" ? { ...value, nameAr: null } : value;
}

function saved(result: ProductWriteResult): SavedProduct {
  const { warnings, ...product } = result;
  return { product, warnings };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * Creates a product with its barcodes and variants in one transaction
 * (`createProductAggregate`): either everything is saved or nothing is.
 */
export async function createProductAction(input: unknown): Promise<ActionResult<SavedProduct>> {
  return run(async ({ ctx, meta }) => {
    const payload = parseAt(ProductPayload, input, "");
    const aggregate = {
      ...withOptionalNameAr(payload.product),
      barcodes: payload.barcodes,
      variants: payload.variants.map(withOptionalNameAr),
    } as CreateProductAggregateInput; // Untrusted: the service re-parses it with CreateProductAggregate.
    const result = await withHolderName(ctx, () => createProductAggregate(ctx, aggregate, meta));
    revalidatePath(PRODUCTS_PATH);
    return saved(result);
  });
}

/**
 * Saves the edit form in one transaction (`updateProductAggregate`): product
 * fields, product/variant barcodes, edited variants (each with its own
 * `expectedUpdatedAt`) and new variants. Either everything is saved or nothing is.
 */
export async function updateProductAction(productId: string, input: unknown): Promise<ActionResult<SavedProduct>> {
  return run(async ({ ctx, meta }) => {
    const payload = parseAt(ProductPayload, input, "");
    const aggregate = {
      ...payload.product,
      barcodes: payload.barcodes,
      variants: payload.variants.map((v) => (v.id ? blankNameArToNull(v) : withOptionalNameAr(v))),
    } as UpdateProductAggregateInput; // Untrusted: the service re-parses it with UpdateProductAggregate.
    const result = await withHolderName(ctx, () => updateProductAggregate(ctx, productId, aggregate, meta));
    revalidatePath(PRODUCTS_PATH);
    return saved(result);
  });
}

export async function archiveProductAction(productId: string, input: unknown): Promise<ActionResult<ProductDetail>> {
  return run(async ({ ctx, meta }) => {
    const data = parseAt(ArchiveInput, input, "");
    const product = await archiveProduct(ctx, productId, data, meta);
    revalidatePath(PRODUCTS_PATH);
    return product;
  });
}

export async function restoreProductAction(productId: string, input: unknown): Promise<ActionResult<ProductDetail>> {
  return run(async ({ ctx, meta }) => {
    const data = parseAt(ArchiveInput, input, "");
    const product = await restoreProduct(ctx, productId, data, meta);
    revalidatePath(PRODUCTS_PATH);
    return product;
  });
}

export async function archiveVariantAction(
  productId: string,
  variantId: string,
  input: unknown,
): Promise<ActionResult<ProductDetail>> {
  return run(async ({ ctx, meta }) => {
    const data = parseAt(ArchiveInput, input, "");
    await archiveVariant(ctx, productId, variantId, data, meta);
    revalidatePath(PRODUCTS_PATH);
    return getProduct(ctx, productId);
  });
}

export async function restoreVariantAction(
  productId: string,
  variantId: string,
  input: unknown,
): Promise<ActionResult<ProductDetail>> {
  return run(async ({ ctx, meta }) => {
    const data = parseAt(ArchiveInput, input, "");
    await restoreVariant(ctx, productId, variantId, data, meta);
    revalidatePath(PRODUCTS_PATH);
    return getProduct(ctx, productId);
  });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function createCategoryAction(input: unknown): Promise<ActionResult<CategoryDetail>> {
  return run(async ({ ctx, meta }) => {
    const data = parseAt(CreateCategory, input, "");
    const category = await createCategory(ctx, data, meta);
    revalidatePath(CATEGORIES_PATH);
    return category;
  });
}

export async function updateCategoryAction(categoryId: string, input: unknown): Promise<ActionResult<CategoryDetail>> {
  return run(async ({ ctx, meta }) => {
    const data = parseAt(UpdateCategory, input, "");
    const category = await updateCategory(ctx, categoryId, data, meta);
    revalidatePath(CATEGORIES_PATH);
    return category;
  });
}

export async function archiveCategoryAction(categoryId: string, input: unknown): Promise<ActionResult<CategoryDetail>> {
  return run(async ({ ctx, meta }) => {
    const data = parseAt(ArchiveInput, input, "");
    const category = await archiveCategory(ctx, categoryId, data, meta);
    revalidatePath(CATEGORIES_PATH);
    return category;
  });
}

export async function restoreCategoryAction(categoryId: string, input: unknown): Promise<ActionResult<CategoryDetail>> {
  return run(async ({ ctx, meta }) => {
    const data = parseAt(ArchiveInput, input, "");
    const category = await restoreCategory(ctx, categoryId, data, meta);
    revalidatePath(CATEGORIES_PATH);
    return category;
  });
}
