import type { ReactNode } from "react";
import { Suspense } from "react";
import { TenantBadge } from "./_components/tenant-badge";
import { LocaleToggle } from "./_components/locale-toggle";
import { SignOutButton } from "./_components/sign-out-button";
import { LoadingOrg } from "./_components/loading-org";
import { AccountLink } from "./_components/account-link";
import { AppShell } from "./_components/app-shell";
import { BrandIcon, BusinessTheme } from "./_components/business-theme";
import { Icon } from "@/app/_ui/icons";
import { DashboardNavLink } from "./_components/dashboard-nav-link";
import { CatalogNavLink } from "./_components/catalog-nav-link";
import { InventoryNavLink } from "./_components/inventory-nav-link";
import { PosNavLink } from "./_components/pos-nav-link";
import { ReturnsNavLink } from "./_components/returns-nav-link";
import { CustomersNavLink } from "./_components/customers-nav-link";
import { AppointmentsNavLink } from "./_components/appointments-nav-link";
import { ReportsNavLink } from "./_components/reports-nav-link";
import { PurchasingNavLink } from "./_components/purchasing-nav-link";
import { SettingsNavLink } from "./_components/settings-nav-link";

/**
 * Authenticated app shell (design-system-spec DS8): sidebar navigation and a top bar. Static
 * chrome prerenders; anything that reads the session streams in behind <Suspense> (required with
 * Cache Components). Each nav link checks its own permission.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const links = [
    DashboardNavLink,
    PosNavLink,
    AppointmentsNavLink,
    ReturnsNavLink,
    CustomersNavLink,
    CatalogNavLink,
    InventoryNavLink,
    PurchasingNavLink,
    ReportsNavLink,
    SettingsNavLink,
  ];
  return (
    <AppShell
      brand={
        <Suspense fallback={<Icon name="store" className="size-6" />}>
          <BrandIcon />
        </Suspense>
      }
      nav={links.map((NavLink, i) => (
        <Suspense key={i} fallback={null}>
          <NavLink />
        </Suspense>
      ))}
      topBar={
        <>
          <div className="min-w-0 flex-1">
            <Suspense fallback={<LoadingOrg />}>
              <TenantBadge />
            </Suspense>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <LocaleToggle />
            <AccountLink />
            <SignOutButton />
          </div>
        </>
      }
    >
      <Suspense fallback={null}>
        <BusinessTheme />
      </Suspense>
      {children}
    </AppShell>
  );
}
