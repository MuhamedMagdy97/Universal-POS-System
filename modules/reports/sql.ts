import "server-only";
import { Prisma } from "@/lib/generated/prisma/client";

/**
 * Shared SQL for reports. Prisma `DateTime` columns are `timestamp` without time zone holding UTC,
 * so the local day needs two `AT TIME ZONE` steps (reports-audit-data-model-and-api.md §2). The
 * range test converts the bounds, not the column, so the `createdAt` indexes still apply.
 */

export type ReportScope = {
  orgId: string;
  branchIds: string[];
  zone: string;
  from: string;
  to: string;
};

/** A quoted column reference such as `s."createdAt"`. Only ever called with literals from this module. */
export function col(alias: string, column: string): Prisma.Sql {
  return Prisma.raw(`${alias}."${column}"`);
}

/** The shop's local calendar day of a UTC timestamp column, as `YYYY-MM-DD` text. */
export function localDay(column: Prisma.Sql, zone: string): Prisma.Sql {
  return Prisma.sql`to_char(((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${zone}::text)::date, 'YYYY-MM-DD')`;
}

/** `column` falls inside the local days `from` … `to`, both inclusive. */
export function inRange(column: Prisma.Sql, scope: ReportScope): Prisma.Sql {
  return Prisma.sql`${column} >= ((${scope.from}::date)::timestamp AT TIME ZONE ${scope.zone}::text) AT TIME ZONE 'UTC'
    AND ${column} < ((${scope.to}::date + 1)::timestamp AT TIME ZONE ${scope.zone}::text) AT TIME ZONE 'UTC'`;
}

/** Org and branch filter for a table alias with `orgId` and `branchId` columns. */
export function inScope(alias: string, scope: ReportScope): Prisma.Sql {
  return Prisma.sql`${col(alias, "orgId")} = ${scope.orgId}::uuid AND ${col(alias, "branchId")} = ANY(${scope.branchIds}::uuid[])`;
}

/** SUM and COUNT come back as bigint (or null for no rows). Money stays exact up to 2^53. */
export function num(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Report total overflowed the safe integer range");
  return n;
}

/** The UTC instant of local midnight starting `localDate` (+ `days`), for comparing to a timestamp column. */
export function localMidnight(localDate: string, zone: string, days = 0): Prisma.Sql {
  return Prisma.sql`(((${localDate}::date + ${days}::int)::timestamp AT TIME ZONE ${zone}::text) AT TIME ZONE 'UTC')`;
}
