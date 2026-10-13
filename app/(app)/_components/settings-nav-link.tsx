import Link from "next/link";
import { headers } from "next/headers";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant } from "@/lib/auth/tenant";
import { translator } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

/** "Settings" header link for `settings.manage` (cosmetic: the page and service re-check). */
export async function SettingsNavLink() {
  const [requestHeaders, locale] = await Promise.all([headers(), getLocale()]);
  let show = false;
  try {
    show = hasPermission((await requireTenant(requestHeaders)).role, "settings.manage");
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
