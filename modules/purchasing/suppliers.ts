import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { requirePermission, VIEW } from "./access";
import { purchasingConflict } from "./errors";
import { SupplierInput, SupplierPatch, SupplierQuery, Uuid } from "./schemas";

/** Suppliers (P12): unique name per org ignoring case, archived rather than deleted. */

export type SupplierRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
  isActive: boolean;
};

const SELECT = { id: true, name: true, phone: true, email: true, taxNumber: true, isActive: true } as const;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

function nameTaken() {
  return purchasingConflict("SUPPLIER_NAME_TAKEN", "A supplier with this name already exists");
}

function parseId(id: string): string {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound("Supplier");
  return parsed.data;
}

export async function listSuppliers(ctx: TenantContext, rawQuery: unknown = {}): Promise<SupplierRow[]> {
  await requirePermission(ctx, VIEW, { operation: "supplier.list", entityType: "Supplier" });
  const query = SupplierQuery.parse(rawQuery);
  const contains = query.q ? ({ contains: query.q, mode: "insensitive" } as const) : undefined;
  return getDb().supplier.findMany({
    where: {
      orgId: ctx.orgId,
      ...(query.includeArchived ? {} : { isActive: true }),
      ...(contains ? { OR: [{ name: contains }, { phone: contains }] } : {}),
    },
    select: SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 500,
  });
}

export async function createSupplier(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<SupplierRow> {
  await requirePermission(ctx, "purchases.manage", { operation: "supplier.create", entityType: "Supplier", meta });
  const data = SupplierInput.parse(input);
  try {
    return await getDb().$transaction(async (tx) => {
      const supplier = await tx.supplier.create({ data: { orgId: ctx.orgId, ...data }, select: SELECT });
      await record(tx, {
        ctx,
        meta,
        action: "purchasing.supplier.created",
        entityType: "Supplier",
        entityId: supplier.id,
        metadata: { name: supplier.name },
      });
      return supplier;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function updateSupplier(
  ctx: TenantContext,
  supplierId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<SupplierRow> {
  await requirePermission(ctx, "purchases.manage", { operation: "supplier.update", entityType: "Supplier", meta });
  const id = parseId(supplierId);
  const patch = SupplierPatch.parse(input);
  try {
    return await getDb().$transaction(async (tx) => {
      const current = await tx.supplier.findFirst({ where: { id, orgId: ctx.orgId }, select: SELECT });
      if (!current) throw notFound("Supplier");
      const supplier = await tx.supplier.update({ where: { id }, data: patch, select: SELECT });
      const changed = Object.keys(patch).filter(
        (key) => current[key as keyof SupplierRow] !== supplier[key as keyof SupplierRow],
      );
      if (changed.length > 0) {
        await record(tx, {
          ctx,
          meta,
          action: "purchasing.supplier.updated",
          entityType: "Supplier",
          entityId: id,
          metadata: { fields: changed },
        });
      }
      return supplier;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

async function setActive(
  ctx: TenantContext,
  supplierId: string,
  isActive: boolean,
  meta?: AuditRequestMeta,
): Promise<SupplierRow> {
  const operation = isActive ? "supplier.restore" : "supplier.archive";
  await requirePermission(ctx, "purchases.manage", { operation, entityType: "Supplier", meta });
  const id = parseId(supplierId);
  return getDb().$transaction(async (tx) => {
    const current = await tx.supplier.findFirst({ where: { id, orgId: ctx.orgId }, select: SELECT });
    if (!current) throw notFound("Supplier");
    if (current.isActive === isActive) return current;
    const supplier = await tx.supplier.update({ where: { id }, data: { isActive }, select: SELECT });
    await record(tx, {
      ctx,
      meta,
      action: isActive ? "purchasing.supplier.restored" : "purchasing.supplier.archived",
      entityType: "Supplier",
      entityId: id,
      metadata: { name: supplier.name },
    });
    return supplier;
  });
}

export function archiveSupplier(ctx: TenantContext, supplierId: string, meta?: AuditRequestMeta) {
  return setActive(ctx, supplierId, false, meta);
}

export function restoreSupplier(ctx: TenantContext, supplierId: string, meta?: AuditRequestMeta) {
  return setActive(ctx, supplierId, true, meta);
}
