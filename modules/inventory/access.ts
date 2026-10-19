import "server-only";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { prismaTenantRepository, type TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { assertBuiltIn } from "@/modules/integrations/inventory-sys/source";

/**
 * Permission and branch-scope guards for inventory services. Same rules as catalog: the
 * service checks the permission itself and audit-logs a denied write attempt (C-14).
 * A write (`attempt` given) is refused for a shop whose stock lives in the inventory system (spec I18).
 */

export type WriteAttempt = { operation: string; entityType: string; meta?: AuditRequestMeta };

export async function requirePermission(
  ctx: TenantContext,
  permission: Permission,
  attempt?: WriteAttempt,
): Promise<void> {
  if (hasPermission(ctx.role, permission)) {
    if (attempt) await assertBuiltIn(ctx.orgId);
    return;
  }
  if (attempt) {
    try {
      await record(getDb(), {
        ctx,
        meta: attempt.meta,
        action: "inventory.permission.denied",
        entityType: attempt.entityType,
        metadata: { permission, operation: attempt.operation },
      });
    } catch {
      // A failed audit write must not turn a 403 into a 500.
    }
  }
  throw forbidden("Missing permission for this action");
}

/** The branch must be active, in the caller's org, and inside the caller's membership scope (else 404). */
export async function requireBranch(ctx: TenantContext, branchId: string): Promise<void> {
  const repo = prismaTenantRepository(getDb());
  const membership = await repo.findMembership(ctx.orgId, ctx.userId);
  if (!membership || !membership.isActive) throw notFound("Branch");
  if (!(await repo.canAccessBranch(ctx.orgId, membership, branchId))) throw notFound("Branch");
}

/** Destination of a transfer: any active branch of the org (D6). Scope is not checked. */
export async function requireActiveBranch(client: Db, orgId: string, branchId: string): Promise<void> {
  const branch = await client.branch.findFirst({
    where: { id: branchId, orgId, isActive: true },
    select: { id: true },
  });
  if (!branch) throw notFound("Branch");
}

/** Postgres unique violation (P2002), raised by a concurrent duplicate write. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}
