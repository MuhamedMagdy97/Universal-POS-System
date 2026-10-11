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
import { getRequestId } from "@/lib/http";
import { logger } from "@/lib/logger";
import {
  addBarcode,
  archiveCategory,
  archiveProduct,
  archiveVariant,
  ArchiveInput,
  BarcodeList,
  createCategory,
  CreateCategory,
  createProduct,
  CreateProduct,
  createVariant,
  CreateVariant,
  getProduct,
  removeBarcode,
  restoreCategory,
  restoreProduct,
  restoreVariant,
  updateCategory,
  UpdateCategory,
  updateProduct,
  UpdateProduct,
  updateVariant,
  UpdateVariant,
  Uuid,
  type CatalogWarning,
  type CategoryDetail,
  type ProductDetail,
  type VariantDetail,
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

/** An error already scoped to a form field path. */
class StepError extends Error {
  constructor(readonly body: ErrorBody) {
    super(body.message);
  }
}

function bodyOf(err: unknown, requestId?: string): ErrorBody {
  if (err instanceof StepError) return err.body;
  const { status, body } = toErrorBody(err);
  if (status >= 500) logger.error("catalog action failed", { requestId, error: err });
  return body;
}

async function run<T>(fn: (s: Session) => Promise<T>): Promise<ActionResult<T>> {
  let requestId: string | undefined;
  try {
    const s = await session();
    requestId = s.meta.requestId;
    return { ok: true, data: await fn(s) };
  } catch (err) {
    return { ok: false, error: bodyOf(err, requestId) };
  }
}

/** Parses with `schema`; a failure becomes a 422 whose paths start at `prefix`. */
function parseAt<S extends z.ZodType>(schema: S, value: unknown, prefix: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new StepError(scopeError(toErrorBody(result.error).body, prefix));
  return result.data;
}

/**
 * Runs one service call of a multi-step save, re-rooting error paths to the
 * form field (`prefix` / `fieldOverride`) and naming the product that already
 * holds a clashing SKU/barcode (looked up in the caller's own org only).
 */
async function step<T>(ctx: TenantContext, prefix: string, fieldOverride: string | undefined, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StepError) throw err;
    if (!(err instanceof AppError)) throw err;
    const body = scopeError(toErrorBody(err).body, prefix, fieldOverride);
    throw new StepError(await withHolderName(ctx, body));
  }
}

async function withHolderName(ctx: TenantContext, body: ErrorBody): Promise<ErrorBody> {
  const details = body.details as Record<string, unknown> | null;
  if (body.code !== "CONFLICT" || !details) return body;
  if (details.reason !== "SKU_TAKEN" && details.reason !== "BARCODE_TAKEN") return body;
  const productId =
    details.existingType === "variant" ? details.existingProductId : (details.existingId ?? details.existingProductId);
  if (typeof productId !== "string") return body;
  try {
    const holder = await getProduct(ctx, productId);
    return { ...body, details: { ...details, existingName: holder.name, existingNameAr: holder.nameAr } };
  } catch {
    return body;
  }
}

const VariantDraft = z.strictObject({
  id: Uuid.optional(),
  expectedUpdatedAt: z.string().optional(),
  sku: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  priceMinor: z.number().nullable(),
  costMinor: z.number().nullable().optional(),
  barcodes: z.array(z.string()).max(10),
});
type VariantDraft = z.infer<typeof VariantDraft>;

const CreatePayload = z.strictObject({
  product: z.record(z.string(), z.unknown()),
  barcodes: z.array(z.string()).max(10),
  variants: z.array(VariantDraft).max(50),
});

const UpdatePayload = CreatePayload;

/** Drops a blank optional Arabic name (create schemas take `nameAr` as optional, not nullable). */
function withOptionalNameAr<T extends { nameAr?: unknown }>(value: T): Omit<T, "nameAr"> | T {
  const { nameAr, ...rest } = value;
  return nameAr === null || nameAr === undefined || (typeof nameAr === "string" && nameAr.trim() === "") ? rest : value;
}

function variantCreateInput(v: VariantDraft): unknown {
  const { id: _id, expectedUpdatedAt: _expected, ...fields } = v;
  return withOptionalNameAr(fields);
}

function variantUpdateInput(v: VariantDraft): unknown {
  const { id: _id, barcodes: _barcodes, nameAr, ...fields } = v;
  // An empty Arabic name clears it; a missing `expectedUpdatedAt` fails UpdateVariant (422), never skips STALE_WRITE.
  return { ...fields, nameAr: nameAr === null || nameAr.trim() === "" ? null : nameAr };
}

