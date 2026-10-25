import "server-only";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { prismaTenantRepository, type TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { AppError, forbidden, notFound } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { customerForSale } from "@/modules/customers";
import { parseLocalDate, zoneFor } from "@/modules/reports/timezone";
import { minutesInDay, zonedInstant } from "./slots";

/**
 * Appointments (docs/planning/ui-refresh/salon-spec.md S5-S7). Staff with `sales.create` book, move and change them;
 * cancelling and no-shows are audited. One staff member's BOOKED and ARRIVED appointments never overlap (409
 * SLOT_TAKEN, checked under a per-staff lock); "any" is not checked. Every change bumps `version` (409
 * APPOINTMENT_CHANGED on a stale one). Checking out is a sale (`createSale` with `appointmentId`), which marks it DONE.
 */

type Tx = Prisma.TransactionClient;

const Uuid = z.uuid();
const Day = z.string().refine((value) => parseLocalDate(value) !== null, "A day as YYYY-MM-DD");
const Minute = z
  .int()
  .min(0)
  .max(24 * 60 - 1);
const Text = z.string().trim().min(1).max(200);

export const BookInput = z.strictObject({
  branchId: Uuid,
  day: Day,
  startMin: Minute,
  staffMemberId: Uuid.nullable().optional(),
  customerId: Uuid.optional(),
  customerName: z.string().trim().min(1).max(80).optional(),
  customerPhone: z.string().trim().min(5).max(30).optional(),
  serviceIds: z.array(Uuid).min(1).max(10),
  note: Text.optional(),
});

export const UpdateInput = z.strictObject({
  version: z.int().min(1),
  day: Day.optional(),
  startMin: Minute.optional(),
  staffMemberId: Uuid.nullable().optional(),
  serviceIds: z.array(Uuid).min(1).max(10).optional(),
  note: Text.nullable().optional(),
});

export const StatusInput = z.strictObject({
  version: z.int().min(1),
  status: z.enum(["BOOKED", "ARRIVED", "CANCELLED", "NO_SHOW"]),
});

export type AppointmentStatus = "BOOKED" | "ARRIVED" | "DONE" | "CANCELLED" | "NO_SHOW";

export type AppointmentView = {
  id: string;
  branchId: string;
  staff: { id: string; name: string; nameAr: string | null } | null;
  customer: { id: string | null; name: string; phone: string };
  startsAt: string;
  endsAt: string;
  /** Minutes after local midnight in the shop's time zone, for the calendar. */
  startMin: number;
  endMin: number;
  status: AppointmentStatus;
  note: string | null;
  version: number;
  saleId: string | null;
  services: { productId: string; name: string; nameAr: string | null; durationMin: number; priceMinor: number }[];
};

export type AppointmentDay = { day: string; opensAt: number; closesAt: number; appointments: AppointmentView[] };

const INCLUDE = {
  staffMember: { select: { id: true, name: true, nameAr: true } },
  customer: { select: { id: true, name: true, phone: true } },
  services: {
    orderBy: { sortOrder: "asc" as const },
    select: { product: { select: { id: true, name: true, nameAr: true, durationMin: true, priceMinor: true } } },
  },
};

type Row = Prisma.AppointmentGetPayload<{ include: typeof INCLUDE }>;

function conflict(reason: "SLOT_TAKEN" | "APPOINTMENT_CHANGED" | "APPOINTMENT_CLOSED", message: string): AppError {
  return new AppError("CONFLICT", message, { reason });
}

function invalid(reason: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason });
}

async function requirePermission(ctx: TenantContext, operation: string, meta?: AuditRequestMeta): Promise<void> {
  if (hasPermission(ctx.role, "sales.create")) return;
  try {
    await record(getDb(), {
      ctx,
      meta,
      action: "sales.permission.denied",
      entityType: "Appointment",
      metadata: { permission: "sales.create", operation },
    });
  } catch {
    // A failed audit write must not turn a 403 into a 500.
  }
  throw forbidden("Missing permission for this action");
}

