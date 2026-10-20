import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { prismaTenantRepository, requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { getLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n";
import { previewShiftCash, type CashBreakdown } from "@/modules/registers";
import type { TillSettings } from "./till";

/**
 * Session → tenant → `sales.create` → branch → register → open shift, for the till page.
 * No session → /login?next=…; no sales permission → "denied"; an unknown or out-of-scope
 * branch → "notFound". UI gating only: the sales and shift services re-check everything.
 */

export type BranchOption = { id: string; name: string; code: string };
export type RegisterOption = { id: string; name: string };
export type OpenShift = { id: string; openedAt: string; openingFloatMinor: number };

export type PosPageContext =
  | {
      kind: "ok";
      ctx: TenantContext;
      locale: Locale;
      branches: BranchOption[];
      branch: BranchOption;
      registers: RegisterOption[];
      register: RegisterOption | null;
      shift: OpenShift | null;
      /** Expected cash for the open shift, shown before the count. Null unless the caller can close. */
      shiftCash: CashBreakdown | null;
      settings: TillSettings;
      canOpenShift: boolean;
      canCloseShift: boolean;
    }
  | { kind: "denied"; locale: Locale }
  | { kind: "notFound"; locale: Locale; branches: BranchOption[] };

export async function loadPosContext(
  requestedBranch: string | undefined,
  requestedRegister: string | undefined,
): Promise<PosPageContext> {
  const [locale, requestHeaders] = await Promise.all([getLocale(), headers()]);
  let ctx: TenantContext;
  try {
    ctx = await requireTenant(requestHeaders);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") redirect("/login?next=%2Fpos");
    if (err instanceof AppError && err.code === "FORBIDDEN") return { kind: "denied", locale };
    throw err;
  }
  if (!hasPermission(ctx.role, "sales.create")) return { kind: "denied", locale };

  const db = getDb();
  const membership = await prismaTenantRepository(db).findMembership(ctx.orgId, ctx.userId);
  if (!membership || !membership.isActive) return { kind: "denied", locale };
  const branches = await db.branch.findMany({
    where: {
      orgId: ctx.orgId,
      isActive: true,
      ...(membership.allBranches ? {} : { membershipBranches: { some: { membershipId: membership.id } } }),
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true },
  });
  const wantedBranch = requestedBranch ?? ctx.branchId ?? branches[0]?.id;
  const branch = branches.find((b) => b.id === wantedBranch);
  if (!branch) return { kind: "notFound", locale, branches };

  const [org, registers] = await Promise.all([
    db.organization.findUniqueOrThrow({
      where: { id: ctx.orgId },
      select: { currency: true, vatRateBp: true, pricesIncludeVat: true, maxCashierDiscountBp: true },
    }),
    db.register.findMany({
      where: { orgId: ctx.orgId, branchId: branch.id, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  const register = registers.find((r) => r.id === requestedRegister) ?? registers[0] ?? null;
  const open = register
    ? await db.registerShift.findFirst({
        where: { orgId: ctx.orgId, registerId: register.id, status: "OPEN" },
        select: { id: true, openedAt: true, openingFloatMinor: true },
      })
    : null;

  const canCloseShift = hasPermission(ctx.role, "registers.close");
  const shiftCash = open && canCloseShift ? await previewShiftCash(ctx, open.id) : null;

  return {
    kind: "ok",
    ctx,
    locale,
    branches,
    branch,
    registers,
    register,
    shift: open
      ? { id: open.id, openedAt: open.openedAt.toISOString(), openingFloatMinor: open.openingFloatMinor }
      : null,
    shiftCash,
    settings: {
      currency: org.currency,
      vatRateBp: org.vatRateBp,
      pricesIncludeVat: org.pricesIncludeVat,
      // UI gating only: createSale re-checks the discount (discounts-spec DC7-DC9).
      discount: {
        allowed: hasPermission(ctx.role, "discounts.apply") || hasPermission(ctx.role, "discounts.override"),
        limitBp: hasPermission(ctx.role, "discounts.override") ? null : org.maxCashierDiscountBp,
      },
      // UI gating only: the customers service re-checks (customers-spec CU6, CU12).
      customers: {
        read: hasPermission(ctx.role, "customers.read"),
        create: hasPermission(ctx.role, "customers.create"),
      },
    },
    canOpenShift: hasPermission(ctx.role, "registers.open"),
    canCloseShift,
  };
}