/** Rejects a code that appears twice anywhere in the form (product + variants), before any write. */
function assertNoDuplicateCodes(productCodes: string[], variantCodes: string[][]): void {
  const seen = new Set<string>();
  const issues: { path: string; code: string; message: string }[] = [];
  const check = (codes: string[], prefix: string) =>
    codes.forEach((code, index) => {
      if (seen.has(code)) {
        issues.push({ path: `${prefix}.${index}`, code: "custom", message: "Duplicate barcode in request" });
      }
      seen.add(code);
    });
  check(productCodes, "barcodes");
  variantCodes.forEach((codes, i) => check(codes, `variants.${i}.barcodes`));
  if (issues.length > 0) {
    throw new StepError({ code: "VALIDATION_FAILED", message: "Request validation failed", details: issues });
  }
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * Creates a product with its barcodes, then its variants. Everything is
 * validated before the first write. Product + barcodes are one transaction;
 * each variant is its own service call, so if a later variant clashes the
 * product already exists and the error result carries `createdId`.
 */
export async function createProductAction(input: unknown): Promise<ActionResult<SavedProduct>> {
  let createdId: string | undefined;
  const result = await run(async ({ ctx, meta }) => {
    const payload = parseAt(CreatePayload, input, "");
    const product = parseAt(CreateProduct, { ...withOptionalNameAr(payload.product), barcodes: payload.barcodes }, "");
    const variants = payload.variants.map((v, i) => parseAt(CreateVariant, variantCreateInput(v), `variants.${i}`));
    assertNoDuplicateCodes(
      product.barcodes,
      variants.map((v) => v.barcodes),
    );

    const created = await step(ctx, "", undefined, () => createProduct(ctx, product, meta));
    createdId = created.id;
    const warnings = new Set<CatalogWarning>(created.warnings);
    for (const [i, variant] of variants.entries()) {
      const saved = await step(ctx, `variants.${i}`, undefined, () => createVariant(ctx, created.id, variant, meta));
      saved.warnings.forEach((w) => warnings.add(w));
    }
    revalidatePath(PRODUCTS_PATH);
    return { product: await getProduct(ctx, created.id), warnings: [...warnings] };
  });
  if (!result.ok && createdId) {
    revalidatePath(PRODUCTS_PATH);
    return { ...result, createdId };
  }
  return result;
}

type PlannedVariant =
  | { index: number; kind: "update"; existing: VariantDetail; patch: UpdateVariant; codes: string[] }
  | { index: number; kind: "create"; input: CreateVariant };

/**
 * Saves the edit form: product fields (one PATCH with `expectedUpdatedAt`),
 * barcode additions/removals, changed variants and new variants. Everything is
 * validated first; removals run before additions so a code can move between items.
 */
export async function updateProductAction(productId: string, input: unknown): Promise<ActionResult<SavedProduct>> {
  return run(async ({ ctx, meta }) => {
    const payload = parseAt(UpdatePayload, input, "");
    const patch = parseAt(UpdateProduct, payload.product, "");
    const desiredCodes = parseAt(BarcodeList, payload.barcodes, "barcodes");
    const current = await step(ctx, "", undefined, () => getProduct(ctx, productId));

    const planned = payload.variants.map((v, index): PlannedVariant => {
      if (!v.id)
        return { index, kind: "create", input: parseAt(CreateVariant, variantCreateInput(v), `variants.${index}`) };
      const existing = current.variants.find((cv) => cv.id === v.id);
      if (!existing) throw new AppError("NOT_FOUND", "Variant not found");
      return {
        index,
        kind: "update",
        existing,
        patch: parseAt(UpdateVariant, variantUpdateInput(v), `variants.${index}`),
        codes: parseAt(BarcodeList, v.barcodes, `variants.${index}.barcodes`),
      };
    });
    assertNoDuplicateCodes(
      desiredCodes,
      planned.map((p) => (p.kind === "update" ? p.codes : p.input.barcodes)),
    );

    const warnings = new Set<CatalogWarning>();
    const saved = await step(ctx, "", undefined, () => updateProduct(ctx, current.id, patch, meta));
    saved.warnings.forEach((w) => warnings.add(w));

    const codesOf = (variantId: string | null) => current.barcodes.filter((b) => b.variantId === variantId);
    const plans = [
      { variantId: null as string | null, current: codesOf(null), desired: desiredCodes, prefix: "barcodes" },
      ...planned.flatMap((p) =>
        p.kind === "update"
          ? [
              {
                variantId: p.existing.id as string | null,
                current: codesOf(p.existing.id),
                desired: p.codes,
                prefix: `variants.${p.index}.barcodes`,
              },
            ]
          : [],
      ),
    ];
    for (const plan of plans) {
      for (const barcode of plan.current.filter((b) => !plan.desired.includes(b.code))) {
        await step(ctx, plan.prefix, plan.prefix, () => removeBarcode(ctx, barcode.id, meta));
      }
    }
    for (const plan of plans) {
      for (const [index, code] of plan.desired.entries()) {
        if (plan.current.some((b) => b.code === code)) continue;
        await step(ctx, plan.prefix, `${plan.prefix}.${index}`, () =>
          addBarcode(ctx, { code, productId: current.id, variantId: plan.variantId }, meta),
        );
      }
    }

    for (const p of planned) {
      const prefix = `variants.${p.index}`;
      if (p.kind === "update") {
        if (!variantChanged(p.patch, p.existing)) continue;
        const updated = await step(ctx, prefix, undefined, () =>
          updateVariant(ctx, current.id, p.existing.id, p.patch, meta),
        );
        updated.warnings.forEach((w) => warnings.add(w));
      } else {
        const created = await step(ctx, prefix, undefined, () => createVariant(ctx, current.id, p.input, meta));
        created.warnings.forEach((w) => warnings.add(w));
      }
    }

    revalidatePath(PRODUCTS_PATH);
    return { product: await getProduct(ctx, current.id), warnings: [...warnings] };
  });
}

function variantChanged(patch: UpdateVariant, existing: VariantDetail): boolean {
  return (
    (patch.sku !== undefined && patch.sku !== existing.sku) ||
    (patch.name !== undefined && patch.name !== existing.name) ||
    (patch.nameAr !== undefined && patch.nameAr !== existing.nameAr) ||
    (patch.priceMinor !== undefined && patch.priceMinor !== existing.priceMinor) ||
    (patch.costMinor !== undefined && patch.costMinor !== existing.costMinor)
  );
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
