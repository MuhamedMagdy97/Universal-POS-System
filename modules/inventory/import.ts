import "server-only";
/**
 * Stock CSV import (docs/planning/stock-import/stock-import-spec.md).
 *
 * The file front half (size, header, limits) is the catalog import's `readCsvTable`. Rows name an
 * item by SKU or barcode. Two modes: opening stock (items with no ledger rows at the branch, like
 * the opening grid) and adjustment (signed change + sub-reason, like the adjust dialog). Confirm is
 * all-or-nothing, goes through `applyLines` (never writes balances itself), and is idempotent on
 * `importId` (its movements carry refType "StockImport", refId importId).
 */
import type { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { BarcodeCode, Sku, csvFileError, readCsvTable } from "@/modules/catalog";
import { assertBuiltIn } from "@/modules/integrations/inventory-sys/source";
import { requireBranch, requirePermission } from "./access";
import { applyLines } from "./ledger";
import { keyOf, lockBalances } from "./locking";
import { getOnHand, type InventoryClient } from "./queries";
import {
  AdjustmentReasonValue,
  StockImportInput,
  StockImportPreviewInput,
  checkAdjustmentDirection,
  normalizeQty,
  normalizeSignedQty,
  type StockImportMode,
} from "./schemas";
import type { ItemRef } from "./types";

export type StockImportColumn = "sku" | "barcode" | "qty" | "reason" | "note";
const COLUMNS: Record<StockImportMode, readonly StockImportColumn[]> = {
  opening: ["sku", "barcode", "qty"],
  adjustment: ["sku", "barcode", "qty", "reason", "note"],
};
const REQUIRED: Record<StockImportMode, readonly StockImportColumn[]> = {
  opening: ["qty"],
  adjustment: ["qty", "reason"],
};
const REF_TYPE = "StockImport";
const MAX_NOTE = 500;

export type StockImportErrorCode =
  | "required"
  | "extraFields"
  | "itemNotFound"
  | "codeMismatch"
  | "variantRequired"
  | "archived"
  | "duplicateInFile"
  | "qtyInvalid"
  | "reasonInvalid"
  | "noteRequired"
  | "tooLong"
  | "direction"
  | "openingTaken"
  | "insufficientStock";

export type StockImportRowError = { column: StockImportColumn | null; code: StockImportErrorCode };
/** `code` is the SKU or barcode as typed; `after` is the branch's stock once the row is applied. */
export type StockImportRow = {
  line: number;
  code: string;
  name: string | null;
  qty: number | null;
  after: number | null;
  errors: StockImportRowError[];
};
export type StockImportPreview = { rows: StockImportRow[]; validCount: number; errorCount: number };

type CheckedRow = StockImportRow & {
  ref: ItemRef | null;
  codeColumn: StockImportColumn;
  variantRequired: boolean;
  reason: AdjustmentReasonValue | null;
  note: string | null;
};

function directionAllows(reason: AdjustmentReasonValue, delta: number): boolean {
  try {
    checkAdjustmentDirection(reason, delta);
    return true;
  } catch {
    return false;
  }
}

async function checkFile(
  client: InventoryClient,
  ctx: TenantContext,
  input: z.infer<typeof StockImportPreviewInput>,
): Promise<CheckedRow[]> {
  const { orgId } = ctx;
  const { branchId, mode } = input;
  const table = readCsvTable(input.csv, COLUMNS[mode], REQUIRED[mode]);
  if (!table.has("sku") && !table.has("barcode")) throw csvFileError("CSV_MISSING_COLUMN", { column: "sku" });

  // Resolve codes like the scanner: SKUs upper-cased (products and variants share one namespace), barcodes exact.
  const skus = new Set<string>();
  const codes = new Set<string>();
  for (const row of table.rows) {
    const sku = Sku.safeParse(row.cell("sku")).data;
    const code = BarcodeCode.safeParse(row.cell("barcode")).data;
    if (sku) skus.add(sku);
    if (code) codes.add(code);
  }
  const [products, variants, barcodes] = await Promise.all([
    client.product.findMany({ where: { orgId, sku: { in: [...skus] } }, select: { id: true, sku: true } }),
    client.productVariant.findMany({
      where: { orgId, sku: { in: [...skus] } },
      select: { id: true, productId: true, sku: true },
    }),
    client.barcode.findMany({
      where: { orgId, code: { in: [...codes] } },
      select: { code: true, productId: true, variantId: true },
    }),
  ]);
  const bySku = new Map<string, ItemRef>([
    ...products.map((p) => [p.sku, { productId: p.id, variantId: null }] as const),
    ...variants.map((v) => [v.sku, { productId: v.productId, variantId: v.id }] as const),
  ]);
  const byBarcode = new Map<string, ItemRef>(
    barcodes.map((b) => [b.code, { productId: b.productId, variantId: b.variantId }]),
  );
  const found = [...bySku.values(), ...byBarcode.values()];
  const [items, itemVariants] = await Promise.all([
    client.product.findMany({
      where: { orgId, id: { in: [...new Set(found.map((r) => r.productId))] } },
      select: { id: true, name: true, hasVariants: true, isActive: true },
    }),
    client.productVariant.findMany({
      where: { orgId, id: { in: found.flatMap((r) => (r.variantId ? [r.variantId] : [])) } },
      select: { id: true, name: true, isActive: true },
    }),
  ]);
  const productById = new Map(items.map((p) => [p.id, p]));
  const variantById = new Map(itemVariants.map((v) => [v.id, v]));
  const key = (ref: ItemRef) => keyOf({ branchId, ...ref });

  const rows: CheckedRow[] = table.rows.map(({ line, cell, extraFields }) => {
    const errors: StockImportRowError[] = [];
    if (extraFields) errors.push({ column: null, code: "extraFields" });

    const sku = cell("sku");
    const barcode = cell("barcode");
    const codeColumn: StockImportColumn = sku ? "sku" : "barcode";
    let ref: ItemRef | null = null;
    if (!sku && !barcode) errors.push({ column: codeColumn, code: "required" });
    else {
      const skuRef = sku ? bySku.get(Sku.safeParse(sku).data ?? "") : undefined;
      const barcodeRef = barcode ? byBarcode.get(BarcodeCode.safeParse(barcode).data ?? "") : undefined;
      if (sku && !skuRef) errors.push({ column: "sku", code: "itemNotFound" });
      else if (barcode && !barcodeRef) errors.push({ column: "barcode", code: "itemNotFound" });
      else if (skuRef && barcodeRef && key(skuRef) !== key(barcodeRef)) {
        errors.push({ column: "barcode", code: "codeMismatch" });
      } else ref = skuRef ?? barcodeRef ?? null;
    }

    let name: string | null = null;
    let archived = false;
    let variantRequired = false;
    if (ref) {
      const product = productById.get(ref.productId);
      const variant = ref.variantId ? variantById.get(ref.variantId) : undefined;
      name = product ? (variant ? `${product.name} — ${variant.name}` : product.name) : null;
      archived = !product?.isActive || (variant !== undefined && !variant.isActive);
      variantRequired = product?.hasVariants === true && ref.variantId === null;
      if (variantRequired) errors.push({ column: codeColumn, code: "variantRequired" });
    }

    const rawQty = cell("qty");
    const qty = rawQty ? (mode === "opening" ? normalizeQty(rawQty) : normalizeSignedQty(rawQty)) : null;
    if (!rawQty) errors.push({ column: "qty", code: "required" });
    else if (qty === null) errors.push({ column: "qty", code: "qtyInvalid" });

    let reason: AdjustmentReasonValue | null = null;
    const note = cell("note") || null;
    if (mode === "adjustment") {
      const rawReason = cell("reason");
      // "Lost or stolen", "lost-or-stolen" and LOST_OR_STOLEN all name the same reason.
      reason = AdjustmentReasonValue.safeParse(rawReason.toUpperCase().replace(/[\s-]+/g, "_")).data ?? null;
      if (!rawReason) errors.push({ column: "reason", code: "required" });
      else if (!reason) errors.push({ column: "reason", code: "reasonInvalid" });
      if (reason === "OTHER" && !note) errors.push({ column: "note", code: "noteRequired" });
      if (note && note.length > MAX_NOTE) errors.push({ column: "note", code: "tooLong" });
      if (reason && qty !== null && !directionAllows(reason, qty)) errors.push({ column: "qty", code: "direction" });
    }
    // Archived items take no new stock; an adjustment may still write theirs off (ledger rule).
    if (ref && archived && (mode === "opening" || (qty ?? 0) > 0))
      errors.push({ column: codeColumn, code: "archived" });

    return {
      line,
      code: sku || barcode,
      name,
      qty,
      after: null,
      errors,
      ref,
      codeColumn,
      variantRequired,
      reason,
      note,
    };
  });

  // The same item twice (by any code): the first row wins, later ones are errors.
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.ref) continue;
    if (seen.has(key(row.ref))) row.errors.push({ column: row.codeColumn, code: "duplicateInFile" });
    seen.add(key(row.ref));
  }

  // Branch state: opening needs no ledger rows yet; an adjustment may not take stock below zero.
  const withRef = rows.filter((row): row is CheckedRow & { ref: ItemRef } => row.ref !== null);
  if (mode === "opening") {
    const existing = await client.inventoryMovement.findMany({
      where: { orgId, branchId, productId: { in: [...new Set(withRef.map((row) => row.ref.productId))] } },
      select: { productId: true, variantId: true },
      distinct: ["productId", "variantId"],
    });
    const taken = new Set(existing.map((m) => key(m)));
    for (const row of withRef) {
      if (taken.has(key(row.ref))) row.errors.push({ column: row.codeColumn, code: "openingTaken" });
      else row.after = row.qty;
    }
  } else {
    const onHand = await getOnHand(
      client,
      orgId,
      branchId,
      withRef.map((row) => row.ref),
    );
    withRef.forEach((row, i) => {
      if (row.qty === null) return;
      row.after = (onHand[i] ?? 0) + row.qty;
      if (row.after < 0) row.errors.push({ column: "qty", code: "insufficientStock" });
    });
  }
  return rows;
}

