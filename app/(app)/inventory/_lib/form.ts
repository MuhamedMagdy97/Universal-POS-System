/**
 * Pure helpers for the inventory screens (client-safe). Unit-tested in
 * tests/unit/inventory-form-helpers.test.ts. No DB, no server imports.
 */
import type { ErrorBody } from "@/lib/errors";
import { MESSAGES, interpolate, type Locale, type MessageKey } from "@/lib/i18n";
import { normalizeDigits } from "@/lib/money";
import { MAX_QTY, normalizeQty, type AdjustmentReasonValue } from "@/modules/inventory/schemas";

export type ItemRef = { productId: string; variantId: string | null };
export type Line = { ref: ItemRef; qty: number };

export type Direction = "down" | "up" | "either";

/** Which way a sub-reason may move stock (D2). Mirrors `checkAdjustmentDirection`. */
export function directionOf(reason: AdjustmentReasonValue): Direction {
  if (reason === "DAMAGED" || reason === "EXPIRED" || reason === "LOST_OR_STOLEN") return "down";
  if (reason === "FOUND") return "up";
  return "either";
}

/** Signed change for a typed quantity. The sign box only matters when the reason allows both directions. */
export function signedDelta(input: { reason: AdjustmentReasonValue; qty: number; sign: "+" | "-" }): number {
  const direction = directionOf(input.reason);
  if (direction === "down") return -input.qty;
  if (direction === "up") return input.qty;
  return input.sign === "-" ? -input.qty : input.qty;
}

/** Reads a counted quantity: a whole number from 0, Arabic-Indic digits accepted; null otherwise. */
export function normalizeCount(input: string): number | null {
  const digits = normalizeDigits(input).trim();
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value <= MAX_QTY ? value : null;
}

export function previewAfter(onHand: number, delta: number): number {
  return onHand + delta;
}

export function needsNote(reason: AdjustmentReasonValue): boolean {
  return reason === "OTHER";
}

/** Transfer lines that ask for more than the source branch holds (client preview; the server decides). */
export function overSourceLines(
  lines: readonly Line[],
  onHandOf: (ref: ItemRef) => number,
): (Line & { onHand: number })[] {
  return lines.map((line) => ({ ...line, onHand: onHandOf(line.ref) })).filter((line) => line.qty > line.onHand);
}

/** Opening-grid rows: blank is skipped, anything that is not a whole quantity from 1 is reported. */
export function openingRowsToSave(rows: readonly { ref: ItemRef; raw: string }[]): {
  lines: Line[];
  invalid: ItemRef[];
} {
  const lines: Line[] = [];
  const invalid: ItemRef[] = [];
  for (const row of rows) {
    if (row.raw.trim() === "") continue;
    const qty = normalizeQty(row.raw);
    if (qty === null) invalid.push(row.ref);
    else lines.push({ ref: row.ref, qty });
  }
  return { lines, invalid };
}

/** Translation key for a service error, by `details.reason`; anything unknown is the generic message. */
export function errorMessageKey(error: ErrorBody): MessageKey {
  const details = error.details as { reason?: string; path?: string } | null;
  if (error.code === "VALIDATION_FAILED" && Array.isArray(error.details)) {
    const paths = (error.details as { path?: string }[]).map((issue) => issue.path ?? "");
    if (paths.some((path) => path === "note")) return "inventory.error.noteRequired";
  }
  switch (details?.reason) {
    case "INSUFFICIENT_STOCK":
      return "inventory.error.insufficient";
    case "ADJUSTMENT_DIRECTION":
      return "inventory.error.direction";
    case "NO_CHANGE":
      return "inventory.error.noChange";
    case "SAME_BRANCH":
      return "inventory.error.sameBranch";
    case "IDEMPOTENCY_CONFLICT":
      return "inventory.error.idempotency";
    case "ITEM_NOT_SELLABLE":
      return "inventory.error.itemNotSellable";
    case "OPENING_BALANCE_EXISTS":
      return "inventory.error.openingTaken";
    default:
      return "inventory.error.generic";
  }
}

/**
 * Message for a key that is only known at runtime (a union, or a key without placeholders).
 * `translator()` type-checks placeholders per key, so it cannot take such a union.
 */
export function plain(locale: Locale, key: MessageKey): string {
  return interpolate(MESSAGES[locale][key]);
}
