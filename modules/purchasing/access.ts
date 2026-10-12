import "server-only";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { prismaTenantRepository, type TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";

/**
 * Permission and branch-scope guards for purchasing (P1). The service checks the permission
 * itself and audit-logs a refused attempt, like the other modules.
 */

export type Tx = Prisma.TransactionClient;

export async function requirePermission(
  ctx: TenantContext,
  permission: Permission | readonly Permission[],
  attempt: { operation: string; entityType: "Supplier" | "PurchaseOrder" | "GoodsReceipt"; meta?: AuditRequestMeta },
): Promise<void> {
  const wanted = typeof permission === "string" ? [permission] : permission;
  if (wanted.some((p) => hasPermission(ctx.role, p))) return;
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

/** Active branch ids in the caller's membership scope (empty when the membership is inactive). */
export async function branchIdsInScope(ctx: TenantContext): Promise<string[]> {
  const db = getDb();
  const membership = await prismaTenantRepository(db).findMembership(ctx.orgId, ctx.userId);
  if (!membership || !membership.isActive) return [];
  const rows = await db.branch.findMany({
    where: {
      orgId: ctx.orgId,
      isActive: true,
      ...(membership.allBranches ? {} : { membershipBranches: { some: { membershipId: membership.id } } }),
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export async function inScope(ctx: TenantContext, branchId: string): Promise<boolean> {
  return (await branchIdsInScope(ctx)).includes(branchId);
}
