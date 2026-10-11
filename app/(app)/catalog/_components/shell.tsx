import Link from "next/link";
import type { ReactNode } from "react";
import { translator, type Locale } from "@/lib/i18n";

/** Products | Categories sub-navigation shown on every catalog page. */
export function CatalogSubnav({ locale, current }: { locale: Locale; current: "products" | "categories" }) {
  const tr = translator(locale);
  const item = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-3 py-1 text-sm ${active ? "bg-foreground text-background" : "border border-border"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label={tr("catalog.nav")} className="flex gap-2">
      {item("/catalog/products", tr("catalog.nav.products"), current === "products")}
      {item("/catalog/categories", tr("catalog.nav.categories"), current === "categories")}
    </nav>
  );
}

/** 403 state: no catalog data is rendered (C-13). */
export function PermissionDenied({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="flex flex-col gap-2 rounded-md border border-border p-6">
      <h1 className="text-xl font-semibold">{tr("catalog.state.forbidden")}</h1>
      <p className="text-muted">{tr("catalog.state.forbiddenBody")}</p>
    </section>
  );
}

export function StatusBadge({ locale, active }: { locale: Locale; active: boolean }) {
  const tr = translator(locale);
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs ${
        active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-700"
      }`}
    >
      {active ? tr("catalog.status.active") : tr("catalog.status.archived")}
    </span>
  );
}

/** Wraps catalog page content in the locale's direction so the region renders correctly before hydration. */
export function CatalogPage({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <div lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} className="flex flex-col gap-4">
      {children}
    </div>
  );
}

/** Table skeleton for the product list (Suspense fallback; no text so it needs no locale). */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <div className="h-8 w-48 animate-pulse rounded bg-border" />
      <div className="h-10 w-full animate-pulse rounded bg-border" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 w-full animate-pulse rounded bg-border opacity-60" />
      ))}
    </div>
  );
}
