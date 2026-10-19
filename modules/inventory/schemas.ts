import { z } from "zod";
import { AppError } from "@/lib/errors";
import { normalizeDigits } from "@/lib/money";

/**
 * Inventory input schemas and pure rules (T4.2). No DB access.
 * See docs/planning/phase-7/inventory-api-and-rules.md (§2–§3) and inventory-data-model.md (§2–§3).
 *
 * Every input object is strict, so `orgId`, balances and actor fields can never come from the client.
 */

export const Uuid = z.uuid();

/** Quantities are whole numbers of EACH units, 1 … 1,000,000 per line (KG is deferred). */
export const MAX_QTY = 1_000_000;
export const Qty = z.number().int().min(1).max(MAX_QTY);
export type Qty = z.infer<typeof Qty>;

export const ADJUSTMENT_REASON_VALUES = [
  "DAMAGED",
  "EXPIRED",
  "LOST_OR_STOLEN",
  "COUNT_CORRECTION",
  "FOUND",
  "OTHER",
] as const;
export const AdjustmentReasonValue = z.enum(ADJUSTMENT_REASON_VALUES);
export type AdjustmentReasonValue = z.infer<typeof AdjustmentReasonValue>;

/** Item reference, same shape as catalog's CatalogItemRef. `variantId` absent ⇒ null. */
export const ItemRefInput = z
  .object({
    productId: Uuid,
    variantId: Uuid.nullish().transform((value) => value ?? null),
  })
  .strict();
export type ItemRefInput = z.infer<typeof ItemRefInput>;

const Note = z.string().max(500);

export const OpeningInput = z
  .object({
    branchId: Uuid,
    lines: z
      .array(z.object({ ref: ItemRefInput, qty: Qty }).strict())
      .min(1)
      .max(500),
  })
  .strict();
export type OpeningInput = z.infer<typeof OpeningInput>;

/**
 * Exactly one of `qtyDelta` (a change) or `countedQty` (a count, COUNT_CORRECTION only).
 * OTHER needs a non-blank note (D2). The direction rule is in `checkAdjustmentDirection`.
 */
export const AdjustInput = z
  .object({
    branchId: Uuid,
    ref: ItemRefInput,
    adjustmentReason: AdjustmentReasonValue,
    note: Note.optional(),
    qtyDelta: z
      .number()
      .int()
      .refine((value) => value !== 0 && Math.abs(value) <= MAX_QTY, "qtyDelta must be a non-zero change")
      .optional(),
    countedQty: z.number().int().min(0).max(MAX_QTY).optional(),
    expectedOnHand: z.number().int(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const hasDelta = input.qtyDelta !== undefined;
    const hasCount = input.countedQty !== undefined;
    if (hasDelta === hasCount) {
      ctx.addIssue({ code: "custom", message: "Provide exactly one of qtyDelta or countedQty", path: ["qtyDelta"] });
    }
    if (hasCount && input.adjustmentReason !== "COUNT_CORRECTION") {
      ctx.addIssue({ code: "custom", message: "countedQty is only valid for COUNT_CORRECTION", path: ["countedQty"] });
    }
    if (input.adjustmentReason === "OTHER" && !(input.note ?? "").trim()) {
      ctx.addIssue({ code: "custom", message: "A note is required for OTHER", path: ["note"] });
    }
  });
export type AdjustInput = z.infer<typeof AdjustInput>;

export const TransferInput = z
  .object({
    transferId: Uuid,
    fromBranchId: Uuid,
    toBranchId: Uuid,
    lines: z
      .array(z.object({ ref: ItemRefInput, qty: Qty }).strict())
      .min(1)
      .max(200),
    note: Note.optional(),
  })
  .strict();
export type TransferInput = z.infer<typeof TransferInput>;

/** `unopened`: no ledger rows at the branch yet (the opening-stock grid's list). */
export const STOCK_FILTER_VALUES = ["all", "inStock", "zero", "negative", "unopened"] as const;
export const StockFilter = z.enum(STOCK_FILTER_VALUES);

export const StockQuery = z
  .object({
    branchId: Uuid,
    q: z.string().max(100).optional(),
    filter: StockFilter.default("all"),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type StockQuery = z.input<typeof StockQuery>;

/**
 * Sign rules per sub-reason (D2): DAMAGED / EXPIRED / LOST_OR_STOLEN only decrease,
 * FOUND only increases, COUNT_CORRECTION and OTHER go either way. Mirrors the DB CHECK.
 */
export function checkAdjustmentDirection(reason: AdjustmentReasonValue, qtyDelta: number): void {
  const ok =
    ((reason === "DAMAGED" || reason === "EXPIRED" || reason === "LOST_OR_STOLEN") && qtyDelta < 0) ||
    (reason === "FOUND" && qtyDelta > 0) ||
    reason === "COUNT_CORRECTION" ||
    reason === "OTHER";
  if (!ok) {
    throw new AppError("VALIDATION_FAILED", "This adjustment reason does not allow that direction", {
      reason: "ADJUSTMENT_DIRECTION",
    });
  }
}

/** One line per item in a single call (a scanned item twice is one line). */
export function assertNoDuplicateRefs(refs: readonly { productId: string; variantId: string | null }[]): void {
  const seen = new Set<string>();
  for (const { productId, variantId } of refs) {
    const key = `${productId}:${variantId ?? ""}`;
    if (seen.has(key)) {
      throw new AppError("VALIDATION_FAILED", "The same item appears twice", { reason: "DUPLICATE_LINE" });
    }
    seen.add(key);
  }
}

/**
 * Reads a quantity typed in a UI box. Arabic-Indic digits are accepted (inventory I-20).
 * Returns null when the box is empty, not a whole number, or outside 1 … MAX_QTY.
 */
export function normalizeQty(input: string): number | null {
  const digits = normalizeDigits(input).trim();
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Qty.safeParse(value).success ? value : null;
}

export const LedgerQuery = z
  .object({
    branchId: Uuid,
    productId: Uuid,
    variantId: Uuid.nullish().transform((value) => value ?? null),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type LedgerQuery = z.input<typeof LedgerQuery>;

/** Reorder point (min qty) for one item at one branch; `null` stops tracking it (low-stock-spec L1–L6). */
export const ReorderPointInput = z
  .object({
    branchId: Uuid,
    ref: ItemRefInput,
    reorderPoint: z.number().int().min(0).max(MAX_QTY).nullable(),
  })
  .strict();
export type ReorderPointInput = z.infer<typeof ReorderPointInput>;

export const LowStockQuery = z.object({ branchId: Uuid }).strict();
export type LowStockQuery = z.input<typeof LowStockQuery>;

/** An item is low when it has a reorder point and on-hand is at or below it (L3). Mirrors the SQL. */
export function isLowStock(qty: number, reorderPoint: number | null): boolean {
  return reorderPoint !== null && qty <= reorderPoint;
}
