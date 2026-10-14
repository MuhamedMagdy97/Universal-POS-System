import Link from "next/link";
import { headers } from "next/headers";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Settings" header link for `settings.manage` or `users.manage` (cosmetic: the page and service re-check). */
export async function SettingsNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let show = false;
  try {
    const { role } = await requireTenant(requestHeaders);
    show = hasPermission(role, "settings.manage") || hasPermission(role, "users.manage");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  if (!show) return null;
  return (
    <Link href="/settings/receipt" className="text-sm underline-offset-4 hover:underline">
      {translator(locale)("settings.nav")}
    </Link>
  );
}
