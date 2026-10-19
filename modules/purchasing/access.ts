import "server-only";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { prismaTenantRepository, type TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { assertBuiltIn } from "@/modules/integrations/inventory-sys/source";

/**
 * Permission and branch-scope guards for purchasing (P1). The service checks the permission
 * itself and audit-logs a refused attempt, like the other modules. Anything but a read (`VIEW`) is
 * refused for a shop linked to the inventory system (integration spec I18).
 */

export type Tx = Prisma.TransactionClient;

export async function requirePermission(
  ctx: TenantContext,
  permission: Permission | readonly Permission[],
  attempt: { operation: string; entityType: "Supplier" | "PurchaseOrder" | "GoodsReceipt"; meta?: AuditRequestMeta },
): Promise<void> {
  const wanted = typeof permission === "string" ? [permission] : permission;
  if (wanted.some((p) => hasPermission(ctx.role, p))) {
    if (permission !== VIEW) await assertBuiltIn(ctx.orgId);
    return;
  }
  try {
    await record(getDb(), {
      ctx,
      meta: attempt.meta,
      action: "purchasing.permission.denied",
      entityType: attempt.entityType,
      metadata: { permission: wanted.join("|"), operation: attempt.operation },
    });
  } catch {
    // A failed audit write must not turn a 403 into a 500.
  }
  throw forbidden("Missing permission for this action");
}

/** Viewing purchasing needs either purchasing permission. */
export const VIEW: readonly Permission[] = ["purchases.manage", "purchases.receive"];

export function canViewPurchasing(ctx: TenantContext): boolean {
  return VIEW.some((p) => hasPermission(ctx.role, p));
}

export type PurchasingBranch = { id: string; name: string };

/** Active branches in the caller's membership scope, by name (empty when the membership is inactive). */
export async function branchesInScope(ctx: TenantContext): Promise<PurchasingBranch[]> {
  const db = getDb();
  const membership = await prismaTenantRepository(db).findMembership(ctx.orgId, ctx.userId);
  if (!membership || !membership.isActive) return [];
  return db.branch.findMany({
    where: {
      orgId: ctx.orgId,
      isActive: true,
      ...(membership.allBranches ? {} : { membershipBranches: { some: { membershipId: membership.id } } }),
    },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function branchIdsInScope(ctx: TenantContext): Promise<string[]> {
  return (await branchesInScope(ctx)).map((branch) => branch.id);
}
