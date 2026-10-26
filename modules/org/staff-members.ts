import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { requirePermission } from "./access";

/**
 * Staff members (docs/planning/ui-refresh/salon-spec.md S3): the people who do the work, with their branches and
 * commission. Owner and Admin save them (`settings.manage`), audited as `settings.staff_member.saved`. Any member of
 * the shop reads the active ones of a branch (the till and the calendar).
 */

export type StaffMemberRow = {
  id: string;
  name: string;
  nameAr: string | null;
  commissionBp: number;
  isActive: boolean;
  branchIds: string[];
};

const Name = z.string().trim().min(1).max(60);

export const StaffMemberInput = z.strictObject({
  id: z.uuid().optional(),
  name: Name,
  nameAr: Name.nullable().optional(),
  commissionBp: z.int().min(0).max(10_000),
  branchIds: z.array(z.uuid()).min(1).max(50),
  isActive: z.boolean().default(true),
});

const SELECT = {
  id: true,
  name: true,
  nameAr: true,
  commissionBp: true,
  isActive: true,
  branches: { select: { branchId: true } },
} as const;

type Row = {
  id: string;
  name: string;
  nameAr: string | null;
  commissionBp: number;
  isActive: boolean;
  branches: { branchId: string }[];
};

const toRow = ({ branches, ...row }: Row): StaffMemberRow => ({
  ...row,
  branchIds: branches.map((branch) => branch.branchId),
});

/** All staff members (settings), or the active ones of `branchId` (till, calendar), by order then name. */
export async function listStaffMembers(ctx: TenantContext, branchId?: string): Promise<StaffMemberRow[]> {
  const rows = await getDb().staffMember.findMany({
    where: {
      orgId: ctx.orgId,
      ...(branchId && { isActive: true, branches: { some: { branchId } } }),
    },
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: SELECT,
  });
  return rows.map(toRow);
}

/** Creates or updates one staff member. */
export async function saveStaffMember(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<StaffMemberRow> {
  await requirePermission(ctx, "settings.manage", { operation: "staff_member.save", entityType: "StaffMember", meta });
  const data = StaffMemberInput.parse(input);
  return getDb().$transaction(async (tx) => {
    const branches = await tx.branch.count({ where: { orgId: ctx.orgId, id: { in: data.branchIds } } });
    if (branches !== new Set(data.branchIds).size) throw notFound("Branch");
    const fields = {
      name: data.name,
      nameAr: data.nameAr ?? null,
      commissionBp: data.commissionBp,
      isActive: data.isActive,
    };
    let id: string;
    if (data.id) {
      const found = await tx.staffMember.findFirst({ where: { id: data.id, orgId: ctx.orgId }, select: { id: true } });
      if (!found) throw notFound("StaffMember");
      id = found.id;
      await tx.staffMember.update({ where: { id }, data: fields });
      await tx.staffMemberBranch.deleteMany({ where: { orgId: ctx.orgId, staffMemberId: id } });
    } else {
      id = (await tx.staffMember.create({ data: { orgId: ctx.orgId, ...fields } })).id;
    }
    await tx.staffMemberBranch.createMany({
      data: [...new Set(data.branchIds)].map((branchId) => ({ orgId: ctx.orgId, staffMemberId: id, branchId })),
    });
    await record(tx, {
      ctx,
      meta,
      action: "settings.staff_member.saved",
      entityType: "StaffMember",
      entityId: id,
      metadata: { ...fields, branchIds: data.branchIds, created: !data.id },
    });
    return toRow(await tx.staffMember.findUniqueOrThrow({ where: { id }, select: SELECT }));
  });
}
