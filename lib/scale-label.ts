import { normalizeDigits } from "./money";

/**
 * Scale labels (docs/planning/ui-refresh/weighed-selling-spec.md W6): a 13-digit EAN-13 printed by a shop scale.
 * Layout: prefix (2) + item code (`itemDigits`) + value (the rest) + check digit. Prefix + item code is looked up
 * as an existing barcode of a KG product. Client-safe and pure.
 */

export type ScaleValueKind = "WEIGHT" | "PRICE";

export type ScaleSettings = {
  enabled: boolean;
  /** Two digits each, starting with `2` (the EAN in-store range). */
  prefixes: readonly string[];
  /** 4 … 6. */
  itemDigits: number;
  /** WEIGHT: the value is grams. PRICE: the value is the line total in minor units. */
  valueKind: ScaleValueKind;
};

export const DEFAULT_SCALE_SETTINGS: ScaleSettings = {
  enabled: false,
  prefixes: ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"],
  itemDigits: 5,
  valueKind: "WEIGHT",
};

export type ScaleLabel =
  | { kind: "label"; lookupCode: string; valueKind: ScaleValueKind; value: number }
  /** Looks like a label of this shop but the check digit is wrong: refused, never looked up. */
  | { kind: "bad-check-digit" };

/** The EAN-13 check digit of the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  let total = 0;
  for (let index = 0; index < 12; index += 1) total += Number(first12[index]) * (index % 2 === 0 ? 1 : 3);
  return (10 - (total % 10)) % 10;
}

/** A scanned code → a scale label, or null when it is not one (labels off, wrong length, other prefix). */
export function parseScaleLabel(raw: string, settings: ScaleSettings): ScaleLabel | null {
  if (!settings.enabled) return null;
  const code = normalizeDigits(raw).trim();
  if (!/^\d{13}$/.test(code) || !settings.prefixes.includes(code.slice(0, 2))) return null;
  if (ean13CheckDigit(code) !== Number(code[12])) return { kind: "bad-check-digit" };
  const itemEnd = 2 + settings.itemDigits;
  const value = Number(code.slice(itemEnd, 12));
  if (value < 1) return null;
  return { kind: "label", lookupCode: code.slice(0, itemEnd), valueKind: settings.valueKind, value };
}
