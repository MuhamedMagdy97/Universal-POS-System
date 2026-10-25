import type { Locale } from "@/lib/i18n";
import { formatQty } from "@/lib/quantity";
import type { CountSheetItem } from "@/modules/inventory";

export type SheetRow = {
  name: string;
  sku: string;
  barcode: string | null;
  category: string | null;
  /** On-hand as printed: pieces, or kg with 3 decimals for KG (weighed-selling-spec W7). */
  expected: string | null;
};

/** Count-sheet rows in the reader's language, sorted by category (none last), then name, then SKU (C15). */
export function sheetRows(items: readonly CountSheetItem[], locale: Locale): SheetRow[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const pick = (en: string | null, ar: string | null) => (locale === "ar" && ar ? ar : en);
  return items
    .map((item) => {
      const base = pick(item.name, item.nameAr) ?? item.name;
      return {
        name: item.variantName ? `${base} — ${item.variantName}` : base,
        sku: item.sku,
        barcode: item.barcode,
        category: pick(item.categoryName, item.categoryNameAr),
        expected: item.expected === null ? null : formatQty(item.expected, item.unitType, locale),
      };
    })
    .sort(
      (a, b) =>
        (a.category === null ? 1 : 0) - (b.category === null ? 1 : 0) ||
        collator.compare(a.category ?? "", b.category ?? "") ||
        collator.compare(a.name, b.name) ||
        collator.compare(a.sku, b.sku),
    );
}
