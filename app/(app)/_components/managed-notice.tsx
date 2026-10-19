import { translator, type Locale } from "@/lib/i18n";

/** Shown on catalog, stock and purchasing screens of a shop linked to the inventory system (spec I18). */
export function ManagedNotice({ locale, area }: { locale: Locale; area: "catalog" | "stock" }) {
  return (
    <p role="note" data-testid="managed-notice" className="rounded-md border border-border bg-border/30 p-3">
      {translator(locale)(area === "catalog" ? "managed.catalog" : "managed.stock")}
    </p>
  );
}
