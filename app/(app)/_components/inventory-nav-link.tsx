import { headers } from "next/headers";
import { NavItem } from "./nav-item";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Inventory" sidebar link, shown only with `inventory.read` (cosmetic: pages and services re-check). */
export async function InventoryNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let canRead = false;
  try {
    const ctx = await requireTenant(requestHeaders);
    canRead = hasPermission(ctx.role, "inventory.read");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  if (!canRead) return null;
  return <NavItem href="/inventory" label={translator(locale)("inventory.nav")} icon="inventory" />;
}
