"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/app/_ui/icons";
import { t } from "@/lib/i18n";
import { useClientLocale } from "@/lib/i18n/client";

/**
 * Sidebar shell (design-system-spec DS8). Full sidebar from 1024 px, icons only from 640 px and
 * on the till, and below 640 px a menu button opens the same sidebar over the page (Escape, the
 * close button, the backdrop or a navigation closes it). `nav` and `topBar` are Server Components.
 */
export function AppShell({ nav, topBar, children }: { nav: ReactNode; topBar: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const locale = useClientLocale();
  // Open for the page it was opened on: a navigation closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const collapsed = pathname === "/pos" || pathname.startsWith("/pos/");

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenOn(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="flex min-h-dvh">
      <aside
        id="app-sidebar"
        data-collapsed={collapsed}
        data-open={open}
        className={`group z-40 flex-col gap-4 border-e border-border bg-surface p-3 ${
          open ? "fixed inset-y-0 start-0 flex w-64 shadow-xl" : "hidden"
        } sm:sticky sm:top-0 sm:flex sm:h-dvh sm:w-16 sm:shadow-none lg:w-60 lg:data-[collapsed=true]:w-16`}
      >
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/dashboard"
            title="Universal POS"
            className="flex min-h-10 items-center gap-2 rounded-lg px-2 font-semibold text-accent sm:max-lg:justify-center sm:group-data-[collapsed=true]:justify-center"
          >
            <Icon name="store" className="size-6" />
            <span className="truncate text-foreground sm:max-lg:sr-only sm:group-data-[collapsed=true]:sr-only">
              Universal POS
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setOpenOn(null)}
            aria-label={t(locale, "app.closeMenu")}
            className="btn btn-ghost btn-sm sm:hidden"
          >
            <Icon name="close" />
          </button>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1 overflow-y-auto">
          {nav}
        </nav>
      </aside>
      {open ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setOpenOn(null)}
          className="fixed inset-0 z-30 bg-black/30 sm:hidden"
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur">
          <button
            type="button"
            onClick={() => setOpenOn(pathname)}
            aria-label={t(locale, "app.menu")}
            aria-expanded={open}
            aria-controls="app-sidebar"
            className="btn btn-ghost btn-sm sm:hidden"
          >
            <Icon name="menu" />
          </button>
          {topBar}
        </header>
        <main className="flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
