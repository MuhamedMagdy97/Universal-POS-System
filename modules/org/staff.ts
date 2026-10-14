import "server-only";
import { hashPassword } from "@/lib/auth/password";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError, forbidden, notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { isUniqueViolation, orgConflict, recordDenied, requirePermission, type Tx } from "./access";
import { createLogin } from "./setup";
import { canManageRole, StaffInput, StaffPatch, Uuid, type StaffRole } from "./schemas";

/**
 * Staff logins (onboarding O3, O4, O10, O11). `users.manage` (Owner, Admin) adds people with a
 * temporary password, a role and branches. Only an Owner touches Owners and Admins; nobody edits
 * their own membership here; the last active Owner stays an active Owner.
 */

export type StaffRow = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: StaffRole;
  allBranches: boolean;
  branchIds: string[];
  isActive: boolean;
  isSelf: boolean;
};

export async function listStaff(ctx: TenantContext): Promise<StaffRow[]> {
  await requirePermission(ctx, "users.manage", { operation: "staff.list", entityType: "Membership" });
  const rows = await getDb().membership.findMany({
    where: { orgId: ctx.orgId },
    select: {
      id: true,
      role: true,
      allBranches: true,
      isActive: true,
      user: { select: { id: true, name: true, email: true } },
      branches: { select: { branchId: true } },
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    membershipId: row.id,
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    allBranches: row.allBranches,
    branchIds: row.branches.map((branch) => branch.branchId),
    isActive: row.isActive,
    isSelf: row.user.id === ctx.userId,
  }));
}

async function requireRoleRight(
  ctx: TenantContext,
  role: StaffRole,
  attempt: { operation: string; entityId?: string; meta?: AuditRequestMeta },
): Promise<void> {
  if (canManageRole(ctx.role, role)) return;
  await recordDenied(ctx, "staff.permission.denied", { ...attempt, entityType: "Membership" }, { role });
  throw forbidden("Only an owner can manage owners and admins");
}

/** The listed branches must be branches of this shop (inactive ones too: access to them is refused anyway). */
async function checkBranches(tx: Tx, orgId: string, branchIds: readonly string[]): Promise<void> {
  const unique = [...new Set(branchIds)];
  const found = await tx.branch.count({ where: { orgId, id: { in: unique } } });
  if (found !== unique.length) throw notFound("Branch");
}

async function setBranches(tx: Tx, orgId: string, membershipId: string, branchIds: readonly string[]): Promise<void> {
  await tx.membershipBranch.deleteMany({ where: { orgId, membershipId } });
  await tx.membershipBranch.createMany({
    data: [...new Set(branchIds)].map((branchId) => ({ orgId, membershipId, branchId })),
  });
}

