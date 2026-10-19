import { Suspense } from "react";
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
import { formatMinor } from "@/lib/money";
import { countLowStock } from "@/modules/inventory";
import { branchesInScope, getDashboardTiles, type DashboardTiles } from "@/modules/reports";

/**
 * Dashboard: today's tiles for `reports.view` users (T9, P11), a low-stock tile for `inventory.read`
 * users (low-stock-spec L9); a greeting for everyone.
 */
export default function DashboardPage() {
  return (
    <section className="flex flex-col gap-4">
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
  let noShop = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    [tiles, lowStock] = await Promise.all([getDashboardTiles(ctx), lowStockTile(ctx)]);
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
  const items = tiles
    ? [
        { label: tr("dashboard.tile.netSales"), value: money(tiles.netSalesMinor), href: today("sales-summary") },
        { label: tr("dashboard.tile.sales"), value: String(tiles.salesCount), href: today("sales-summary") },
        { label: tr("dashboard.tile.refunds"), value: money(tiles.refundsMinor), href: today("refunds-voids") },
        { label: tr("dashboard.tile.openShifts"), value: String(tiles.openShifts), href: today("shifts") },
      ]
    : [];

  return (
    <>
      <h1 className="text-2xl font-semibold">{tr("dashboard.title")}</h1>
      <p>{tr("dashboard.greeting", { name: session.user.name })}</p>
      {tiles ? (
        <>
          <h2 className="text-lg font-medium">{tr("dashboard.today")}</h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {items.map((item) => (
              <li key={item.label}>
                <Link
                  href={item.href}
                  className="flex flex-col gap-1 rounded-md border border-border p-4 hover:bg-foreground/5"
                >
                  <span className="text-sm text-muted">{item.label}</span>
                  <span dir="ltr" className="text-start text-xl font-semibold tabular-nums">
                    {item.value}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {lowStock ? (
        <Link
          href={`/inventory/low-stock?branch=${lowStock.branch.id}`}
          className="flex w-fit min-w-48 flex-col gap-1 rounded-md border border-border p-4 hover:bg-foreground/5"
        >
          <span className="text-sm text-muted">{tr("dashboard.tile.lowStock", { branch: lowStock.branch.name })}</span>
          <span
            dir="ltr"
            className={`text-start text-xl font-semibold tabular-nums ${lowStock.count > 0 ? "text-amber-700" : ""}`}
          >
            {lowStock.count}
          </span>
        </Link>
      ) : null}
    </>
  );
}

/** Low items at the session branch, else the first branch in scope by name (as the inventory pages pick). */
async function lowStockTile(ctx: TenantContext) {
  if (!hasPermission(ctx.role, "inventory.read")) return null;
  const branches = await branchesInScope(ctx);
  const branch = branches.find((b) => b.id === ctx.branchId) ?? branches[0];
  if (!branch) return null;
  return { branch, count: await countLowStock(ctx, branch.id) };
}
