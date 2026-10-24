/**
 * reports — Canned MVP reports and the audit trail (T9). Read-only over sales, refunds,
 * shifts and audit events; writes only denial and export audit rows.
 *
 * Seam rule: modules talk through exported functions only; no cross-module
 * table writes. See docs/architecture/system-architecture.md.
 */
export {
  getReport,
  exportReportCsv,
  getDashboardTiles,
  type DashboardTiles,
  getTopItemsToday,
  type TopItem,
  enumLabel,
  localizedName,
  ROW_CAP,
  type ReportResult,
  type ReportRow,
} from "./service";
export { REPORT_COLUMNS, formatRateBp, formatMarginBp, isProfitReport, type Column, type ColumnKind } from "./columns";
export {
  REPORT_NAMES,
  isReportName,
  ReportQuery,
  AuditQuery,
  DENIED_ACTIONS,
  encodeAuditCursor,
  decodeAuditCursor,
  type ReportName,
} from "./schemas";
export { canRunReport, branchesInScope, orgSettings as reportSettings, type ReportBranch } from "./access";
export { csvResponse, toCsv } from "./csv";
export { QUICK_RANGES, quickRange, todayIn, formatLocalDateTime, type QuickRange, type LocalRange } from "./timezone";
export {
  listAuditEvents,
  exportAuditCsv,
  listAuditActors,
  AUDIT_PAGE_SIZE,
  type AuditRow,
  type AuditPage,
} from "./audit-trail";
export { averageTicketMinor } from "./average";
