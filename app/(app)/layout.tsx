import type { ReactNode } from "react";
import { Suspense } from "react";
import Link from "next/link";
import { TenantBadge } from "./_components/tenant-badge";
import { LocaleToggle } from "./_components/locale-toggle";
import { SignOutButton } from "./_components/sign-out-button";
import { LoadingOrg } from "./_components/loading-org";
import { AccountLink } from "./_components/account-link";
import { CatalogNavLink } from "./_components/catalog-nav-link";
import { InventoryNavLink } from "./_components/inventory-nav-link";
import { PosNavLink } from "./_components/pos-nav-link";
import { ReturnsNavLink } from "./_components/returns-nav-link";
import { CustomersNavLink } from "./_components/customers-nav-link";
import { ReportsNavLink } from "./_components/reports-nav-link";
import { PurchasingNavLink } from "./_components/purchasing-nav-link";
import { SettingsNavLink } from "./_components/settings-nav-link";

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
        <Suspense fallback={<LoadingOrg />}>
          <TenantBadge />
        </Suspense>
        <nav aria-label="Main" className="flex items-center gap-3">
          <Suspense fallback={null}>
            <PosNavLink />
          </Suspense>
          <Suspense fallback={null}>
            <ReturnsNavLink />
          </Suspense>
          <Suspense fallback={null}>
            <CustomersNavLink />
          </Suspense>
          <Suspense fallback={null}>
            <CatalogNavLink />
          </Suspense>
          <Suspense fallback={null}>
            <InventoryNavLink />
          </Suspense>
          <Suspense fallback={null}>
            <PurchasingNavLink />
          </Suspense>
          <Suspense fallback={null}>
            <ReportsNavLink />
          </Suspense>
          <Suspense fallback={null}>
            <SettingsNavLink />
          </Suspense>
        </nav>
        <div className="ms-auto flex items-center gap-3">
          <LocaleToggle />
          <AccountLink />
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
