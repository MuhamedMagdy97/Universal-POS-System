import { headers } from "next/headers";
import { NavItem } from "./nav-item";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Till" sidebar link, shown only with `sales.create` (cosmetic: the page and services re-check). */
export async function PosNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let canSell = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    canSell = hasPermission(ctx.role, "sales.create");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  if (!canSell) return null;
  return <NavItem href="/pos" label={translator(locale)("pos.nav")} icon="till" />;
}
