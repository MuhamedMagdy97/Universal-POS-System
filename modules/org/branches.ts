import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { hasStockAt } from "@/modules/inventory";
import { hasOpenShift } from "@/modules/registers";
import { isUniqueViolation, orgConflict, requirePermission, type Tx } from "./access";
import { BranchInput, BranchPatch, RegisterInput, RegisterPatch, Uuid } from "./schemas";

/**
 * Branches and tills (onboarding O5, O9, O11), `settings.manage`. Nothing is deleted: a branch
 * or till is deactivated, which is refused while it has stock or an open shift.
 */

export type RegisterRow = { id: string; name: string; isActive: boolean };
export type BranchRow = { id: string; name: string; code: string; isActive: boolean; registers: RegisterRow[] };

const codeTaken = () => orgConflict("BRANCH_CODE_TAKEN", "Another branch already uses this code");
const tillTaken = () => orgConflict("REGISTER_NAME_TAKEN", "This branch already has a till with this name");

function parseId(id: string, entity: string): string {
  if (!Uuid.safeParse(id).success) throw notFound(entity);
  return id;
}

export async function listBranches(ctx: TenantContext): Promise<BranchRow[]> {
  await requirePermission(ctx, "settings.manage", { operation: "branch.list", entityType: "Branch" });
  return getDb().branch.findMany({
    where: { orgId: ctx.orgId },
    select: {
      id: true,
      name: true,
      code: true,
      isActive: true,
      registers: { select: { id: true, name: true, isActive: true }, orderBy: [{ name: "asc" }, { id: "asc" }] },
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }],
  });
}

export async function createBranch(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<{ id: string }> {
  await requirePermission(ctx, "settings.manage", { operation: "branch.create", entityType: "Branch", meta });
  const data = BranchInput.parse(input);
  try {
    return await getDb().$transaction(async (tx) => {
      // Codes are stored upper-case; older rows may not be, so compare ignoring case.
      const clash = await tx.branch.findFirst({
        where: { orgId: ctx.orgId, code: { equals: data.code, mode: "insensitive" } },
        select: { id: true },
      });
      if (clash) throw codeTaken();
      const branch = await tx.branch.create({ data: { orgId: ctx.orgId, ...data }, select: { id: true } });
      await record(tx, {
        ctx,
        meta,
        action: "branch.created",
        entityType: "Branch",
        entityId: branch.id,
        metadata: data,
      });
      return branch;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw codeTaken();
    throw err;
  }
}

export async function updateBranch(
  ctx: TenantContext,
  branchId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<void> {
  await requirePermission(ctx, "settings.manage", { operation: "branch.update", entityType: "Branch", meta });
  const id = parseId(branchId, "Branch");
  const patch = BranchPatch.parse(input);
  await getDb().$transaction(async (tx) => {
    const [before] = await tx.$queryRaw<{ name: string; isActive: boolean }[]>`
      SELECT "name", "isActive" FROM "Branch" WHERE "id" = ${id}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
    if (!before) throw notFound("Branch");
    const base = { ctx, meta, entityType: "Branch", entityId: id } as const;

    if (patch.isActive === false && before.isActive) await assertBranchCanClose(tx, ctx.orgId, id);
    await tx.branch.update({ where: { id }, data: patch });

    if (patch.name !== undefined && patch.name !== before.name) {
      await record(tx, {
        ...base,
        action: "branch.updated",
        metadata: { name: { from: before.name, to: patch.name } },
      });
    }
    if (patch.isActive !== undefined && patch.isActive !== before.isActive) {
      await record(tx, { ...base, action: patch.isActive ? "branch.reactivated" : "branch.deactivated" });
    }
  });
}

async function assertBranchCanClose(tx: Tx, orgId: string, branchId: string): Promise<void> {
  const others = await tx.branch.count({ where: { orgId, isActive: true, id: { not: branchId } } });
  if (others === 0) throw orgConflict("LAST_BRANCH", "The shop needs at least one active branch");
  // Lock the branch's tills: a shift opening on one of them waits, or is seen below (registers/shifts.ts).
  await tx.$queryRaw`SELECT "id" FROM "Register" WHERE "orgId" = ${orgId}::uuid AND "branchId" = ${branchId}::uuid FOR UPDATE`;
  if (await hasOpenShift(tx, orgId, { branchId })) {
    throw orgConflict("BRANCH_HAS_OPEN_SHIFT", "Close the open shifts at this branch first");
  }
  // ponytail: a delivery received at the same moment can still land on a branch being closed; its
  // stock stays on the ledger and shows again on reactivation. Lock the branch in receiving if that matters.
  if (await hasStockAt(tx, orgId, branchId)) {
    throw orgConflict("BRANCH_HAS_STOCK", "Move or write off this branch's stock first");
  }
}

async function requireActiveBranch(tx: Tx, orgId: string, branchId: string): Promise<void> {
  const branch = await tx.branch.findFirst({ where: { id: branchId, orgId }, select: { isActive: true } });
  if (!branch) throw notFound("Branch");
  if (!branch.isActive) throw orgConflict("BRANCH_INACTIVE", "This branch is not active");
}

export async function createRegister(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<{ id: string }> {
  await requirePermission(ctx, "settings.manage", { operation: "register.create", entityType: "Register", meta });
  const data = RegisterInput.parse(input);
  try {
    return await getDb().$transaction(async (tx) => {
      await requireActiveBranch(tx, ctx.orgId, data.branchId);
      const register = await tx.register.create({ data: { orgId: ctx.orgId, ...data }, select: { id: true } });
      await record(tx, {
        ctx,
        meta,
        action: "register.created",
        entityType: "Register",
        entityId: register.id,
        metadata: data,
      });
      return register;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw tillTaken();
    throw err;
  }
}

export async function updateRegister(
  ctx: TenantContext,
  registerId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<void> {
  await requirePermission(ctx, "settings.manage", { operation: "register.update", entityType: "Register", meta });
  const id = parseId(registerId, "Register");
  const patch = RegisterPatch.parse(input);
  try {
    await getDb().$transaction(async (tx) => {
      // Taken before the open-shift check; openShift shares this row lock (registers/shifts.ts).
      const [before] = await tx.$queryRaw<{ name: string; isActive: boolean; branchId: string }[]>`
        SELECT "name", "isActive", "branchId" FROM "Register"
         WHERE "id" = ${id}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
      if (!before) throw notFound("Register");
      const base = { ctx, meta, entityType: "Register", entityId: id } as const;

      if (patch.isActive === false && before.isActive && (await hasOpenShift(tx, ctx.orgId, { registerId: id }))) {
        throw orgConflict("REGISTER_HAS_OPEN_SHIFT", "Close this till's open shift first");
      }
      if (patch.isActive === true && !before.isActive) await requireActiveBranch(tx, ctx.orgId, before.branchId);
      await tx.register.update({ where: { id }, data: patch });

      if (patch.name !== undefined && patch.name !== before.name) {
        await record(tx, {
          ...base,
          action: "register.updated",
          metadata: { name: { from: before.name, to: patch.name } },
        });
      }
      if (patch.isActive !== undefined && patch.isActive !== before.isActive) {
        await record(tx, { ...base, action: patch.isActive ? "register.reactivated" : "register.deactivated" });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw tillTaken();
    throw err;
  }
}
