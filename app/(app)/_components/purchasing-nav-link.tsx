import Link from "next/link";
import { headers } from "next/headers";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Purchasing" header link, shown with `purchases.manage` or `purchases.receive` (cosmetic: the page and services re-check). */
export async function PurchasingNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let allowed = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    allowed = hasPermission(ctx.role, "purchases.manage") || hasPermission(ctx.role, "purchases.receive");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  if (!allowed) return null;
  return (
    <Link href="/purchasing" className="text-sm underline-offset-4 hover:underline">
      {translator(locale)("purchasing.nav")}
    </Link>
  );
}
