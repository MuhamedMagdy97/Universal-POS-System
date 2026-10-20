import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { getLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n";
import { reportSettings } from "@/modules/reports";

/**
 * Session → tenant → customers access for a page (customers-spec CU13). No session → /login?next=…;
 * no `customers.read` → "denied". UI gating only: the service re-checks every call.
 */

export type CustomersPageContext =
  | {
      kind: "ok";
      ctx: TenantContext;
      locale: Locale;
      zone: string;
      can: { create: boolean; manage: boolean };
    }
  | { kind: "denied"; locale: Locale };

export async function loadCustomersContext(nextPath: string): Promise<CustomersPageContext> {
  const [locale, requestHeaders] = await Promise.all([getLocale(), headers()]);
  let ctx: TenantContext;
  try {
    ctx = await requireTenant(requestHeaders);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") {
      redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    }
    if (err instanceof AppError && err.code === "FORBIDDEN") return { kind: "denied", locale };
    throw err;
  }
  if (!hasPermission(ctx.role, "customers.read")) return { kind: "denied", locale };
  const { zone } = await reportSettings(ctx.orgId);
  return {
    kind: "ok",
    ctx,
    locale,
    zone,
    can: { create: hasPermission(ctx.role, "customers.create"), manage: hasPermission(ctx.role, "customers.manage") },
  };
}
