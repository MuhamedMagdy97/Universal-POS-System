import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { prismaTenantRepository, requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { getLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n";
import { inventorySourceOf } from "@/modules/integrations/inventory-sys/source";

/**
 * Session → tenant → permissions → branch for an inventory page. No session → /login?next=…;
 * no read permission → "denied". The branch comes from `?branch=` or the session; an
 * unknown or out-of-scope branch is "notFound" (the same answer the API gives).
 * UI gating only: every service re-checks its own permission and branch scope.
 */

export type InventoryAccess = { read: boolean; adjust: boolean; transfer: boolean };
export type BranchOption = { id: string; name: string; code: string };

export type InventoryPageContext =
  | {
      kind: "ok";
      ctx: TenantContext;
      locale: Locale;
      can: InventoryAccess;
      /** Linked to the inventory system: stock writes are off and the screens say so (spec I18). */
      managed: boolean;
      branches: BranchOption[];
      branch: BranchOption;
    }
  | { kind: "denied"; locale: Locale }
  | { kind: "notFound"; locale: Locale; branches: BranchOption[] };

export async function loadInventoryContext(
  nextPath: string,
  requestedBranch: string | undefined,
): Promise<InventoryPageContext> {
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
  const can: InventoryAccess = {
    read: hasPermission(ctx.role, "inventory.read"),
    adjust: hasPermission(ctx.role, "inventory.adjust") && !managed,
    transfer: hasPermission(ctx.role, "inventory.transfer") && !managed,
  };
  if (!can.read) return { kind: "denied", locale };

  const db = getDb();
  const repo = prismaTenantRepository(db);
  const membership = await repo.findMembership(ctx.orgId, ctx.userId);
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

  const wanted = requestedBranch ?? ctx.branchId ?? branches[0]?.id;
  const branch = branches.find((b) => b.id === wanted);
  if (!branch) return { kind: "notFound", locale, branches };
  return { kind: "ok", ctx, locale, can, managed, branches, branch };
}

/** Display name for an item in history and transfer views (same-org read; null when unknown). */
export async function itemLabel(
  orgId: string,
  productId: string,
  variantId: string | null,
): Promise<{ name: string; variantName: string | null; sku: string; archived: boolean } | null> {
  const db = getDb();
  const product = await db.product.findFirst({
    where: { id: productId, orgId },
    select: { name: true, sku: true, isActive: true },
  });
  if (!product) return null;
  if (!variantId) return { name: product.name, variantName: null, sku: product.sku, archived: !product.isActive };
  const variant = await db.productVariant.findFirst({
    where: { id: variantId, orgId, productId },
    select: { name: true, sku: true, isActive: true },
  });
  if (!variant) return null;
  return {
    name: product.name,
    variantName: variant.name,
    sku: variant.sku,
    archived: !product.isActive || !variant.isActive,
  };
}
