import "server-only";
/**
 * Product CSV import (docs/planning/catalog-import/catalog-import-spec.md).
 *
 * Every row goes through `CreateProduct` (the create-product rules) and is
 * inserted with `insertProduct`, so the import adds no validation rules of its
 * own beyond CSV shape, category-by-name, and duplicates within the file / org.
 * Confirm is all-or-nothing: one transaction, and any row error refuses the file.
 */
import type { TenantContext } from "@/lib/auth/tenant";
import { assertBuiltIn } from "@/modules/integrations/inventory-sys/source";
import { csvFileError as fileError, readCsvTable } from "./csv";
import { record } from "@/modules/audit";
import { db, requirePermission, withUniqueMapping, type CatalogMeta } from "./internal";
import { insertProduct } from "./products";
import { BarcodeCode, CreateProduct, majorPrice, Sku, type CreateProduct as CreateProductData } from "./schemas";
import type { z } from "zod";

export { MAX_IMPORT_ROWS, MAX_IMPORT_CHARS } from "./csv";
export const IMPORT_COLUMNS = ["name", "nameAr", "sku", "barcode", "price", "category", "vatCategory", "unit"] as const;
export const REQUIRED_IMPORT_COLUMNS = ["name", "sku", "price"] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export type ImportErrorCode =
  | "required"
  | "invalid"
  | "tooLong"
  | "skuInvalid"
  | "barcodeInvalid"
  | "invalidAmount"
  | "categoryNotFound"
  | "categoryAmbiguous"
  | "duplicateInFile"
  | "skuTaken"
  | "barcodeTaken"
  | "extraFields";

export type ImportRowError = { column: ImportColumn | null; code: ImportErrorCode };
/** `line` is the record's 1-based number in the file (header = 1), as a spreadsheet shows it. */
export type ImportPreviewRow = { line: number; name: string; sku: string; errors: ImportRowError[] };
export type ImportPreview = { rows: ImportPreviewRow[]; validCount: number; errorCount: number };

type CheckedRow = ImportPreviewRow & { data: CreateProductData | null; skuKey?: string; codeKey?: string };

const FIELD_COLUMN: Record<string, ImportColumn> = {
  name: "name",
  nameAr: "nameAr",
  sku: "sku",
  barcodes: "barcode",
  priceMinor: "price",
  categoryId: "category",
  vatCategory: "vatCategory",
  unitType: "unit",
};

function issueError(issue: z.core.$ZodIssue): ImportRowError {
  const column = FIELD_COLUMN[String(issue.path[0])] ?? null;
  if (column === "price") return { column, code: "invalidAmount" };
  switch (issue.code) {
    case "too_small":
      return { column, code: "required" };
    case "too_big":
      return { column, code: "tooLong" };
    case "invalid_format":
      if (column === "sku") return { column, code: "skuInvalid" };
      if (column === "barcode") return { column, code: "barcodeInvalid" };
      return { column, code: "invalid" };
    default:
      return { column, code: "invalid" };
  }
}

