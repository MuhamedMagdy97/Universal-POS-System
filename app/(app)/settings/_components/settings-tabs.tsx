"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { translator } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

const TABS = [
  { href: "/settings/shop", label: "settings.tab.shop" },
  { href: "/settings/receipt", label: "settings.tab.receipt" },
  { href: "/settings/staff", label: "settings.tab.staff" },
  { href: "/settings/branches", label: "settings.tab.branches" },
  { href: "/settings/tables", label: "settings.tab.tables" },
  { href: "/settings/inventory", label: "settings.tab.inventory" },
  { href: "/settings/offline", label: "settings.tab.offline" },
] as const;

/** `tables`: the shop is a café (restaurant-cafe-spec R1, R3). */
export function SettingsTabs({ tables = false }: { tables?: boolean }) {
  const tr = translator(useClientLocale());
  const pathname = usePathname();
  return (
    <nav aria-label={tr("settings.nav")} className="flex flex-wrap gap-4 border-b border-border">
      {TABS.filter((tab) => tables || tab.href !== "/settings/tables").map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={pathname === tab.href ? "page" : undefined}
          className="-mb-px border-b-2 border-transparent px-1 py-2 text-sm aria-[current=page]:border-foreground aria-[current=page]:font-medium"
        >
          {tr(tab.label)}
        </Link>
      ))}
    </nav>
  );
}
