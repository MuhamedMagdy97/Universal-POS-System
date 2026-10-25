import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { requirePermission } from "./access";

/**
 * A branch's tables (docs/planning/ui-refresh/restaurant-cafe-spec.md R3). Owner and Admin manage them
 * (`settings.manage`), audited as `settings.tables.updated`. A table is never deleted: leaving it out of a save
 * deactivates it, so old tickets keep their table.
 */

export type DiningTableRow = { id: string; name: string; area: string | null; sortOrder: number; isActive: boolean };

const Text = z.string().trim().min(1).max(40);

export const SaveTablesInput = z.strictObject({
  branchId: z.uuid(),
  tables: z
    .array(
      z.strictObject({
        id: z.uuid().optional(),
        name: Text,
        area: Text.nullable().optional(),
      }),
    )
    .max(200)
    .refine((rows) => new Set(rows.map((row) => row.name.toLowerCase())).size === rows.length, {
      message: "TABLE_NAME_TAKEN",
      path: ["tables"],
    }),
});

const SELECT = { id: true, name: true, area: true, sortOrder: true, isActive: true } as const;

/** The branch's tables, active ones first, in their order. Any member of the shop may read them (the till). */
export async function listTables(ctx: TenantContext, branchId: string): Promise<DiningTableRow[]> {
  return getDb().diningTable.findMany({
    where: { orgId: ctx.orgId, branchId },
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: SELECT,
  });
}

/** Replaces the branch's active tables with `tables`, in this order. */
export async function saveTables(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<DiningTableRow[]> {
  await requirePermission(ctx, "settings.manage", { operation: "tables.update", entityType: "Branch", meta });
  const { branchId, tables } = SaveTablesInput.parse(input);
  return getDb().$transaction(async (tx) => {
    const branch = await tx.branch.findFirst({ where: { id: branchId, orgId: ctx.orgId }, select: { id: true } });
    if (!branch) throw notFound("Branch");
    const existing = await tx.diningTable.findMany({ where: { orgId: ctx.orgId, branchId }, select: SELECT });
    const byId = new Map(existing.map((row) => [row.id, row]));
    for (const row of tables) if (row.id && !byId.has(row.id)) throw notFound("DiningTable");

    const kept = new Set(tables.flatMap((row) => (row.id ? [row.id] : [])));
    // Free the names first: a renamed table may take a name another row gives up in the same save.
    for (const row of existing) {
      await tx.diningTable.update({ where: { id: row.id }, data: { name: `~${row.id}` } });
    }
    for (const [index, row] of tables.entries()) {
      const data = { name: row.name, area: row.area ?? null, sortOrder: index, isActive: true };
      if (row.id) await tx.diningTable.update({ where: { id: row.id }, data });
      else await tx.diningTable.create({ data: { orgId: ctx.orgId, branchId, ...data } });
    }
    for (const row of existing) {
      if (!kept.has(row.id)) {
        // A dropped table keeps its own name back, marked inactive.
        const taken = tables.some((table) => table.name.toLowerCase() === row.name.toLowerCase());
        await tx.diningTable.update({
          where: { id: row.id },
          data: { isActive: false, name: taken ? `${row.name} (${row.id.slice(0, 4)})` : row.name },
        });
      }
    }
    const after = await tx.diningTable.findMany({
      where: { orgId: ctx.orgId, branchId },
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: SELECT,
    });
    await record(tx, {
      ctx,
      meta,
      action: "settings.tables.updated",
      entityType: "Branch",
      entityId: branchId,
      metadata: {
        before: existing.filter((row) => row.isActive).map((row) => row.name),
        after: tables.map((row) => row.name),
      },
    });
    return after;
  });
}