async function requireBranch(ctx: TenantContext, branchId: string): Promise<void> {
  const repo = prismaTenantRepository(getDb());
  const membership = await repo.findMembership(ctx.orgId, ctx.userId);
  if (!membership?.isActive || !(await repo.canAccessBranch(ctx.orgId, membership, branchId))) {
    throw notFound("Branch");
  }
}

async function zoneOf(client: Db | Tx, orgId: string): Promise<string> {
  const org = await client.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true } });
  return zoneFor(org.countryCode);
}

function viewOf(row: Row, zone: string): AppointmentView {
  return {
    id: row.id,
    branchId: row.branchId,
    staff: row.staffMember,
    customer: row.customer
      ? { id: row.customer.id, name: row.customer.name, phone: row.customer.phone }
      : { id: null, name: row.customerName ?? "", phone: row.customerPhone ?? "" },
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    startMin: minutesInDay(row.startsAt, zone),
    endMin: minutesInDay(row.endsAt, zone),
    status: row.status,
    note: row.note,
    version: row.version,
    saleId: row.saleId,
    services: row.services.map(({ product }) => ({
      productId: product.id,
      name: product.name,
      nameAr: product.nameAr,
      durationMin: product.durationMin ?? 30,
      priceMinor: product.priceMinor,
    })),
  };
}

/** The booked services: active services of the shop, in the order given; their durations add up to the length. */
async function servicesOf(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<{ id: string; durationMin: number }[]> {
  const rows = await tx.product.findMany({
    where: { orgId, id: { in: [...ids] }, isActive: true },
    select: { id: true, isService: true, durationMin: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw notFound("Product");
    if (!row.isService) throw invalid("NOT_A_SERVICE", "Only services can be booked");
    return { id, durationMin: row.durationMin ?? 30 };
  });
}

async function requireStaff(tx: Tx, orgId: string, branchId: string, staffMemberId: string): Promise<void> {
  const found = await tx.staffMember.findFirst({
    where: { id: staffMemberId, orgId, isActive: true, branches: { some: { branchId } } },
    select: { id: true },
  });
  if (!found) throw invalid("STAFF_INVALID", "Choose someone who works in this branch");
}

/** Under a per-staff lock, refuses a slot that overlaps another of their open appointments. */
async function requireFree(
  tx: Tx,
  orgId: string,
  staffMemberId: string,
  startsAt: Date,
  endsAt: Date,
  except: string | null,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`appointment:${staffMemberId}`}))`;
  const clash = await tx.appointment.findFirst({
    where: {
      orgId,
      staffMemberId,
      status: { in: ["BOOKED", "ARRIVED"] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(except && { id: { not: except } }),
    },
    select: { id: true },
  });
  if (clash) throw conflict("SLOT_TAKEN", "That time is taken for this staff member");
}

async function loadRow(client: Db | Tx, ctx: TenantContext, id: string): Promise<Row> {
  if (!Uuid.safeParse(id).success) throw notFound("Appointment");
  const row = await client.appointment.findFirst({ where: { id, orgId: ctx.orgId }, include: INCLUDE });
  if (!row) throw notFound("Appointment");
  await requireBranch(ctx, row.branchId);
  return row;
}

async function lockFresh(tx: Tx, ctx: TenantContext, id: string, version: number): Promise<Row> {
  if (!Uuid.safeParse(id).success) throw notFound("Appointment");
  await tx.$queryRaw`SELECT 1 FROM "Appointment" WHERE "id" = ${id}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
  const row = await loadRow(tx, ctx, id);
  if (row.version !== version) throw conflict("APPOINTMENT_CHANGED", "This appointment was changed meanwhile");
  return row;
}

