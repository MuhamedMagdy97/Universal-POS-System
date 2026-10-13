import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { getLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n";
import type { CurrencyCode } from "@/lib/money";
import { canViewPurchasing } from "@/modules/purchasing";
import { reportSettings } from "@/modules/reports";

/**
 * Session → tenant → purchasing access for a page. No session → /login?next=…; neither purchasing
 * permission → "denied". UI gating only: every service re-checks permission and branch scope.
 */

export type PurchasingAccess = { manage: boolean; receive: boolean };

export type PurchasingPageContext =
  | { kind: "ok"; ctx: TenantContext; locale: Locale; can: PurchasingAccess; currency: CurrencyCode; zone: string }
  | { kind: "denied"; locale: Locale };

export async function loadPurchasingContext(nextPath: string): Promise<PurchasingPageContext> {
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
  if (!canViewPurchasing(ctx)) return { kind: "denied", locale };
  const { zone, currency } = await reportSettings(ctx.orgId);
  return {
    kind: "ok",
    ctx,
    locale,
    zone,
    currency,
    can: { manage: hasPermission(ctx.role, "purchases.manage"), receive: hasPermission(ctx.role, "purchases.receive") },
  };
}

/** Active suppliers for pickers (same-org read). */
export async function activeSuppliers(orgId: string): Promise<{ id: string; name: string }[]> {
  return getDb().supplier.findMany({
    where: { orgId, isActive: true },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/** `2026-03-10 14:05` in the shop's timezone. */
export function shopDateTime(iso: string | null, zone: string): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Shop details printed at the top of a purchase order (T10 H10). */
export async function shopHeader(orgId: string) {
  const org = await getDb().organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { name: true, legalName: true, taxNumber: true, receiptAddress: true, receiptPhone: true },
  });
  return {
    name: org.legalName ?? org.name,
    taxNumber: org.taxNumber,
    address: org.receiptAddress,
    phone: org.receiptPhone,
  };
}
