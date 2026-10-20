import "server-only";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { AppError, forbidden, notFound } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { CurrencyCode } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { branchesInScope } from "@/modules/reports";
import { normalizePhone, phoneSearchDigits, type PhoneCountry } from "./phone";
import { CustomerInput, CustomerPatch, CustomerQuery, Uuid } from "./schemas";

/**
 * Customer records (docs/planning/customers/customers-spec.md): phone unique per org in E.164,
 * archived rather than deleted, every write audited. History reads sales in the caller's branch scope.
 */

export type CustomerRow = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  taxNumber: string | null;
  note: string | null;
  isActive: boolean;
};

const SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  taxNumber: true,
  note: true,
  isActive: true,
} as const;

async function requirePermission(
  ctx: TenantContext,
  permission: Permission,
  operation: string,
  meta?: AuditRequestMeta,
): Promise<void> {
  if (hasPermission(ctx.role, permission)) return;
  try {
    await record(getDb(), {
      ctx,
      meta,
      action: "customers.permission.denied",
      entityType: "Customer",
      metadata: { permission, operation },
    });
  } catch {
    // A failed audit write must not turn a 403 into a 500.
  }
  throw forbidden("Missing permission for this action");
}

function parseId(id: string): string {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound("Customer");
  return parsed.data;
}

async function countryOf(client: Db | Prisma.TransactionClient, orgId: string): Promise<PhoneCountry> {
  const org = await client.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true } });
  return org.countryCode as PhoneCountry;
}

function e164(raw: string, country: PhoneCountry): string {
  const phone = normalizePhone(raw, country);
  if (!phone) throw new AppError("VALIDATION_FAILED", "Enter a valid phone number", { reason: "INVALID_PHONE" });
  return phone;
}

