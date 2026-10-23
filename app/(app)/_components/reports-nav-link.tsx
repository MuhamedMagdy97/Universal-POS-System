import { headers } from "next/headers";
import { NavItem } from "./nav-item";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Reports", "Audit trail" and "Offline review" sidebar links (cosmetic: the pages and services re-check). */
export async function ReportsNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let reports = false;
  let audit = false;
  let review = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    reports = hasPermission(ctx.role, "reports.view");
    audit = hasPermission(ctx.role, "users.manage");
    review = hasPermission(ctx.role, "sales.review");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  const tr = translator(locale);
  return (
    <>
      {reports ? <NavItem href="/reports" label={tr("reports.nav")} icon="reports" exact /> : null}
      {audit ? <NavItem href="/audit" label={tr("audit.nav")} icon="history" /> : null}
      {review ? <NavItem href="/reports/offline-review" label={tr("review.nav")} icon="alert" /> : null}
    </>
  );
}
