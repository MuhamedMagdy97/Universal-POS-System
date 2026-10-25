import { divideRoundHalfUp, multiply, normalizeDigits } from "./money";

/**
 * Quantities (docs/planning/ui-refresh/weighed-selling-spec.md W1, W3, W7). Stored quantities are integers: pieces
 * for `EACH`, grams for `KG`. This file is the only place that turns grams into kg or prices a weight.
 */

export type QtyUnit = "EACH" | "KG";

/** Grams per kg. */
export const KG_SCALE = 1000;

/** Most of one item on one line or movement: 1,000,000 pieces, or 1,000 kg in grams. */
export const MAX_QTY = 1_000_000;

/** A line's amount: `price × pieces`, or `price per kg × grams ÷ 1000` rounded half up. */
export function lineMinor(unitPriceMinor: number, qty: number, unitType: QtyUnit): number {
  // Only KG is a weight; any other unit (old data, a snapshot from elsewhere) counts as pieces.
  if (unitType !== "KG") return multiply(unitPriceMinor, qty);
  const exact = BigInt(multiply(unitPriceMinor, qty));
  return Number(divideRoundHalfUp(exact, BigInt(KG_SCALE)));
}

/**
 * A quantity typed in a box: whole pieces for `EACH`; kg with up to 3 decimals (`.`, `,` or `٫`) for `KG`, as grams.
 * Arabic-Indic digits are read. Null when empty, invalid, zero or over `MAX_QTY`.
 */
export function parseQtyInput(raw: string, unitType: QtyUnit): number | null {
  const text = normalizeDigits(raw).trim().replace(",", ".");
  let value: number;
  if (unitType === "EACH") {
    if (!/^\d+$/.test(text)) return null;
    value = Number(text);
  } else {
    const match = /^(\d*)(?:\.(\d{0,3}))?$/.exec(text);
    if (!match || (match[1] === "" && !match[2])) return null;
    value = Number(match[1] || "0") * KG_SCALE + Number((match[2] ?? "").padEnd(3, "0"));
  }
  return value >= 1 && value <= MAX_QTY ? value : null;
}

/** The number for an input box: `"3"`, or kg with 3 decimals (`"0.750"`). */
export function qtyInputValue(qty: number, unitType: QtyUnit): string {
  if (unitType === "EACH") return String(qty);
  const sign = qty < 0 ? "-" : "";
  const grams = Math.abs(qty);
  return `${sign}${Math.floor(grams / KG_SCALE)}.${String(grams % KG_SCALE).padStart(3, "0")}`;
}

/** A quantity for reading: `"3"`, or `"0.750 kg"` / `"0.750 كجم"` (Latin digits, as amounts are shown). */
export function formatQty(qty: number, unitType: QtyUnit, locale: "en" | "ar"): string {
  if (unitType === "EACH") return String(qty);
  return `${qtyInputValue(qty, unitType)} ${locale === "ar" ? "كجم" : "kg"}`;
}
