import "server-only";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, toLocale, type Locale } from "@/lib/i18n";

/**
 * UI locale for the current request, from the cookie set by the EN/AR toggle.
 * Reads request data, so callers must render behind <Suspense> (Cache Components).
 */
export async function getLocale(): Promise<Locale> {
  return toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}
