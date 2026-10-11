import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { getDb } from "@/lib/db";
import { forbidden, notFound, unauthenticated } from "@/lib/errors";
import { getSession, toIdentity, type SessionIdentity } from "@/lib/auth/session";
import { hasPermission, type Permission, type Role } from "@/lib/auth/permissions";

/**
 * Tenant guard (service layer). Every tenant-scoped operation starts here.
 *
 * - `orgId` comes from the server-side session, never from the client.
 * - A branch id supplied by the client is only honoured if that branch
 *   belongs to the session's org AND the member may access it.
 * - Branches outside the tenant answer 404, exactly like branches that do
 *   not exist, so nothing about other tenants leaks.
 */

export type TenantContext = {
  userId: string;
  orgId: string;
  membershipId: string;
  role: Role;
  /** Branch the request is scoped to, if any. Always verified. */
  branchId: string | null;
};

export type MembershipRecord = {
  id: string;
  role: Role;
  allBranches: boolean;
  isActive: boolean;
};

export interface TenantRepository {
  findMembership(orgId: string, userId: string): Promise<MembershipRecord | null>;
  /** True only if the branch is an active branch of `orgId` that the membership may use. */
  canAccessBranch(orgId: string, membership: MembershipRecord, branchId: string): Promise<boolean>;
}

export function prismaTenantRepository(db: Db): TenantRepository {
  return {
    async findMembership(orgId, userId) {
      return db.membership.findUnique({
        where: { orgId_userId: { orgId, userId } },
        select: { id: true, role: true, allBranches: true, isActive: true },
      });
    },
    async canAccessBranch(orgId, membership, branchId) {
      const branch = await db.branch.findFirst({
        where: {
          id: branchId,
          orgId,
          isActive: true,
          ...(membership.allBranches ? {} : { membershipBranches: { some: { membershipId: membership.id } } }),
        },
        select: { id: true },
      });
      return branch !== null;
    },
  };
}

const uuid = z.uuid();

export type TenantRequirements = {
  permission?: Permission;
  /** Client-supplied branch (route param/body). Validated, then access-checked. */
  branchId?: string;
};

export async function resolveTenantContext(
  identity: SessionIdentity | null,
  requirements: TenantRequirements,
  repo: TenantRepository,
): Promise<TenantContext> {
  if (!identity) throw unauthenticated();

  const orgId = identity.activeOrganizationId;
  if (!orgId) throw forbidden("No active organization for this session");

  const membership = await repo.findMembership(orgId, identity.userId);
  if (!membership || !membership.isActive) throw forbidden();

  if (requirements.permission && !hasPermission(membership.role, requirements.permission)) {
    throw forbidden("Missing permission for this action");
  }

  let branchId: string | null = null;
  if (requirements.branchId !== undefined) {
    if (!uuid.safeParse(requirements.branchId).success) throw notFound("Branch");
    if (!(await repo.canAccessBranch(orgId, membership, requirements.branchId))) throw notFound("Branch");
    branchId = requirements.branchId;
  } else if (identity.activeBranchId) {
    // A stale session branch (removed access) silently falls back to "no branch".
    if (await repo.canAccessBranch(orgId, membership, identity.activeBranchId)) {
      branchId = identity.activeBranchId;
    }
  }

  return { userId: identity.userId, orgId, membershipId: membership.id, role: membership.role, branchId };
}

/** Route-handler/server-action entry point: session → verified tenant context. */
export async function requireTenant(headers: Headers, requirements: TenantRequirements = {}): Promise<TenantContext> {
  const identity = toIdentity(await getSession(headers));
  return resolveTenantContext(identity, requirements, prismaTenantRepository(getDb()));
}

/** Prisma `where` fragment that pins a query to the caller's tenant. */
export function tenantWhere(ctx: TenantContext): { orgId: string } {
  return { orgId: ctx.orgId };
}

/** For rows loaded by id: anything missing or owned by another tenant is a 404. */
export function assertTenantOwned<T extends { orgId: string }>(ctx: TenantContext, row: T | null, entity: string): T {
  if (!row || row.orgId !== ctx.orgId) throw notFound(entity);
  return row;
}