function summarize(rows: CheckedRow[]): StockImportPreview {
  const errorCount = rows.filter((r) => r.errors.length > 0).length;
  return {
    rows: rows.map(({ line, code, name, qty, after, errors }) => ({ line, code, name, qty, after, errors })),
    validCount: rows.length - errorCount,
    errorCount,
  };
}

/** Checks the file against the branch without writing anything: one result per data row. */
export async function previewStockImport(
  ctx: TenantContext,
  input: z.input<typeof StockImportPreviewInput>,
): Promise<StockImportPreview> {
  await requirePermission(ctx, "inventory.adjust");
  await assertBuiltIn(ctx.orgId);
  const parsed = StockImportPreviewInput.parse(input);
  await requireBranch(ctx, parsed.branchId);
  return summarize(await checkFile(getDb(), ctx, parsed));
}

/**
 * Re-checks the file under the balance locks and applies every row in one transaction. Refused
 * (422 `CSV_HAS_ERRORS`) when any row has an error. A repeated `importId` returns the first
 * result (`replayed: true`) and writes nothing.
 */
export async function importStock(
  ctx: TenantContext,
  input: z.input<typeof StockImportInput>,
  meta?: AuditRequestMeta,
): Promise<{ applied: number; replayed: boolean }> {
  await requirePermission(ctx, "inventory.adjust", { operation: "import", entityType: "InventoryMovement", meta });
  const parsed = StockImportInput.parse(input);
  await requireBranch(ctx, parsed.branchId);
  const { branchId, mode, importId } = parsed;

  return getDb().$transaction(
    async (tx) => {
      await assertBuiltIn(ctx.orgId, tx);
      // Lock first, then look (as opening stock does): a concurrent confirm of the same file waits
      // here, then sees the rows the first one wrote.
      const first = await checkFile(tx, ctx, parsed);
      await lockBalances(
        tx,
        ctx.orgId,
        first.flatMap((row) => (row.ref && !row.variantRequired ? [{ branchId, ...row.ref }] : [])),
      );
      const done = await tx.inventoryMovement.count({
        where: { orgId: ctx.orgId, refType: REF_TYPE, refId: importId },
      });
      if (done > 0) return { applied: done, replayed: true };

      const rows = await checkFile(tx, ctx, parsed);
      const { errorCount } = summarize(rows);
      if (errorCount > 0) throw csvFileError("CSV_HAS_ERRORS", { errorCount });
      const lines = rows.map((row) => ({ ref: row.ref as ItemRef, qtyDelta: row.qty as number }));

      if (mode === "opening") {
        await applyLines(tx, ctx, {
          branchId,
          reason: "OPENING_BALANCE",
          refType: REF_TYPE,
          refId: importId,
          policy: "block",
          lines,
        });
      } else {
        // One ledger call per (reason, note): those are per call, not per line.
        const groups = new Map<string, { reason: AdjustmentReasonValue; note: string | null; lines: typeof lines }>();
        rows.forEach((row, i) => {
          const reason = row.reason as AdjustmentReasonValue;
          const groupKey = `${reason}\n${row.note ?? ""}`;
          const group = groups.get(groupKey) ?? { reason, note: row.note, lines: [] };
          group.lines.push(lines[i]);
          groups.set(groupKey, group);
        });
        for (const group of groups.values()) {
          await applyLines(tx, ctx, {
            branchId,
            reason: "ADJUSTMENT",
            adjustmentReason: group.reason,
            note: group.note,
            refType: REF_TYPE,
            refId: importId,
            policy: "block",
            lines: group.lines,
          });
        }
      }

      await record(tx, {
        ctx,
        meta,
        action: "inventory.stock.imported",
        entityType: "InventoryMovement",
        metadata: {
          branchId,
          mode,
          importId,
          lines: rows.map((row, i) => ({
            ref: lines[i].ref,
            qtyDelta: lines[i].qtyDelta,
            ...(row.reason ? { adjustmentReason: row.reason } : {}),
          })),
        },
      });
      return { applied: rows.length, replayed: false };
    },
    // ponytail: one long transaction, the file checked twice; up to 1000 rows × a few statements each.
    { timeout: 120_000 },
  );
}
