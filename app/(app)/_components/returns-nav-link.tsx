import { headers } from "next/headers";
import { NavItem } from "./nav-item";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Returns" sidebar link, shown with `sales.refund` or `sales.void` (cosmetic: the page and services re-check). */
export async function ReturnsNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let allowed = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    allowed = hasPermission(ctx.role, "sales.refund") || hasPermission(ctx.role, "sales.void");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  if (!allowed) return null;
  return <NavItem href="/returns" label={translator(locale)("returns.nav")} icon="returns" />;
}
