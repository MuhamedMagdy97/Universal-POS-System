import Link from "next/link";
import { headers } from "next/headers";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Reports", "Audit trail" and "Offline review" header links (cosmetic: the pages and services re-check). */
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
      {reports ? (
        <Link href="/reports" className="text-sm underline-offset-4 hover:underline">
          {tr("reports.nav")}
        </Link>
      ) : null}
      {audit ? (
        <Link href="/audit" className="text-sm underline-offset-4 hover:underline">
          {tr("audit.nav")}
        </Link>
      ) : null}
      {review ? (
        <Link href="/reports/offline-review" className="text-sm underline-offset-4 hover:underline">
          {tr("review.nav")}
        </Link>
      ) : null}
    </>
  );
}
