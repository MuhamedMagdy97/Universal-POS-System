/**
 * Pure helpers for the purchasing screens (client-safe). Unit-tested in
 * tests/unit/purchasing-screen-helpers.test.ts. No DB, no server imports.
 */
import type { ErrorBody } from "@/lib/errors";
import { MESSAGES, interpolate, type Locale, type MessageKey } from "@/lib/i18n";
import { MoneyError, normalizeDigits, parseMajor, toMajorString, type CurrencyCode } from "@/lib/money";
import { MAX_QTY } from "@/modules/inventory/schemas";
import type { PoStatus } from "@/modules/purchasing/schemas";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

/** Runs a Server Action and never rejects, so a dropped connection re-enables the form. */
export async function safeAction<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch {
    return { ok: false, error: { code: "INTERNAL", message: "Request failed", details: null } };
  }
}

const REASON_KEYS = {
  PO_NOT_EDITABLE: "purchasing.error.PO_NOT_EDITABLE",
  PO_NOT_RECEIVABLE: "purchasing.error.PO_NOT_RECEIVABLE",
  PO_BAD_TRANSITION: "purchasing.error.PO_BAD_TRANSITION",
  QTY_EXCEEDS_OUTSTANDING: "purchasing.error.QTY_EXCEEDS_OUTSTANDING",
  SUPPLIER_INACTIVE: "purchasing.error.SUPPLIER_INACTIVE",
  SUPPLIER_NAME_TAKEN: "purchasing.error.SUPPLIER_NAME_TAKEN",
  NOTHING_TO_RECEIVE: "purchasing.error.NOTHING_TO_RECEIVE",
  ITEM_NOT_SELLABLE: "purchasing.error.ITEM_NOT_SELLABLE",
  AMOUNT_TOO_LARGE: "purchasing.error.AMOUNT_TOO_LARGE",
} as const satisfies Record<string, MessageKey>;

/** The message for an error envelope: the specific reason first, then the status class. */
export function errorKey(error: ErrorBody): MessageKey {
  const reason = (error.details as { reason?: unknown } | null)?.reason;
  if (typeof reason === "string" && Object.hasOwn(REASON_KEYS, reason)) {
    return REASON_KEYS[reason as keyof typeof REASON_KEYS];
  }
  switch (error.code) {
    case "IDEMPOTENCY_CONFLICT":
      return "purchasing.error.IDEMPOTENCY_CONFLICT";
    case "FORBIDDEN":
      return "purchasing.error.forbidden";
    case "NOT_FOUND":
      return "purchasing.error.notFound";
    case "VALIDATION_FAILED":
      return "purchasing.error.invalid";
    default:
      return "purchasing.error.generic";
  }
}

/** A message with no placeholders, by a key only known at runtime. */
export function plain(locale: Locale, key: MessageKey): string {
  return interpolate(MESSAGES[locale][key]);
}

export function statusKey(status: PoStatus): `purchasing.status.${PoStatus}` {
  return `purchasing.status.${status}`;
}

/** Tailwind classes for a status badge. */
export function statusTone(status: PoStatus): string {
  switch (status) {
    case "DRAFT":
      return "border-border text-muted";
    case "ORDERED":
      return "border-blue-600 text-blue-700";
    case "PARTIALLY_RECEIVED":
      return "border-amber-600 text-amber-700";
    case "RECEIVED":
      return "border-green-700 text-green-700";
    default:
      return "border-border text-muted line-through";
  }
}

/** A typed cost ("12.5", Arabic digits allowed) → minor units, or null when it is not a valid amount ≥ 0. */
export function parseCost(input: string, currency: CurrencyCode): number | null {
  if (input.trim() === "") return null;
  try {
    const minor = parseMajor(input, currency);
    return minor >= 0 && minor <= 2_147_483_647 ? minor : null;
  } catch (err) {
    if (err instanceof MoneyError) return null;
    throw err;
  }
}

export function costText(minor: number, currency: CurrencyCode): string {
  return toMajorString(minor, currency);
}

/** A typed quantity → a whole number 0 … MAX_QTY, or null. */
export function parseQty(input: string): number | null {
  const digits = normalizeDigits(input).trim();
  if (!/^\d+$/.test(digits)) return null;
  const qty = Number(digits);
  return qty <= MAX_QTY ? qty : null;
}

export type EditorLine = {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  qty: string;
  cost: string;
};

/** Editor lines → the PO lines to send, or null if any line has a bad quantity (< 1) or cost. */
export function linesToSubmit(
  lines: readonly EditorLine[],
  currency: CurrencyCode,
): { ref: { productId: string; variantId: string | null }; qty: number; unitCostMinor: number }[] | null {
  const out = [];
  for (const line of lines) {
    const qty = parseQty(line.qty);
    const unitCostMinor = parseCost(line.cost, currency);
    if (qty === null || qty < 1 || unitCostMinor === null) return null;
    out.push({ ref: { productId: line.productId, variantId: line.variantId }, qty, unitCostMinor });
  }
  return out;
}

/** The running total of the editor, or null while a line is incomplete. */
export function editorTotal(lines: readonly EditorLine[], currency: CurrencyCode): number | null {
  const parsed = linesToSubmit(lines, currency);
  if (!parsed) return null;
  return parsed.reduce((total, line) => total + line.qty * line.unitCostMinor, 0);
}

export type ReceiveRow = { poItemId: string; outstanding: number; qty: string; cost: string; poCostMinor: number };

/**
 * Receive form rows → receipt lines. null when a quantity is invalid or above what is outstanding, or
 * a cost is invalid. A cost equal to the PO cost is left out so the server uses the PO's.
 */
export function receiptLines(
  rows: readonly ReceiveRow[],
  currency: CurrencyCode,
): { poItemId: string; qty: number; unitCostMinor?: number }[] | null {
  const out: { poItemId: string; qty: number; unitCostMinor?: number }[] = [];
  for (const row of rows) {
    const qty = parseQty(row.qty);
    if (qty === null || qty > row.outstanding) return null;
    if (qty === 0) continue;
    const cost = parseCost(row.cost, currency);
    if (cost === null) return null;
    out.push(
      cost === row.poCostMinor ? { poItemId: row.poItemId, qty } : { poItemId: row.poItemId, qty, unitCostMinor: cost },
    );
  }
  return out;
}
