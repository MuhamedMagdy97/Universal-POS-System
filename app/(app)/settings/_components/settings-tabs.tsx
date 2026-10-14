"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { translator } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

const TABS = [
  { href: "/settings/receipt", label: "settings.tab.receipt" },
  { href: "/settings/staff", label: "settings.tab.staff" },
  { href: "/settings/branches", label: "settings.tab.branches" },
] as const;

export function SettingsTabs() {
  const tr = translator(useClientLocale());
  const pathname = usePathname();
  return (
    <nav aria-label={tr("settings.nav")} className="flex gap-4 border-b border-border">
      {TABS.map((tab) => (
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
