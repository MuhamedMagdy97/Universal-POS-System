import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { AppError } from "@/lib/errors";
import type { Locale } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

export type SettingsPage = { kind: "ok"; ctx: TenantContext; locale: Locale } | { kind: "denied"; locale: Locale };

/** Session, tenant and permission for a settings screen; the services check the permission again. */
export async function loadSettingsPage(
  permission: "settings.manage" | "users.manage",
  path: string,
): Promise<SettingsPage> {
  const [locale, requestHeaders] = await Promise.all([getLocale(), headers()]);
  let ctx: TenantContext | null = null;
  try {
    ctx = await requireTenant(requestHeaders);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(path)}`);
    if (!(err instanceof AppError && err.code === "FORBIDDEN")) throw err;
  }
  if (!ctx || !hasPermission(ctx.role, permission)) return { kind: "denied", locale };
  return { kind: "ok", ctx, locale };
}
