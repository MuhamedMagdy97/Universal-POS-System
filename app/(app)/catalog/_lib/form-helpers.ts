/**
 * Pure helpers for the catalog back-office UI: barcode chips, keyboard
 * shortcuts, money fields, display names and exact-match search.
 * Client-safe; unit-tested in tests/unit/catalog-form-helpers.test.ts.
 */
import { BarcodeCode } from "@/modules/catalog/schemas";
import { MAX_STORABLE_MINOR, MoneyError, parseMajor, toMajorString, type CurrencyCode } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Barcode chips
// ---------------------------------------------------------------------------

export type ChipError = "duplicate" | "invalid";
export type ChipResult = { codes: string[]; error: ChipError | null; added: string | null };

/**
 * Adds a scanned/typed code to a chip list. Blank input is a no-op; a code
 * already in this list or anywhere else in the form (`otherCodes`) is rejected
 * as a duplicate (C-19); an invalid code is rejected. Codes are case-sensitive.
 */
export function addBarcodeChip(codes: readonly string[], raw: string, otherCodes: readonly string[] = []): ChipResult {
  if (raw.trim() === "") return { codes: [...codes], error: null, added: null };
  const parsed = BarcodeCode.safeParse(raw);
  if (!parsed.success) return { codes: [...codes], error: "invalid", added: null };
  const code = parsed.data;
  if (codes.includes(code) || otherCodes.includes(code)) return { codes: [...codes], error: "duplicate", added: null };
  return { codes: [...codes, code], error: null, added: code };
}

export function removeBarcodeChip(codes: readonly string[], code: string): string[] {
  return codes.filter((c) => c !== code);
}

/** Codes that appear more than once across all lists. */
export function duplicateCodes(lists: readonly (readonly string[])[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const list of lists) {
    for (const code of list) {
      if (seen.has(code)) dupes.add(code);
      seen.add(code);
    }
  }
  return dupes;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean };

/** Form shortcuts: Ctrl/Cmd+S saves, Esc cancels. */
export function formShortcut(event: KeyLike): "save" | "cancel" | null {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") return "save";
  if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) return "cancel";
  return null;
}

/** List shortcuts (only when no input has focus): `/` focuses search, `N` opens a new product. */
export function listShortcut(event: KeyLike, inEditableField: boolean): "focusSearch" | "newProduct" | null {
  if (inEditableField || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "/") return "focusSearch";
  if (event.key === "n" || event.key === "N") return "newProduct";
  return null;
}

// ---------------------------------------------------------------------------
// Money fields (major-unit text ↔ integer minor units)
// ---------------------------------------------------------------------------

export type MoneyField = { ok: true; value: number | null } | { ok: false };

/**
 * Parses a price/cost input. Arabic-Indic digits are accepted (parseMajor
 * normalises them). Blank → `null` when `optional`, otherwise invalid.
 * Negative, too many decimals or above the storable range → invalid.
 */
export function parseMoneyField(raw: string, currency: CurrencyCode, optional: boolean): MoneyField {
  if (raw.trim() === "") return optional ? { ok: true, value: null } : { ok: false };
  try {
    const value = parseMajor(raw, currency);
    if (value < 0 || value > MAX_STORABLE_MINOR) return { ok: false };
    return { ok: true, value };
  } catch (err) {
    if (err instanceof MoneyError) return { ok: false };
    throw err;
  }
}

/** Minor units → editable major-unit text ("" for null/undefined). */
export function minorToInput(minor: number | null | undefined, currency: CurrencyCode): string {
  return minor === null || minor === undefined ? "" : toMajorString(minor, currency);
}

// ---------------------------------------------------------------------------
// Display and search
// ---------------------------------------------------------------------------

/** Arabic name in the AR locale when present, else the English name. */
export function displayName(locale: Locale, item: { name: string; nameAr: string | null }): string {
  return locale === "ar" && item.nameAr ? item.nameAr : item.name;
}

/**
 * The product a search should open directly (scanner/SKU entry): an exact SKU
 * match, or the exact-barcode hit the service puts first — recognisable because
 * it matches `q` in none of sku/name/nameAr. Null when there is no exact match.
 */
export function exactMatchId(
  q: string,
  items: readonly { id: string; sku: string; name: string; nameAr: string | null }[],
): string | null {
  const query = q.trim();
  if (!query) return null;
  const upper = query.toUpperCase();
  const skuHit = items.find((item) => item.sku === upper);
  if (skuHit) return skuHit.id;
  const first = items[0];
  if (!first) return null;
  const lower = query.toLowerCase();
  const containsQuery = [first.sku, first.name, first.nameAr ?? ""].some((text) => text.toLowerCase().includes(lower));
  return containsQuery ? null : first.id;
}
