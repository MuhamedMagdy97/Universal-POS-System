import "server-only";
import { hasPermission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { t, type Locale } from "@/lib/i18n";
import { sum, toMajorString, type CurrencyCode } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { branchesInScope, orgSettings, requireAccess, resolveBranchIds } from "./access";
import {
  formatMarginBp,
  formatRateBp,
  isProfitReport,
  marginBp,
  REPORT_COLUMNS,
  totalledKeys,
  type Column,
} from "./columns";
import { toCsv, trusted, type CsvCell } from "./csv";
import * as q from "./queries";
import { isReportName, ReportQuery, type ReportName } from "./schemas";
import type { ReportScope } from "./sql";
import { formatLocalDateTime, resolveRange, todayIn } from "./timezone";

/** JSON shows at most this many rows (§11.5); totals and CSV always cover every row. */
export const ROW_CAP = 500;

export type ReportRow = Record<string, unknown>;

export type ReportResult = {
  report: ReportName;
  currency: CurrencyCode;
  timezone: string;
  from: string;
  to: string;
  branchId: string | null;
  rows: ReportRow[];
  totals: Record<string, number>;
  truncated: boolean;
};

const RUNNERS: Record<ReportName, (scope: ReportScope) => Promise<ReportRow[]>> = {
  "sales-summary": q.salesSummary,
  payments: q.payments,
  products: q.products,
  categories: q.categories,
  cashiers: q.cashiers,
  shifts: q.shifts,
  "refunds-voids": q.refundsVoids,
  vat: q.vat,
  purchases: q.purchases,
  "profit-products": q.profitProducts,
  "profit-categories": q.profitCategories,
  "profit-days": q.profitDays,
};

function totalsOf(report: ReportName, rows: ReportRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const key of totalledKeys(report)) {
    totals[key] = sum(rows.map((row) => (typeof row[key] === "number" ? (row[key] as number) : 0)));
  }
  // Margin is a ratio: recomputed from the totals, never summed (P12 §5).
  if (isProfitReport(report)) {
    const margin = marginBp(totals.grossProfitMinor, totals.netRevenueMinor - totals.revenueNoCostMinor);
    if (margin !== null) totals.marginBp = margin;
  }
  return totals;
}

type FullReport = Omit<ReportResult, "truncated">;

async function runReport(ctx: TenantContext, name: string, rawQuery: unknown, meta?: AuditRequestMeta) {
  if (!isReportName(name)) throw notFound("Report");
  await requireAccess(ctx, "reports", `report.${name}`, meta, name);
  const query = ReportQuery.parse(rawQuery);
  const branchIds = await resolveBranchIds(ctx, query.branchId);
  const { zone, currency } = await orgSettings(ctx.orgId);
  const range = resolveRange(query, zone);
  const rows = await RUNNERS[name]({ orgId: ctx.orgId, branchIds, zone, ...range });
  const report: FullReport = {
    report: name,
    currency,
    timezone: zone,
    ...range,
    branchId: query.branchId ?? null,
    rows,
    totals: totalsOf(name, rows),
  };
  return { report, query };
}

/** One report as JSON (`reports.view`). Rows beyond `ROW_CAP` are cut and `truncated` is set. */
export async function getReport(
  ctx: TenantContext,
  name: string,
  rawQuery: unknown,
  meta?: AuditRequestMeta,
): Promise<ReportResult> {
  const { report } = await runReport(ctx, name, rawQuery, meta);
  return { ...report, rows: report.rows.slice(0, ROW_CAP), truncated: report.rows.length > ROW_CAP };
}

