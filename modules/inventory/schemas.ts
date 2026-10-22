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

/** Stock CSV import (docs/planning/stock-import/stock-import-spec.md). `csv` is the file text. */
export const STOCK_IMPORT_MODES = ["opening", "adjustment"] as const;
export type StockImportMode = (typeof STOCK_IMPORT_MODES)[number];
export const StockImportPreviewInput = z
  .object({ branchId: Uuid, mode: z.enum(STOCK_IMPORT_MODES), csv: z.string() })
  .strict();
/** `importId` is chosen by the client per file: a repeated confirm returns the first result. */
export const StockImportInput = StockImportPreviewInput.extend({ importId: Uuid }).strict();

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

/** A signed change (`-3`, `+5`, `5`): non-zero, at most MAX_QTY either way; Arabic-Indic digits accepted. */
export function normalizeSignedQty(input: string): number | null {
  const match = /^([+-]?)(\d+)$/.exec(normalizeDigits(input).trim());
  if (!match) return null;
  const value = Number(match[2]);
  if (value === 0 || value > MAX_QTY) return null;
  return match[1] === "-" ? -value : value;
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

// ── Stock counts (docs/planning/stock-counts/stock-counts-spec.md) ──

export const COUNT_SCOPE_VALUES = ["FULL", "CATEGORY", "ITEMS"] as const;

/** A category count names its category; the other scopes must not (C2). */
export const CountCreateInput = z
  .object({
    branchId: Uuid,
    scope: z.enum(COUNT_SCOPE_VALUES),
    categoryId: Uuid.optional(),
    note: Note.optional(),
  })
  .strict()
  .refine((input) => (input.scope === "CATEGORY") === (input.categoryId !== undefined), {
    message: "categoryId is required for a category count, and only for one",
    path: ["categoryId"],
  });
export type CountCreateInput = z.infer<typeof CountCreateInput>;

export const CountListQuery = z.object({ branchId: Uuid }).strict();
export type CountListQuery = z.input<typeof CountListQuery>;

/** Items chosen for an ITEMS-scope draft. */
export const CountItemsInput = z.object({ refs: z.array(ItemRefInput).min(1).max(500) }).strict();
export type CountItemsInput = z.infer<typeof CountItemsInput>;

export const CountItemInput = z.object({ ref: ItemRefInput }).strict();
export type CountItemInput = z.infer<typeof CountItemInput>;

/** A scan adds (`add`), a typed quantity replaces (`set`), `set: null` clears the count (C4). */
export const CountEntryInput = z
  .object({
    ref: ItemRefInput,
    add: Qty.optional(),
    set: z.number().int().min(0).max(MAX_QTY).nullable().optional(),
  })
  .strict()
  .refine((input) => (input.add === undefined) !== (input.set === undefined), {
    message: "Provide exactly one of add or set",
    path: ["add"],
  });
export type CountEntryInput = z.infer<typeof CountEntryInput>;

/**
 * Difference a counted line posts (C5, C6): the variance when it was counted, applied to live
 * on-hand at posting. Null for an uncounted line.
 */
export function countDelta(countedQty: number | null, expectedQty: number | null): number | null {
  return countedQty === null || expectedQty === null ? null : countedQty - expectedQty;
}

// ── Two-step transfers (docs/planning/transfers/transit-transfers-spec.md) ──

/** Why part of a transfer did not arrive (T5); written off at the destination with this sub-reason. */
export const SHORTFALL_REASON_VALUES = ["DAMAGED", "LOST_OR_STOLEN", "OTHER"] as const;
export type ShortfallReason = (typeof SHORTFALL_REASON_VALUES)[number];
export const TRANSFER_STATUS_VALUES = ["SENT", "RECEIVED", "CANCELLED"] as const;

export const TransferListQuery = z
  .object({
    branchId: Uuid,
    direction: z.enum(["outgoing", "incoming"]),
    status: z.enum(TRANSFER_STATUS_VALUES).optional(),
  })
  .strict();
export type TransferListQuery = z.input<typeof TransferListQuery>;

/** Every line once, received 0 … sent (T4, T6); OTHER needs a note (ledger CHECK). */
export const TransferReceiveInput = z
  .object({
    receiveKey: Uuid,
    lines: z
      .array(
        z
          .object({
            ref: ItemRefInput,
            qtyReceived: z.number().int().min(0).max(MAX_QTY),
            shortfallReason: z.enum(SHORTFALL_REASON_VALUES).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    note: Note.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.lines.some((line) => line.shortfallReason === "OTHER") && !(input.note ?? "").trim()) {
      ctx.addIssue({ code: "custom", message: "A note is required for OTHER", path: ["note"] });
    }
  });
export type TransferReceiveInput = z.infer<typeof TransferReceiveInput>;

type SentLine = { productId: string; variantId: string | null; qtySent: number };
type ReceivedLine = {
  ref: { productId: string; variantId: string | null };
  qtyReceived: number;
  shortfallReason?: ShortfallReason;
};
export type ReceiptPlan = SentLine & {
  qtyReceived: number;
  shortfall: number;
  shortfallReason: ShortfallReason | null;
};

/**
 * Matches a receipt to the sent lines (T4–T6): every sent line exactly once, received ≤ sent, and a
 * shortfall reason exactly on the short lines. Pure, so it is unit-tested without a DB.
 */
export function planReceipt(sent: readonly SentLine[], received: readonly ReceivedLine[]): ReceiptPlan[] {
  const key = (ref: { productId: string; variantId: string | null }) => `${ref.productId}|${ref.variantId ?? ""}`;
  assertNoDuplicateRefs(received.map((line) => line.ref));
  const byKey = new Map(received.map((line) => [key(line.ref), line]));
  return sent.map((line) => {
    const got = byKey.get(key(line));
    if (!got || received.length !== sent.length) {
      throw new AppError("VALIDATION_FAILED", "Enter a received quantity for every line of the transfer", {
        reason: "LINES_MISMATCH",
      });
    }
    if (got.qtyReceived > line.qtySent) {
      throw new AppError("VALIDATION_FAILED", "More was received than was sent", { reason: "QTY_OVER_SENT" });
    }
    const shortfall = line.qtySent - got.qtyReceived;
    if (shortfall > 0 !== (got.shortfallReason !== undefined)) {
      throw new AppError("VALIDATION_FAILED", "Choose a reason for each short line, and only for those", {
        reason: "SHORTFALL_REASON",
      });
    }
    return { ...line, qtyReceived: got.qtyReceived, shortfall, shortfallReason: got.shortfallReason ?? null };
  });
}

/** Short reference shown on screens and the transfer note (T14). */
export function transferReference(id: string): string {
  return `TR-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
