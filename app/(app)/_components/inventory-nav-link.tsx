import Link from "next/link";
import { headers } from "next/headers";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Inventory" header link, shown only with `inventory.read` (cosmetic: pages and services re-check). */
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
  return (
    <Link href="/inventory" className="text-sm underline-offset-4 hover:underline">
      {translator(locale)("inventory.nav")}
    </Link>
  );
}