/** One report as CSV with every row and a total line. Audited as `reports.exported` (§11.6). */
export async function exportReportCsv(
  ctx: TenantContext,
  name: string,
  rawQuery: unknown,
  meta?: AuditRequestMeta,
): Promise<{ filename: string; body: string }> {
  const { report, query } = await runReport(ctx, name, rawQuery, meta);
  const locale: Locale = query.locale ?? "en";
  const columns = REPORT_COLUMNS[report.report];
  const cell = (column: Column, row: ReportRow) => csvValue(column, row, report, locale);
  const lines = report.rows.map((row) => columns.map((column) => cell(column, row)));
  const totalLine = columns.map((column, index) =>
    index === 0
      ? t(locale, "reports.total")
      : column.key in report.totals
        ? cell(column, { [column.key]: report.totals[column.key] })
        : null,
  );
  const body = toCsv(
    columns.map((column) => t(locale, column.label)),
    [...lines, totalLine],
  );
  await record(getDb(), {
    ctx,
    meta,
    action: "reports.exported",
    entityType: "Report",
    entityId: report.report,
    metadata: { from: report.from, to: report.to, branchId: report.branchId, rows: report.rows.length },
  });
  return { filename: `${report.report}_${report.from}_${report.to}.csv`, body };
}

/** Arabic name when the locale is Arabic and one exists; a category row without a category is "Uncategorized". */
export function localizedName(row: ReportRow, locale: Locale): string {
  if ("categoryId" in row && row.categoryId === null) return t(locale, "reports.uncategorized");
  const ar = row.nameAr;
  return locale === "ar" && typeof ar === "string" && ar !== "" ? ar : String(row.name ?? "");
}

/** A localized label for enum-like values, shared with the screen. */
export function enumLabel(column: Column, value: string, locale: Locale): string {
  switch (column.kind) {
    case "method":
      return t(
        locale,
        value === "CASH" ? "reports.method.cash" : value === "WALLET" ? "reports.method.wallet" : "reports.method.card",
      );
    case "status":
      return t(locale, value === "OPEN" ? "reports.status.open" : "reports.status.closed");
    case "kind":
      return t(locale, value === "VOID" ? "reports.kind.void" : "reports.kind.refund");
    default:
      return value;
  }
}

function csvValue(column: Column, row: ReportRow, report: FullReport, locale: Locale): CsvCell {
  const value = row[column.key];
  if (column.kind === "name") return localizedName(row, locale);
  if (value === null || value === undefined) return null;
  switch (column.kind) {
    case "money":
      return trusted(toMajorString(value as number, report.currency));
    case "int":
      return value as number;
    case "rate":
      return trusted(formatRateBp(value as number));
    case "margin":
      return trusted(formatMarginBp(value as number));
    case "datetime":
      return trusted(formatLocalDateTime(value as Date, report.timezone));
    case "day":
      return trusted(value as string);
    case "method":
    case "status":
    case "kind":
      return enumLabel(column, value as string, locale);
    default:
      return String(value);
  }
}

export type DashboardTiles = {
  currency: CurrencyCode;
  today: string;
  netSalesMinor: number;
  salesCount: number;
  refundsMinor: number;
  openShifts: number;
};

/**
 * Today's tiles (P11) over every branch in the caller's scope. null for roles without
 * `reports.view` (no audit row: the dashboard asks, the user did not).
 */
export async function getDashboardTiles(ctx: TenantContext): Promise<DashboardTiles | null> {
  if (!hasPermission(ctx.role, "reports.view")) return null;
  const branchIds = (await branchesInScope(ctx)).map((b) => b.id);
  if (branchIds.length === 0) return null;
  const { zone, currency } = await orgSettings(ctx.orgId);
  const today = todayIn(zone);
  const [rows, openShifts] = await Promise.all([
    q.salesSummary({ orgId: ctx.orgId, branchIds, zone, from: today, to: today }),
    q.openShiftCount(ctx.orgId, branchIds),
  ]);
  const day = rows[0];
  return {
    currency,
    today,
    netSalesMinor: day?.netAfterRefundsMinor ?? 0,
    salesCount: day?.salesCount ?? 0,
    refundsMinor: day?.refundsMinor ?? 0,
    openShifts,
  };
}