async function checkFile(ctx: TenantContext, csv: string): Promise<CheckedRow[]> {
  const table = readCsvTable(csv, IMPORT_COLUMNS, REQUIRED_IMPORT_COLUMNS);

  const org = await db().organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { currency: true } });
  const price = majorPrice(org.currency);
  const categories = await db().category.findMany({
    where: { orgId: ctx.orgId, isActive: true },
    select: { id: true, name: true, nameAr: true },
  });

  const rows: CheckedRow[] = table.rows.map(({ line, cell, extraFields }) => {
    const errors: ImportRowError[] = [];
    if (extraFields) errors.push({ column: null, code: "extraFields" });

    const input: Record<string, unknown> = { sku: cell("sku"), name: cell("name"), priceMinor: 0 };
    if (cell("nameAr")) input.nameAr = cell("nameAr");
    if (cell("barcode")) input.barcodes = [cell("barcode")];
    if (cell("vatCategory")) input.vatCategory = cell("vatCategory").toUpperCase();
    // "each" or "kg" (weighed-selling-spec W4); a KG price is per kg.
    if (cell("unit")) input.unitType = cell("unit").toUpperCase();

    if (!cell("price")) errors.push({ column: "price", code: "required" });
    else {
      const parsed = price.safeParse(cell("price"));
      if (parsed.success) input.priceMinor = parsed.data;
      else errors.push({ column: "price", code: "invalidAmount" });
    }

    const categoryName = cell("category").toLowerCase();
    if (categoryName) {
      const hits = categories.filter((c) => c.name.toLowerCase() === categoryName || c.nameAr === cell("category"));
      if (hits.length === 1) input.categoryId = hits[0]?.id;
      else errors.push({ column: "category", code: hits.length === 0 ? "categoryNotFound" : "categoryAmbiguous" });
    }

    const parsed = CreateProduct.safeParse(input);
    if (!parsed.success) errors.push(...parsed.error.issues.map(issueError));
    // Normalised keys for the duplicate checks, even when another field of the row is wrong.
    const skuKey = Sku.safeParse(cell("sku")).data;
    const codeKey = cell("barcode") ? BarcodeCode.safeParse(cell("barcode")).data : undefined;
    return {
      line,
      name: cell("name"),
      sku: skuKey ?? cell("sku"),
      errors,
      data: parsed.success ? parsed.data : null,
      skuKey,
      codeKey,
    };
  });

  // Duplicates within the file: the first occurrence wins, later ones are errors.
  const seenSku = new Set<string>();
  const seenCode = new Set<string>();
  for (const row of rows) {
    if (row.skuKey && seenSku.has(row.skuKey)) row.errors.push({ column: "sku", code: "duplicateInFile" });
    if (row.codeKey && seenCode.has(row.codeKey)) row.errors.push({ column: "barcode", code: "duplicateInFile" });
    if (row.skuKey) seenSku.add(row.skuKey);
    if (row.codeKey) seenCode.add(row.codeKey);
  }

  // Already in the catalog (SKUs share one namespace with variants).
  const skus = [...seenSku];
  const codes = [...seenCode];
  const [products, variants, barcodes] = await Promise.all([
    db().product.findMany({ where: { orgId: ctx.orgId, sku: { in: skus } }, select: { sku: true } }),
    db().productVariant.findMany({ where: { orgId: ctx.orgId, sku: { in: skus } }, select: { sku: true } }),
    db().barcode.findMany({ where: { orgId: ctx.orgId, code: { in: codes } }, select: { code: true } }),
  ]);
  const takenSku = new Set([...products, ...variants].map((p) => p.sku));
  const takenCode = new Set(barcodes.map((b) => b.code));
  for (const row of rows) {
    if (row.skuKey && takenSku.has(row.skuKey)) row.errors.push({ column: "sku", code: "skuTaken" });
    if (row.codeKey && takenCode.has(row.codeKey)) row.errors.push({ column: "barcode", code: "barcodeTaken" });
  }
  return rows;
}

function summarize(rows: CheckedRow[]): ImportPreview {
  const errorCount = rows.filter((r) => r.errors.length > 0).length;
  return {
    rows: rows.map(({ line, name, sku, errors }) => ({ line, name, sku, errors })),
    validCount: rows.length - errorCount,
    errorCount,
  };
}

/** Validates the file without writing anything: one result per data row, with its errors. */
export async function previewProductImport(ctx: TenantContext, csv: string): Promise<ImportPreview> {
  await requirePermission(ctx, "products.create");
  await assertBuiltIn(ctx.orgId);
  return summarize(await checkFile(ctx, csv));
}

/**
 * Re-validates and creates every row in one transaction. Refused (422
 * `CSV_HAS_ERRORS`) when any row has an error, so nothing is half-imported.
 */
export async function importProducts(
  ctx: TenantContext,
  csv: string,
  meta?: CatalogMeta,
): Promise<{ created: number }> {
  await requirePermission(ctx, "products.create", { entityType: "Product", operation: "import", meta });
  await assertBuiltIn(ctx.orgId);
  const rows = await checkFile(ctx, csv);
  const preview = summarize(rows);
  if (preview.errorCount > 0) throw fileError("CSV_HAS_ERRORS", { errorCount: preview.errorCount });

  await withUniqueMapping(ctx, {}, () =>
    db().$transaction(
      async (tx) => {
        await assertBuiltIn(ctx.orgId, tx);
        for (const row of rows) {
          if (!row.data) continue;
          const { barcodes, ...data } = row.data;
          await insertProduct(tx, ctx, meta, data, barcodes);
        }
        // One summary row per file; each product also gets its own `catalog.product.created`.
        await record(tx, {
          ctx,
          meta,
          action: "catalog.product.imported",
          entityType: "Product",
          metadata: { created: rows.length },
        });
      },
      // ponytail: one long transaction; up to MAX_IMPORT_ROWS × ~4 statements. Batch createMany if this gets slow.
      { timeout: 120_000 },
    ),
  );
  return { created: rows.length };
}
