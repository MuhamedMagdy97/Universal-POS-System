import type { ReactNode } from "react";
import { Suspense } from "react";
import Link from "next/link";
import { TenantBadge } from "./_components/tenant-badge";
import { LocaleToggle } from "./_components/locale-toggle";
import { SignOutButton } from "./_components/sign-out-button";
import { CatalogNavLink } from "./_components/catalog-nav-link";
import { InventoryNavLink } from "./_components/inventory-nav-link";

/**
 * Authenticated app shell. Static chrome prerenders; anything that reads the
 * session streams in behind <Suspense> (required with Cache Components).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-2">
        <Link href="/dashboard" className="font-semibold">
          Universal POS
        </Link>
        <Suspense fallback={<span className="text-muted">Loading organization…</span>}>
          <TenantBadge />
        </Suspense>
        <nav aria-label="Main" className="flex items-center gap-3">
          <Suspense fallback={null}>
            <CatalogNavLink />
          </Suspense>
          <Suspense fallback={null}>
            <InventoryNavLink />
          </Suspense>
        </nav>
        <div className="ms-auto flex items-center gap-3">
          <LocaleToggle />
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
