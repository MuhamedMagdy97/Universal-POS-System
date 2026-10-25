import type { Locale } from "@/lib/i18n";
import { formatMinor, type CurrencyCode } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
import {
  enumLabel,
  formatLocalDateTime,
  formatMarginBp,
  formatRateBp,
  localizedName,
  QUICK_RANGES,
  REPORT_NAMES,
  type Column,
  type QuickRange,
  type ReportName,
  type ReportRow,
} from "@/modules/reports";

/** Screen formatting for report cells (reports-audit-ux-and-tests.md §1). */

export type CellFormat = { locale: Locale; currency: CurrencyCode; zone: string };

/** Numbers, amounts and dates render LTR inside RTL and align to the end. */
export function isNumeric(column: Column): boolean {
  return (
    column.kind === "money" ||
    column.kind === "int" ||
    column.kind === "qty" ||
    column.kind === "rate" ||
    column.kind === "margin"
  );
}

export function cellText(column: Column, row: ReportRow, format: CellFormat): string {
  if (column.kind === "name") return localizedName(row, format.locale);
  const value = row[column.key];
  if (value === null || value === undefined || value === "") return "—";
  switch (column.kind) {
    case "money":
      return formatMinor(value as number, format.currency, format.locale);
    case "int":
      return new Intl.NumberFormat(format.locale, { numberingSystem: "latn" }).format(value as number);
    case "qty":
      if (row.unitType === "MIXED") return "—";
      return row.unitType === "KG"
        ? formatQty(value as number, "KG", format.locale)
        : new Intl.NumberFormat(format.locale, { numberingSystem: "latn" }).format(value as number);
    case "rate":
      return formatRateBp(value as number);
    case "margin":
      return formatMarginBp(value as number);
    case "datetime":
      return formatLocalDateTime(value instanceof Date ? value : new Date(String(value)), format.zone);
    case "method":
    case "status":
    case "kind":
      return enumLabel(column, String(value), format.locale);
    default:
      return String(value);
  }
}

/** A shift row whose count differed from the expected cash. */
export function isDiscrepancy(column: Column, row: ReportRow): boolean {
  return column.key === "discrepancyMinor" && typeof row.discrepancyMinor === "number" && row.discrepancyMinor !== 0;
}

export function toReportName(value: string | undefined): ReportName {
  return (REPORT_NAMES as readonly string[]).includes(value ?? "") ? (value as ReportName) : "sales-summary";
}

export function toQuickRange(value: string | undefined): QuickRange | null {
  return (QUICK_RANGES as readonly string[]).includes(value ?? "") ? (value as QuickRange) : null;
}

/** The page URL for a report view; empty values are left out. */
export function reportHref(params: { report: ReportName; branch?: string; from?: string; to?: string }): string {
  const query = new URLSearchParams({ report: params.report });
  if (params.branch) query.set("branch", params.branch);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  return `/reports?${query}`;
}

/** The CSV download for the same view. */
export function csvHref(params: {
  report: ReportName;
  branch?: string;
  from: string;
  to: string;
  locale: Locale;
}): string {
  const query = new URLSearchParams({ from: params.from, to: params.to, format: "csv", locale: params.locale });
  if (params.branch) query.set("branchId", params.branch);
  return `/api/reports/${params.report}?${query}`;
}
