import { Suspense } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppError } from "@/lib/errors";
import { hasPermission } from "@/lib/auth/permissions";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { translator, type Locale } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";
import {
  branchesInScope,
  canRunReport,
  getReport,
  isProfitReport,
  QUICK_RANGES,
  quickRange,
  REPORT_COLUMNS,
  REPORT_NAMES,
  reportSettings,
  type ReportResult,
} from "@/modules/reports";
import { PrintZReportButton } from "../_components/zreport-print";
import { cellText, csvHref, isDiscrepancy, isNumeric, reportHref, toQuickRange, toReportName } from "./_lib/format";

/**
 * Reports (T9, profit P12): canned reports for a branch (or all of the user's branches) and a date
 * range, driven by the URL so every view is a link. `reports.view` only; the service re-checks
 * permission and branch scope.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReportsContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function Denied({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="card flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{tr("reports.state.forbidden")}</h1>
      <p className="text-muted">{tr("reports.state.forbiddenBody")}</p>
    </section>
  );
}

const ZONE_LABEL = { "Africa/Cairo": "reports.zone.cairo", "Asia/Riyadh": "reports.zone.riyadh" } as const;

async function ReportsContent({ searchParams }: { searchParams: SearchParams }) {
  const [params, locale, requestHeaders] = await Promise.all([searchParams, getLocale(), headers()]);
  const tr = translator(locale);

  let ctx: TenantContext;
  try {
    ctx = await requireTenant(requestHeaders);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") redirect("/login?next=%2Freports");
    if (err instanceof AppError && err.code === "FORBIDDEN") return <Denied locale={locale} />;
    throw err;
  }
  if (!hasPermission(ctx.role, "reports.view")) return <Denied locale={locale} />;

  const asked = toReportName(one(params.report));
  // A report the role cannot run (purchases without purchases.manage) falls back to the default.
  const report = canRunReport(ctx, asked) ? asked : toReportName(undefined);
  const names = REPORT_NAMES.filter((name) => canRunReport(ctx, name));
  const branch = one(params.branch);
  const [branches, settings] = await Promise.all([branchesInScope(ctx), reportSettings(ctx.orgId)]);
  const quick = toQuickRange(one(params.range));
  const requested = quick ? quickRange(quick, settings.zone) : { from: one(params.from), to: one(params.to) };

  let result: ReportResult | null = null;
  let error: "range" | "branch" | null = null;
  try {
    result = await getReport(ctx, report, { branchId: branch, from: requested.from, to: requested.to });
  } catch (err) {
    if (err instanceof AppError && err.code === "VALIDATION_FAILED") error = "range";
    else if (err instanceof AppError && err.code === "NOT_FOUND") error = "branch";
    else if (err instanceof Error && err.name === "ZodError") error = "branch";
    else throw err;
  }

  const from = result?.from ?? requested.from;
  const to = result?.to ?? requested.to;
  const columns = REPORT_COLUMNS[report];
  // A closed shift row prints its Z-report (T10 H9).
  const zPrint = report === "shifts";
  const format = { locale, currency: settings.currency, zone: settings.zone };
  const zoneKey = ZONE_LABEL[settings.zone as keyof typeof ZONE_LABEL];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{tr("reports.title")}</h1>
        {zoneKey ? <span className="text-sm text-muted">{tr(zoneKey)}</span> : null}
      </div>

      <nav aria-label={tr("reports.picker")} className="flex flex-wrap gap-2">
        {names.map((name) => (
          <Link
            key={name}
            href={reportHref({ report: name, branch, from, to })}
            aria-current={name === report ? "page" : undefined}
            className={`btn btn-sm ${name === report ? "btn-primary" : ""}`}
          >
            {tr(`reports.tab.${name}`)}
          </Link>
        ))}
      </nav>

      <form method="get" action="/reports" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="report" value={report} />
        {branches.length > 1 ? (
          <label className="field">
            <span>{tr("reports.branch")}</span>
            <select name="branch" defaultValue={branch ?? ""} className="input">
              <option value="">{tr("reports.branch.all")}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>{tr("reports.from")}</span>
          <input type="date" name="from" defaultValue={from ?? ""} dir="ltr" className="input" />
        </label>
        <label className="field">
          <span>{tr("reports.to")}</span>
          <input type="date" name="to" defaultValue={to ?? ""} dir="ltr" className="input" />
        </label>
        <button type="submit" className="btn">
          {tr("reports.apply")}
        </button>
        {result ? (
          <a
            href={csvHref({ report, branch, from: result.from, to: result.to, locale })}
            className="btn btn-primary ms-auto"
            download
          >
            {tr("reports.export")}
          </a>
        ) : null}
      </form>

      <nav aria-label={tr("reports.quick.label")} className="flex flex-wrap gap-3 text-sm">
        {QUICK_RANGES.map((name) => {
          const query = new URLSearchParams({ report, range: name });
          if (branch) query.set("branch", branch);
          return (
            <Link key={name} href={`/reports?${query}`} className="underline-offset-4 hover:underline">
              {tr(`reports.quick.${name}`)}
            </Link>
          );
        })}
      </nav>

      {error ? (
        <p role="alert" className="notice notice-error">
          {tr(error === "range" ? "reports.error.range" : "reports.error.branch")}
        </p>
      ) : null}

      {result && isProfitReport(report) && (result.totals.revenueNoCostMinor ?? 0) !== 0 ? (
        <p role="note" className="text-sm text-warning">
          {tr("reports.profit.missingCost")}
        </p>
      ) : null}

      {result && result.rows.length === 0 ? <p className="text-muted">{tr("reports.empty")}</p> : null}

      {result && result.rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{tr(`reports.tab.${report}`)}</caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={`px-2 py-2 font-medium whitespace-nowrap ${isNumeric(column) ? "text-end" : "text-start"}`}
                  >
                    {tr(column.label)}
                  </th>
                ))}
                {zPrint ? <th scope="col" className="print:hidden" /> : null}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      dir={isNumeric(column) || column.kind === "datetime" || column.kind === "day" ? "ltr" : undefined}
                      className={`px-2 py-2 whitespace-nowrap ${isNumeric(column) ? "text-end tabular-nums" : ""} ${
                        isDiscrepancy(column, row) ? "font-semibold text-warning" : ""
                      }`}
                    >
                      {cellText(column, row, format)}
                    </td>
                  ))}
                  {zPrint ? (
                    <td className="px-2 py-2 print:hidden">
                      {row.status === "CLOSED" && typeof row.shiftId === "string" ? (
                        <PrintZReportButton
                          locale={locale}
                          shiftId={row.shiftId}
                          className="btn btn-sm whitespace-nowrap"
                        />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="sticky bottom-0 bg-background font-semibold">
                {columns.map((column, index) => (
                  <td
                    key={column.key}
                    dir={isNumeric(column) ? "ltr" : undefined}
                    className={`px-2 py-2 whitespace-nowrap ${isNumeric(column) ? "text-end tabular-nums" : ""}`}
                  >
                    {index === 0
                      ? tr("reports.total")
                      : column.key in result.totals
                        ? cellText(column, result.totals, format)
                        : ""}
                  </td>
                ))}
                {zPrint ? <td className="print:hidden" /> : null}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      {result?.truncated ? <p className="text-sm text-muted">{tr("reports.truncated")}</p> : null}
    </div>
  );
}
