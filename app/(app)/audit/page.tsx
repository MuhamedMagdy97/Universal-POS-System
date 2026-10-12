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
  DENIED_ACTIONS,
  formatLocalDateTime,
  listAuditActors,
  listAuditEvents,
  type AuditPage,
} from "@/modules/reports";
import { actionLabel, AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, auditQuery, metadataEntries } from "./_lib/audit";

/**
 * Audit trail (T9, P6–P7): the org's events newest first, 50 per page, with filters and CSV.
 * Owner and Admin (`users.manage`); the service re-checks and logs a refusal.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function AuditTrailPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <AuditContent searchParams={searchParams} />
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
    <section role="alert" className="flex flex-col gap-2 rounded-md border border-border p-6">
      <h1 className="text-xl font-semibold">{tr("audit.state.forbidden")}</h1>
      <p className="text-muted">{tr("audit.state.forbiddenBody")}</p>
    </section>
  );
}

const SELECT = "rounded-md border border-border bg-background px-3 py-2";

async function AuditContent({ searchParams }: { searchParams: SearchParams }) {
  const [params, locale, requestHeaders] = await Promise.all([searchParams, getLocale(), headers()]);
  const tr = translator(locale);

  let ctx: TenantContext;
  try {
    ctx = await requireTenant(requestHeaders);
  } catch (err) {
    if (err instanceof AppError && err.code === "UNAUTHENTICATED") redirect("/login?next=%2Faudit");
    if (err instanceof AppError && err.code === "FORBIDDEN") return <Denied locale={locale} />;
    throw err;
  }
  if (!hasPermission(ctx.role, "users.manage")) return <Denied locale={locale} />;

  const filters = {
    from: one(params.from),
    to: one(params.to),
    actor: one(params.actor),
    action: one(params.action),
    entityType: one(params.entityType),
  };
  const cursor = one(params.cursor);
  const actors = await listAuditActors(ctx);

  let page: AuditPage | null = null;
  let invalid = false;
  try {
    page = await listAuditEvents(ctx, auditQuery({ ...filters, cursor }));
  } catch (err) {
    if (
      (err instanceof AppError && err.code === "VALIDATION_FAILED") ||
      (err instanceof Error && err.name === "ZodError")
    ) {
      invalid = true;
    } else {
      throw err;
    }
  }

  const from = page?.from ?? filters.from;
  const to = page?.to ?? filters.to;
  const base = auditQuery({ ...filters, from, to });
  const csv = new URLSearchParams({ ...base, format: "csv", locale });
  const older = page?.nextCursor ? new URLSearchParams({ ...base, cursor: page.nextCursor }) : null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{tr("audit.title")}</h1>

      <form method="get" action="/audit" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span>{tr("reports.from")}</span>
          <input type="date" name="from" defaultValue={from ?? ""} dir="ltr" className={SELECT} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("reports.to")}</span>
          <input type="date" name="to" defaultValue={to ?? ""} dir="ltr" className={SELECT} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("audit.filter.actor")}</span>
          <select name="actor" defaultValue={filters.actor ?? ""} className={SELECT}>
            <option value="">{tr("audit.filter.anyone")}</option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("audit.filter.action")}</span>
          <select name="action" defaultValue={filters.action ?? ""} className={SELECT}>
            <option value="">{tr("audit.filter.anyAction")}</option>
            <option value={DENIED_ACTIONS}>{tr("audit.filter.denied")}</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {actionLabel(action, locale)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("audit.filter.entity")}</span>
          <select name="entityType" defaultValue={filters.entityType ?? ""} className={SELECT}>
            <option value="">{tr("audit.filter.anyEntity")}</option>
            {AUDIT_ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md border border-border px-4 py-2">
          {tr("reports.apply")}
        </button>
        {page ? (
          <a href={`/api/audit?${csv}`} download className="ms-auto rounded-md bg-foreground px-4 py-2 text-background">
            {tr("reports.export")}
          </a>
        ) : null}
      </form>

      {invalid ? (
        <p role="alert" className="text-red-700">
          {tr("reports.error.range")}
        </p>
      ) : null}
      {page && page.rows.length === 0 ? <p className="text-muted">{tr("audit.empty")}</p> : null}

      {page && page.rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-start">
                <th scope="col" className="px-2 py-2 text-start font-medium">
                  {tr("audit.col.time")}
                </th>
                <th scope="col" className="px-2 py-2 text-start font-medium">
                  {tr("audit.col.actor")}
                </th>
                <th scope="col" className="px-2 py-2 text-start font-medium">
                  {tr("audit.col.action")}
                </th>
                <th scope="col" className="px-2 py-2 text-start font-medium">
                  {tr("audit.col.entity")}
                </th>
                <th scope="col" className="px-2 py-2 text-start font-medium">
                  {tr("audit.col.details")}
                </th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => {
                const entries = metadataEntries(row.metadata);
                return (
                  <tr key={row.id} className="border-b border-border align-top">
                    <td dir="ltr" className="px-2 py-2 whitespace-nowrap">
                      {formatLocalDateTime(row.at, page.timezone)}
                    </td>
                    <td className="px-2 py-2">{row.actorName ?? "—"}</td>
                    <td className="px-2 py-2">
                      <span className={row.action.endsWith(".permission.denied") ? "text-red-700" : ""}>
                        {actionLabel(row.action, locale)}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      {row.entityType}
                      {row.entityId ? (
                        <span dir="ltr" className="block text-xs text-muted">
                          {row.entityId}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">
                      {entries.length > 0 ? (
                        <details>
                          <summary className="cursor-pointer">{tr("audit.details.show")}</summary>
                          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                            {entries.map(([key, value]) => (
                              <div key={key} className="contents">
                                <dt className="text-muted">{key}</dt>
                                <dd dir="ltr" className="break-all">
                                  {value}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex gap-3">
        {cursor ? (
          <Link href={`/audit?${new URLSearchParams(base)}`} className="rounded-md border border-border px-3 py-2">
            {tr("audit.page.newest")}
          </Link>
        ) : null}
        {older ? (
          <Link href={`/audit?${older}`} className="rounded-md border border-border px-3 py-2">
            {tr("audit.page.older")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