export async function addStaff(ctx: TenantContext, input: unknown, meta?: AuditRequestMeta): Promise<StaffRow> {
  await requirePermission(ctx, "users.manage", { operation: "staff.add", entityType: "Membership", meta });
  const data = StaffInput.parse(input);
  await requireRoleRight(ctx, data.role, { operation: "staff.add", meta });
  const passwordHash = await hashPassword(data.password);
  const branchIds = data.branches.allBranches ? [] : data.branches.branchIds;

  try {
    return await getDb().$transaction(async (tx) => {
      if (branchIds.length > 0) await checkBranches(tx, ctx.orgId, branchIds);
      const user = await createLogin(tx, { name: data.name, email: data.email, passwordHash });
      const membership = await tx.membership.create({
        data: { orgId: ctx.orgId, userId: user.id, role: data.role, allBranches: data.branches.allBranches },
        select: { id: true },
      });
      if (branchIds.length > 0) await setBranches(tx, ctx.orgId, membership.id, branchIds);
      await record(tx, {
        ctx,
        meta,
        action: "staff.added",
        entityType: "Membership",
        entityId: membership.id,
        metadata: {
          userId: user.id,
          email: data.email,
          role: data.role,
          allBranches: data.branches.allBranches,
          branchIds,
        },
      });
      return {
        membershipId: membership.id,
        userId: user.id,
        name: data.name,
        email: data.email,
        role: data.role,
        allBranches: data.branches.allBranches,
        branchIds,
        isActive: true,
        isSelf: false,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw orgConflict("EMAIL_TAKEN", "An account with this email already exists");
    throw err;
  }
}

export async function updateStaff(
  ctx: TenantContext,
  membershipId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<void> {
  await requirePermission(ctx, "users.manage", {
    operation: "staff.update",
    entityType: "Membership",
    entityId: membershipId,
    meta,
  });
  if (!Uuid.safeParse(membershipId).success) throw notFound("Staff member");
  const patch = StaffPatch.parse(input);
  const passwordHash = patch.password === undefined ? null : await hashPassword(patch.password);

  const db = getDb();
  const target = await db.membership.findFirst({
    where: { id: membershipId, orgId: ctx.orgId },
    select: { role: true, userId: true },
  });
  if (!target) throw notFound("Staff member");
  if (target.userId === ctx.userId) {
    throw new AppError("FORBIDDEN", "Change your own password under My account", { reason: "SELF" });
  }
  await requireRoleRight(ctx, target.role, { operation: "staff.update", entityId: membershipId, meta });
  if (patch.role) await requireRoleRight(ctx, patch.role, { operation: "staff.update", entityId: membershipId, meta });

  await db.$transaction(async (tx) => {
    // Staff changes queue on the shop row, so two owners cannot demote each other at once (R3).
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${ctx.orgId}::uuid FOR UPDATE`;
    const before = await tx.membership.findUniqueOrThrow({
      where: { id: membershipId },
      select: { role: true, allBranches: true, isActive: true, userId: true, branches: { select: { branchId: true } } },
    });
    // Re-checked under the lock: the role read above may have changed since (O4).
    if (!canManageRole(ctx.role, before.role)) throw forbidden("Only an owner can manage owners and admins");
    const role = patch.role ?? before.role;
    const isActive = patch.isActive ?? before.isActive;
    if (before.role === "OWNER" && before.isActive && (role !== "OWNER" || !isActive)) {
      const owners = await tx.membership.count({ where: { orgId: ctx.orgId, role: "OWNER", isActive: true } });
      if (owners <= 1) throw orgConflict("LAST_OWNER", "The shop needs at least one active owner");
    }

    const base = { ctx, meta, entityType: "Membership", entityId: membershipId } as const;
    const changes: Record<string, unknown> = {};
    if (role !== before.role) changes.role = { from: before.role, to: role };
    if (patch.branches) {
      const branchIds = patch.branches.allBranches ? [] : [...new Set(patch.branches.branchIds)];
      if (branchIds.length > 0) await checkBranches(tx, ctx.orgId, branchIds);
      await setBranches(tx, ctx.orgId, membershipId, branchIds);
      const old = before.branches.map((branch) => branch.branchId).sort();
      if (patch.branches.allBranches !== before.allBranches || branchIds.sort().join() !== old.join()) {
        changes.branches = {
          from: before.allBranches ? "all" : old,
          to: patch.branches.allBranches ? "all" : branchIds,
        };
      }
    }
    await tx.membership.update({
      where: { id: membershipId },
      data: { role, isActive, ...(patch.branches ? { allBranches: patch.branches.allBranches } : {}) },
    });
    if (Object.keys(changes).length > 0) await record(tx, { ...base, action: "staff.updated", metadata: changes });

    if (isActive !== before.isActive) {
      await record(tx, { ...base, action: isActive ? "staff.reactivated" : "staff.deactivated" });
    }
    if (passwordHash) {
      await tx.account.updateMany({
        where: { userId: before.userId, providerId: "credential" },
        data: { password: passwordHash },
      });
      await record(tx, { ...base, action: "staff.password_reset" });
    }
    // Deactivation and a new password both sign the person out everywhere at once (R2).
    if ((!isActive && before.isActive) || passwordHash)
      await tx.session.deleteMany({ where: { userId: before.userId } });
  });
}