/** 409 PHONE_TAKEN with the existing customer's id, so the till can pick them instead (CU3). */
async function phoneTaken(orgId: string, phone: string): Promise<AppError> {
  const existing = await getDb().customer.findUnique({
    where: { orgId_phone: { orgId, phone } },
    select: { id: true },
  });
  return new AppError("CONFLICT", "A customer with this phone already exists", {
    reason: "PHONE_TAKEN",
    customerId: existing?.id ?? null,
  });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** Search by name or phone digits (CU12, CU13). Archived customers only when asked for. */
export async function listCustomers(ctx: TenantContext, rawQuery: unknown = {}): Promise<CustomerRow[]> {
  await requirePermission(ctx, "customers.read", "customer.list");
  const query = CustomerQuery.parse(rawQuery);
  const digits = query.q ? phoneSearchDigits(query.q) : null;
  const match = query.q
    ? {
        OR: [
          { name: { contains: query.q, mode: "insensitive" as const } },
          ...(digits ? [{ phone: { contains: digits } }] : []),
        ],
      }
    : {};
  // ponytail: no paging; the list caps at 200 rows, search narrows it. Add a cursor when shops outgrow it.
  return getDb().customer.findMany({
    where: { orgId: ctx.orgId, ...(query.includeArchived ? {} : { isActive: true }), ...match },
    select: SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: query.limit ?? 200,
  });
}

export async function createCustomer(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<CustomerRow> {
  await requirePermission(ctx, "customers.create", "customer.create", meta);
  const data = CustomerInput.parse(input);
  const db = getDb();
  const phone = e164(data.phone, await countryOf(db, ctx.orgId));
  try {
    return await db.$transaction(async (tx) => {
      const customer = await tx.customer.create({ data: { orgId: ctx.orgId, ...data, phone }, select: SELECT });
      await record(tx, {
        ctx,
        meta,
        action: "customer.created",
        entityType: "Customer",
        entityId: customer.id,
        metadata: { name: customer.name },
      });
      return customer;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw await phoneTaken(ctx.orgId, phone);
    throw err;
  }
}

/** Edits fields and/or archives (`isActive: false`) or restores (CU4, CU5). Audits field names, never values. */
export async function updateCustomer(
  ctx: TenantContext,
  customerId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<CustomerRow> {
  await requirePermission(ctx, "customers.manage", "customer.update", meta);
  const id = parseId(customerId);
  const { isActive, ...patch } = CustomerPatch.parse(input);
  const db = getDb();
  const phone = patch.phone === undefined ? undefined : e164(patch.phone, await countryOf(db, ctx.orgId));
  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.customer.findFirst({ where: { id, orgId: ctx.orgId }, select: SELECT });
      if (!current) throw notFound("Customer");
      const customer = await tx.customer.update({
        where: { id },
        data: { ...patch, ...(phone ? { phone } : {}), ...(isActive === undefined ? {} : { isActive }) },
        select: SELECT,
      });
      const changed = Object.keys(patch).filter(
        (key) => current[key as keyof CustomerRow] !== customer[key as keyof CustomerRow],
      );
      if (changed.length > 0) {
        await record(tx, {
          ctx,
          meta,
          action: "customer.updated",
          entityType: "Customer",
          entityId: id,
          metadata: { fields: changed },
        });
      }
      if (current.isActive !== customer.isActive) {
        await record(tx, {
          ctx,
          meta,
          action: customer.isActive ? "customer.restored" : "customer.archived",
          entityType: "Customer",
          entityId: id,
          metadata: { name: customer.name },
        });
      }
      return customer;
    });
  } catch (err) {
    if (isUniqueViolation(err) && phone) throw await phoneTaken(ctx.orgId, phone);
    throw err;
  }
}

export type CustomerSnapshot = { id: string; name: string; phone: string; taxNumber: string | null };

/**
 * The customer to put on a sale (CU7): needs `customers.read`, same org (else 404), active (else 409).
 * Read before anything is held in the inventory system (CU17).
 */
export async function customerForSale(
  ctx: TenantContext,
  customerId: string,
  meta?: AuditRequestMeta,
): Promise<CustomerSnapshot> {
  await requirePermission(ctx, "customers.read", "sale.customer", meta);
  const customer = await getDb().customer.findFirst({
    where: { id: parseId(customerId), orgId: ctx.orgId },
    select: { id: true, name: true, phone: true, taxNumber: true, isActive: true },
  });
  if (!customer) throw notFound("Customer");
  if (!customer.isActive) {
    throw new AppError("CONFLICT", "This customer is archived", { reason: "CUSTOMER_INACTIVE" });
  }
  return { id: customer.id, name: customer.name, phone: customer.phone, taxNumber: customer.taxNumber };
}

export type CustomerTotals = {
  salesCount: number;
  salesMinor: number;
  refundsCount: number;
  refundsMinor: number;
  netMinor: number;
};

export type CustomerDetail = CustomerRow & {
  currency: CurrencyCode;
  totals: CustomerTotals;
  sales: {
    id: string;
    number: string;
    createdAt: string;
    branchName: string;
    totalMinor: number;
    status: "COMPLETED" | "VOIDED";
  }[];
  refunds: { id: string; saleId: string; saleNumber: string; createdAt: string; totalMinor: number }[];
};

/** How many sales and refunds the detail lists; totals always cover every one (CU14). */
export const HISTORY_LIMIT = 100;

/** A customer with totals and their latest sales and refunds in the caller's branch scope (CU14). */
export async function getCustomer(ctx: TenantContext, customerId: string): Promise<CustomerDetail> {
  await requirePermission(ctx, "customers.read", "customer.read");
  const id = parseId(customerId);
  const db = getDb();
  const customer = await db.customer.findFirst({ where: { id, orgId: ctx.orgId }, select: SELECT });
  if (!customer) throw notFound("Customer");
  const branchIds = (await branchesInScope(ctx)).map((branch) => branch.id);
  const saleWhere = { orgId: ctx.orgId, customerId: id, branchId: { in: branchIds } };
  const refundWhere = { orgId: ctx.orgId, sale: saleWhere };

  const [org, completed, refunded, sales, refunds] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { currency: true } }),
    db.sale.aggregate({ where: { ...saleWhere, status: "COMPLETED" }, _count: true, _sum: { totalMinor: true } }),
    db.refund.aggregate({ where: refundWhere, _count: true, _sum: { totalMinor: true } }),
    db.sale.findMany({
      where: saleWhere,
      select: {
        id: true,
        number: true,
        createdAt: true,
        totalMinor: true,
        status: true,
        branch: { select: { name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: HISTORY_LIMIT,
    }),
    db.refund.findMany({
      where: refundWhere,
      select: { id: true, saleId: true, createdAt: true, totalMinor: true, sale: { select: { number: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: HISTORY_LIMIT,
    }),
  ]);
  const salesMinor = completed._sum.totalMinor ?? 0;
  const refundsMinor = refunded._sum.totalMinor ?? 0;
  return {
    ...customer,
    currency: org.currency,
    totals: {
      salesCount: completed._count,
      salesMinor,
      refundsCount: refunded._count,
      refundsMinor,
      netMinor: salesMinor - refundsMinor,
    },
    sales: sales.map((sale) => ({
      id: sale.id,
      number: sale.number,
      createdAt: sale.createdAt.toISOString(),
      branchName: sale.branch.name,
      totalMinor: sale.totalMinor,
      status: sale.status,
    })),
    refunds: refunds.map((refund) => ({
      id: refund.id,
      saleId: refund.saleId,
      saleNumber: refund.sale.number,
      createdAt: refund.createdAt.toISOString(),
      totalMinor: refund.totalMinor,
    })),
  };
}
