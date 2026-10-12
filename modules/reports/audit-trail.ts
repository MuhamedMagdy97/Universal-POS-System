import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { Prisma } from "@/lib/generated/prisma/client";
import { t, type Locale } from "@/lib/i18n";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { orgSettings, requireAccess } from "./access";
import { toCsv, trusted } from "./csv";
import { AuditQuery, decodeAuditCursor, DENIED_ACTIONS, encodeAuditCursor } from "./schemas";
import { col, inRange } from "./sql";
import { formatLocalDateTime, resolveRange } from "./timezone";

/**
 * Audit trail (P6, P7): the org's events newest first, 50 per page, for `users.manage` only.
 * Read-only; events with no org (pre-tenant auth events) are never listed.
 */

export const AUDIT_PAGE_SIZE = 50;
/** CSV export bound (reports-audit-data-model-and-api.md §8). */
export const AUDIT_EXPORT_MAX = 50_000;

export type AuditRow = {
  id: string;
  at: Date;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  branchId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
};

export type AuditPage = { rows: AuditRow[]; nextCursor: string | null; timezone: string; from: string; to: string };

async function prepare(ctx: TenantContext, rawQuery: unknown, meta?: AuditRequestMeta) {
  await requireAccess(ctx, "audit", "audit.list", meta);
  const query = AuditQuery.parse(rawQuery);
  const { zone } = await orgSettings(ctx.orgId);
  const range = resolveRange(query, zone);
  const cursor = query.cursor === undefined ? null : decodeAuditCursor(query.cursor);
  if (query.cursor !== undefined && cursor === null) {
    throw new AppError("VALIDATION_FAILED", "Invalid cursor", { reason: "INVALID_CURSOR" });
  }
  const scope = { orgId: ctx.orgId, branchIds: [], zone, ...range };
  const filters: Prisma.Sql[] = [Prisma.sql`a."orgId" = ${ctx.orgId}::uuid`, inRange(col("a", "createdAt"), scope)];
  if (query.actor) filters.push(Prisma.sql`a."actorUserId" = ${query.actor}::uuid`);
  if (query.action === DENIED_ACTIONS) filters.push(Prisma.sql`a."action" LIKE '%.permission.denied'`);
  else if (query.action) filters.push(Prisma.sql`a."action" = ${query.action}`);
  if (query.entityType) filters.push(Prisma.sql`a."entityType" = ${query.entityType}`);
  if (query.entityId) filters.push(Prisma.sql`a."entityId" = ${query.entityId}`);
  if (cursor) {
    filters.push(
      Prisma.sql`(a."createdAt", a."id") < ((${cursor.at}::timestamptz AT TIME ZONE 'UTC'), ${cursor.id}::uuid)`,
    );
  }
  return { query, zone, range, where: Prisma.join(filters, " AND ") };
}

async function select(where: Prisma.Sql, limit: number): Promise<AuditRow[]> {
  return getDb().$queryRaw<AuditRow[]>`
    SELECT a."id", a."createdAt" AS at, a."actorUserId", u."name" AS "actorName", a."action", a."entityType",
           a."entityId", a."branchId", a."requestId", a."metadata"
    FROM "AuditEvent" a LEFT JOIN "User" u ON u."id" = a."actorUserId"
    WHERE ${where}
    ORDER BY a."createdAt" DESC, a."id" DESC
    LIMIT ${limit}`;
}

/** One page of the audit trail. `nextCursor` is null on the last page. */
export async function listAuditEvents(
  ctx: TenantContext,
  rawQuery: unknown,
  meta?: AuditRequestMeta,
): Promise<AuditPage> {
  const { zone, range, where } = await prepare(ctx, rawQuery, meta);
  const rows = await select(where, AUDIT_PAGE_SIZE + 1);
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page.at(-1);
  const nextCursor =
    rows.length > AUDIT_PAGE_SIZE && last ? encodeAuditCursor({ at: last.at.toISOString(), id: last.id }) : null;
  return { rows: page, nextCursor, timezone: zone, ...range };
}

/** Every matching event (up to 50 000) as CSV. Audited as `audit.exported`. */
export async function exportAuditCsv(
  ctx: TenantContext,
  rawQuery: unknown,
  meta?: AuditRequestMeta,
): Promise<{ filename: string; body: string }> {
  const { query, zone, range, where } = await prepare(ctx, rawQuery, meta);
  const rows = await select(where, AUDIT_EXPORT_MAX);
  const locale: Locale = query.locale ?? "en";
  const header = [
    t(locale, "audit.col.time"),
    t(locale, "audit.col.actor"),
    t(locale, "audit.col.action"),
    t(locale, "audit.col.entity"),
    t(locale, "audit.col.entityId"),
    t(locale, "audit.col.details"),
  ];
  const body = toCsv(
    header,
    rows.map((row) => [
      trusted(formatLocalDateTime(row.at, zone)),
      row.actorName,
      row.action,
      row.entityType,
      row.entityId,
      JSON.stringify(row.metadata),
    ]),
  );
  const { cursor: _cursor, format: _format, locale: _locale, ...filters } = query;
  await record(getDb(), {
    ctx,
    meta,
    action: "audit.exported",
    entityType: "AuditEvent",
    metadata: { ...filters, ...range, rows: rows.length },
  });
  return { filename: `audit_${range.from}_${range.to}.csv`, body };
}

/** The org's members by name, for the actor filter. */
export async function listAuditActors(ctx: TenantContext): Promise<{ id: string; name: string }[]> {
  await requireAccess(ctx, "audit", "audit.actors");
  const members = await getDb().membership.findMany({
    where: { orgId: ctx.orgId },
    select: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return members.map((m) => m.user);
}