export async function bookAppointment(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<AppointmentView> {
  await requirePermission(ctx, "appointment.book", meta);
  const data = BookInput.parse(input);
  await requireBranch(ctx, data.branchId);
  const customer = data.customerId ? await customerForSale(ctx, data.customerId, meta) : null;
  if (!customer && (!data.customerName || !data.customerPhone)) {
    throw invalid("CUSTOMER_REQUIRED", "Choose the customer, or type their name and phone");
  }
  const db = getDb();
  return db.$transaction(async (tx) => {
    const zone = await zoneOf(tx, ctx.orgId);
    const services = await servicesOf(tx, ctx.orgId, data.serviceIds);
    const startsAt = zonedInstant(data.day, data.startMin, zone);
    const endsAt = new Date(startsAt.getTime() + services.reduce((total, s) => total + s.durationMin, 0) * 60_000);
    if (data.staffMemberId) {
      await requireStaff(tx, ctx.orgId, data.branchId, data.staffMemberId);
      await requireFree(tx, ctx.orgId, data.staffMemberId, startsAt, endsAt, null);
    }
    const created = await tx.appointment.create({
      data: {
        orgId: ctx.orgId,
        branchId: data.branchId,
        staffMemberId: data.staffMemberId ?? null,
        customerId: customer?.id ?? null,
        customerName: customer ? null : (data.customerName ?? null),
        customerPhone: customer ? null : (data.customerPhone ?? null),
        startsAt,
        endsAt,
        note: data.note ?? null,
        createdById: ctx.userId,
      },
      select: { id: true },
    });
    await tx.appointmentService.createMany({
      data: services.map((service, index) => ({
        orgId: ctx.orgId,
        appointmentId: created.id,
        productId: service.id,
        sortOrder: index,
      })),
    });
    const row = await tx.appointment.findUniqueOrThrow({ where: { id: created.id }, include: INCLUDE });
    await record(tx, {
      ctx,
      meta,
      action: "appointment.booked",
      entityType: "Appointment",
      entityId: row.id,
      metadata: { startsAt: row.startsAt.toISOString(), staffMemberId: row.staffMemberId },
    });
    return viewOf(row, zone);
  });
}

/** Moves an open appointment, or changes its staff member, services or note. */
export async function updateAppointment(
  ctx: TenantContext,
  id: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<AppointmentView> {
  await requirePermission(ctx, "appointment.update", meta);
  const data = UpdateInput.parse(input);
  const db = getDb();
  return db.$transaction(async (tx) => {
    const row = await lockFresh(tx, ctx, id, data.version);
    if (row.status !== "BOOKED" && row.status !== "ARRIVED") {
      throw conflict("APPOINTMENT_CLOSED", "This appointment is done or cancelled");
    }
    const zone = await zoneOf(tx, ctx.orgId);
    const serviceIds = data.serviceIds ?? row.services.map(({ product }) => product.id);
    const services = await servicesOf(tx, ctx.orgId, serviceIds);
    const day = data.day ?? new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(row.startsAt);
    const startsAt = zonedInstant(day, data.startMin ?? minutesInDay(row.startsAt, zone), zone);
    const endsAt = new Date(startsAt.getTime() + services.reduce((total, s) => total + s.durationMin, 0) * 60_000);
    const staffMemberId = data.staffMemberId === undefined ? row.staffMemberId : data.staffMemberId;
    if (staffMemberId) {
      if (staffMemberId !== row.staffMemberId) await requireStaff(tx, ctx.orgId, row.branchId, staffMemberId);
      await requireFree(tx, ctx.orgId, staffMemberId, startsAt, endsAt, row.id);
    }
    await tx.appointmentService.deleteMany({ where: { orgId: ctx.orgId, appointmentId: row.id } });
    await tx.appointmentService.createMany({
      data: services.map((service, index) => ({
        orgId: ctx.orgId,
        appointmentId: row.id,
        productId: service.id,
        sortOrder: index,
      })),
    });
    await tx.appointment.update({
      where: { id: row.id },
      data: {
        startsAt,
        endsAt,
        staffMemberId,
        ...(data.note !== undefined && { note: data.note }),
        version: { increment: 1 },
      },
    });
    return viewOf(await tx.appointment.findUniqueOrThrow({ where: { id: row.id }, include: INCLUDE }), zone);
  });
}

/** Arrived, cancelled, no-show, or back to booked. DONE comes only from checking out. */
export async function setAppointmentStatus(
  ctx: TenantContext,
  id: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<AppointmentView> {
  await requirePermission(ctx, "appointment.status", meta);
  const data = StatusInput.parse(input);
  const db = getDb();
  return db.$transaction(async (tx) => {
    const row = await lockFresh(tx, ctx, id, data.version);
    if (row.status === "DONE") throw conflict("APPOINTMENT_CLOSED", "This appointment is already checked out");
    const zone = await zoneOf(tx, ctx.orgId);
    if (data.status === "BOOKED" || data.status === "ARRIVED") {
      if (row.staffMemberId && (row.status === "CANCELLED" || row.status === "NO_SHOW")) {
        await requireFree(tx, ctx.orgId, row.staffMemberId, row.startsAt, row.endsAt, row.id);
      }
    }
    const updated = await tx.appointment.update({
      where: { id: row.id },
      data: { status: data.status, version: { increment: 1 } },
      include: INCLUDE,
    });
    if (data.status === "CANCELLED" || data.status === "NO_SHOW") {
      await record(tx, {
        ctx,
        meta,
        action: data.status === "CANCELLED" ? "appointment.cancelled" : "appointment.no_show",
        entityType: "Appointment",
        entityId: row.id,
        metadata: { startsAt: row.startsAt.toISOString(), staffMemberId: row.staffMemberId },
      });
    }
    return viewOf(updated, zone);
  });
}

export async function getAppointment(ctx: TenantContext, id: string): Promise<AppointmentView> {
  await requirePermission(ctx, "appointment.read");
  const db = getDb();
  return viewOf(await loadRow(db, ctx, id), await zoneOf(db, ctx.orgId));
}

/** One branch's day in the shop's time zone, with its opening hours. */
export async function listDay(ctx: TenantContext, branchId: string, rawDay: string): Promise<AppointmentDay> {
  await requirePermission(ctx, "appointment.list");
  if (!Uuid.safeParse(branchId).success) throw notFound("Branch");
  await requireBranch(ctx, branchId);
  const day = parseLocalDate(rawDay);
  if (!day) throw invalid("DAY_INVALID", "A day as YYYY-MM-DD");
  const db = getDb();
  const org = await db.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { countryCode: true, opensAt: true, closesAt: true },
  });
  const zone = zoneFor(org.countryCode);
  const from = zonedInstant(day, 0, zone);
  const to = new Date(from.getTime() + 36 * 3_600_000);
  const rows = await db.appointment.findMany({
    where: { orgId: ctx.orgId, branchId, startsAt: { gte: from, lt: to } },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    include: INCLUDE,
  });
  const views = rows
    .filter((row) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(row.startsAt) === day)
    .map((row) => viewOf(row, zone));
  return { day, opensAt: org.opensAt, closesAt: org.closesAt, appointments: views };
}

/**
 * For `createSale` (S7): locks the appointment, which must be BOOKED or ARRIVED in the sale's branch (else 409
 * APPOINTMENT_CLOSED); the caller marks it DONE with `closeAppointment` in the same transaction.
 */
export async function appointmentForSale(
  tx: Tx,
  ctx: TenantContext,
  appointmentId: string,
  branchId: string,
): Promise<{ id: string }> {
  if (!Uuid.safeParse(appointmentId).success) throw notFound("Appointment");
  await tx.$queryRaw`SELECT 1 FROM "Appointment" WHERE "id" = ${appointmentId}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
  const row = await tx.appointment.findFirst({
    where: { id: appointmentId, orgId: ctx.orgId },
    select: { id: true, branchId: true, status: true },
  });
  if (!row || row.branchId !== branchId) throw notFound("Appointment");
  if (row.status !== "BOOKED" && row.status !== "ARRIVED") {
    throw conflict("APPOINTMENT_CLOSED", "This appointment is already checked out or cancelled");
  }
  return { id: row.id };
}

export async function closeAppointment(tx: Tx, appointmentId: string, saleId: string): Promise<void> {
  await tx.appointment.update({
    where: { id: appointmentId },
    data: { status: "DONE", saleId, version: { increment: 1 } },
  });
}
