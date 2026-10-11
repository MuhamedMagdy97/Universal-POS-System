import "server-only";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { prismaTenantRepository, type TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { forbidden, notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";

/**
 * Permission and branch-scope guards for checkout. Same rules as inventory: the service checks
 * the permission itself and audit-logs a denied attempt.
 */

export async function requirePermission(
  ctx: TenantContext,
  permission: Permission,
  attempt: { operation: string; entityType: "Sale" | "RegisterShift"; meta?: AuditRequestMeta },
): Promise<void> {
  if (hasPermission(ctx.role, permission)) return;
  try {
    await record(getDb(), {
      ctx,
      meta: attempt.meta,
      action: "sales.permission.denied",
      entityType: attempt.entityType,
      metadata: { permission, operation: attempt.operation },
    });
  } catch {
    // A failed audit write must not turn a 403 into a 500.
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

/** The register must be active and belong to this branch (else 404). */
export async function requireRegister(
  client: Db | Prisma.TransactionClient,
  orgId: string,
  branchId: string,
  registerId: string,
) {
  const register = await client.register.findFirst({
    where: { id: registerId, orgId, branchId, isActive: true },
    select: { id: true },
  });
  if (!register) throw notFound("Register");
}

/** Postgres unique violation (P2002): a concurrent duplicate write. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}
