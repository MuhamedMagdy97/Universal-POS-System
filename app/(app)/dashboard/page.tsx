import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import { PageHeader } from "@/app/_ui/page-header";
import { StatTile } from "@/app/_ui/stat-tile";
import { formatMinor } from "@/lib/money";
import { countLowStock } from "@/modules/inventory";
import { inventorySourceOf } from "@/modules/integrations/inventory-sys/source";
import { orgBusinessType } from "@/modules/org";
import { profileOf, type DashboardTile } from "@/modules/presets";
import {
  averageTicketMinor,
  branchesInScope,
  getDashboardTiles,
  getTopItemsToday,
  type DashboardTiles,
  type TopItem,
} from "@/modules/reports";

/**
 * Dashboard: today's tiles for `reports.view` users (T9, P11), a low-stock tile for `inventory.read`
 * users (low-stock-spec L9); a greeting for everyone. Which tiles and their order come from the shop's business
 * profile (business-profiles-spec BP10).
 */
export default function DashboardPage() {
  return (
    <section className="flex flex-col gap-6">
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <DashboardContent />
      </Suspense>
    </section>
  );
}

async function DashboardContent() {
  const requestHeaders = await headers();
  const [session, locale] = await Promise.all([getSession(requestHeaders), getLocale()]);
  if (!session) redirect("/login");
  const tr = translator(locale);

  let tiles: DashboardTiles | null = null;
  let lowStock: Awaited<ReturnType<typeof lowStockTile>> = null;
  let top: TopItem[] | null = null;
  let profile = profileOf("RETAIL");
  let noShop = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    profile = profileOf(await orgBusinessType(ctx.orgId));
    [tiles, lowStock, top] = await Promise.all([
      getDashboardTiles(ctx),
      lowStockTile(ctx),
      profile.dashboardTiles.includes("topItems") ? getTopItemsToday(ctx) : null,
    ]);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    noShop = !session.session.activeOrganizationId;
  }
  // Signed in but not in any shop yet (e.g. signed up through the API): finish setup (onboarding O7).
  if (noShop && !(await getDb().membership.findFirst({ where: { userId: session.user.id }, select: { id: true } }))) {
    redirect("/onboarding");
  }

  const money = (minor: number) => (tiles ? formatMinor(minor, tiles.currency, locale) : "");
  const today = (report: string) => `/reports?report=${report}&range=today`;
  const average = tiles ? averageTicketMinor(tiles.netSalesMinor, tiles.salesCount) : null;

  // BP10: the profile picks which tiles show and their order; each still follows its permission.
  const tile = (name: DashboardTile): ReactNode => {
    if (name === "lowStock") {
      return lowStock ? (
        <StatTile
          label={tr("dashboard.tile.lowStock", { branch: lowStock.branch.name })}
          value={String(lowStock.count)}
          href={`/inventory/low-stock?branch=${lowStock.branch.id}`}
          tone={lowStock.count > 0 ? "warning" : "neutral"}
        />
      ) : null;
    }
    if (name === "topItems") {
      return top ? (
        <TopItemsCard
          title={tr(profile.itemWord === "services" ? "dashboard.tile.topServices" : "dashboard.tile.topItems")}
          empty={tr("dashboard.tile.topEmpty")}
          href={today("products")}
          rows={top.map((row) => ({ name: (locale === "ar" && row.nameAr) || row.name, qty: row.qty }))}
        />
      ) : null;
    }
    if (!tiles) return null;
    switch (name) {
      case "netSales":
        return (
          <StatTile
            label={tr("dashboard.tile.netSales")}
            value={money(tiles.netSalesMinor)}
            href={today("sales-summary")}
          />
        );
      case "sales":
        return (
          <StatTile label={tr("dashboard.tile.sales")} value={String(tiles.salesCount)} href={today("sales-summary")} />
        );
      case "refunds":
        return (
          <StatTile
            label={tr("dashboard.tile.refunds")}
            value={money(tiles.refundsMinor)}
            href={today("refunds-voids")}
          />
        );
      case "openShifts":
        return (
          <StatTile label={tr("dashboard.tile.openShifts")} value={String(tiles.openShifts)} href={today("shifts")} />
        );
      case "averageTicket":
        return (
          <StatTile
            label={tr("dashboard.tile.averageTicket")}
            value={average === null ? "—" : money(average)}
            href={today("sales-summary")}
          />
        );
    }
  };
  const shown = profile.dashboardTiles.map((name) => ({ name, node: tile(name) })).filter((t) => t.node !== null);

  return (
    <>
      <PageHeader title={tr("dashboard.title")} subtitle={tr("dashboard.greeting", { name: session.user.name })} />
      {shown.length > 0 ? (
        <section className="flex flex-col gap-3">
          {tiles ? <h2 className="text-lg font-medium">{tr("dashboard.today")}</h2> : null}
          <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {shown.map(({ name, node }) => (
              <li key={name} className={`grid ${name === "topItems" ? "col-span-2 row-span-2" : ""}`}>
                {node}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** BP10: up to five best sellers today, linking to the Products report. */
function TopItemsCard({
  title,
  empty,
  href,
  rows,
}: {
  title: string;
  empty: string;
  href: string;
  rows: { name: string; qty: number }[];
}) {
  return (
    <Link href={href} className="card flex flex-col gap-2 transition-colors hover:border-border-strong">
      <span className="text-sm text-muted">{title}</span>
      {rows.length === 0 ? (
        <span className="text-sm text-muted">{empty}</span>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.name} className="flex items-baseline justify-between gap-3">
              <span className="truncate">{row.name}</span>
              <span dir="ltr" className="font-semibold tabular-nums">
                {row.qty}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Link>
  );
}

/** Low items at the session branch, else the first branch in scope by name (as the inventory pages pick). */
async function lowStockTile(ctx: TenantContext) {
  if (!hasPermission(ctx.role, "inventory.read")) return null;
  // A linked shop's stock lives in the inventory system (integration spec I18).
  if ((await inventorySourceOf(ctx.orgId)) === "EXTERNAL") return null;
  const branches = await branchesInScope(ctx);
  const branch = branches.find((b) => b.id === ctx.branchId) ?? branches[0];
  if (!branch) return null;
  return { branch, count: await countLowStock(ctx, branch.id) };
}
