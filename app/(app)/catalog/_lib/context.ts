import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { getLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n";
import type { CurrencyCode } from "@/lib/money";
import { inventorySourceOf } from "@/modules/integrations/inventory-sys/source";

/** `create`/`update` are off for a shop linked to the inventory system (`managed`); `seeCost` follows the role. */
export type CatalogAccess = { read: boolean; create: boolean; update: boolean; seeCost: boolean };

export type CatalogPageContext =
  | { kind: "ok"; ctx: TenantContext; locale: Locale; currency: CurrencyCode; can: CatalogAccess; managed: boolean }
  | { kind: "denied"; locale: Locale };

/**
 * Session → tenant → permissions for a catalog page. Reads request data, so it
 * must run inside a <Suspense> boundary. No session → /login?next=…; no active
 * org or no membership → "denied" (rendered as the permission-denied state).
 * UI gating only: every service re-checks its own permission.
 */
export async function loadCatalogContext(nextPath: string): Promise<CatalogPageContext> {
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

  const managed = (await inventorySourceOf(ctx.orgId)) === "EXTERNAL";
  const can: CatalogAccess = {
    read: hasPermission(ctx.role, "products.read"),
    create: hasPermission(ctx.role, "products.create") && !managed,
    update: hasPermission(ctx.role, "products.update") && !managed,
    seeCost: hasPermission(ctx.role, "products.update"),
  };
  if (!can.read) return { kind: "denied", locale };

  // The org currency is server-side truth; it is never taken from the client.
  const org = await getDb().organization.findUnique({ where: { id: ctx.orgId }, select: { currency: true } });
  if (!org) return { kind: "denied", locale };
  return { kind: "ok", ctx, locale, currency: org.currency, can, managed };
}

/** True when a catalog service rejected the call with 403 (e.g. a role changed mid-session). */
export function isForbidden(err: unknown): boolean {
  return err instanceof AppError && err.code === "FORBIDDEN";
}

export function isNotFound(err: unknown): boolean {
  return err instanceof AppError && err.code === "NOT_FOUND";
}
