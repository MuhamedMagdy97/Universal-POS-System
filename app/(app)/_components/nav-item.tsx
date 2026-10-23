"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/app/_ui/icons";

/**
 * One sidebar link (design-system-spec DS8). Marked `aria-current="page"` inside its section
 * (`match`, default `href`; `exact` for a section whose sub-pages have their own link). The label
 * is only visually hidden when the sidebar is collapsed, so the link keeps its accessible name.
 */
export function NavItem({
  href,
  label,
  icon,
  match,
  exact = false,
}: {
  href: string;
  label: string;
  icon: IconName;
  match?: string;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const base = match ?? href;
  const current = exact ? pathname === base : pathname === base || pathname.startsWith(`${base}/`);
  return (
    <Link
      href={href}
      title={label}
      aria-current={current ? "page" : undefined}
      className="flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-sunken hover:text-foreground aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent sm:max-lg:justify-center sm:group-data-[collapsed=true]:justify-center"
    >
      <Icon name={icon} />
      <span className="truncate sm:max-lg:sr-only sm:group-data-[collapsed=true]:sr-only">{label}</span>
    </Link>
  );
}
