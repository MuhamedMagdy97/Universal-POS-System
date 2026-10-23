import { Suspense } from "react";
import Link from "next/link";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { formatMinor } from "@/lib/money";
import {
  branchesInScope,
  listDirectReceipts,
  listPurchaseOrders,
  PO_STATUS_FILTERS,
  type PoPage,
  type PoStatusFilter,
} from "@/modules/purchasing";
import { activeSuppliers, loadPurchasingContext, shopDateTime } from "./_lib/context";
import { Denied, StatusBadge } from "./_components/states";
import { ManagedNotice } from "../_components/managed-notice";

/**
 * Purchase orders (T5): open orders by default, filtered by status, branch, supplier and number,
 * newest first. Driven by the URL so every view is a link. UI gating only: the service re-checks.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function PurchasingPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <PurchasingContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

async function PurchasingContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const raw = one(params.status);
  const status: PoStatusFilter = (PO_STATUS_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as PoStatusFilter)
    : "open";
  const branch = one(params.branch);
  const supplier = one(params.supplier);
  const q = one(params.q)?.slice(0, 40);
  const cursor = one(params.cursor);

  const query = new URLSearchParams();
  if (status !== "open") query.set("status", status);
  if (branch) query.set("branch", branch);
  if (supplier) query.set("supplier", supplier);
  if (q) query.set("q", q);

  const page = await loadPurchasingContext(`/purchasing${query.size ? `?${query}` : ""}`);
  if (page.kind === "denied") return <Denied locale={page.locale} />;
  const { ctx, locale, can, managed, zone } = page;
  const tr = translator(locale);

  const [branches, suppliers, direct] = await Promise.all([
    branchesInScope(ctx),
    activeSuppliers(ctx.orgId),
    listDirectReceipts(ctx),
  ]);
  let result: PoPage | null = null;
  try {
    result = await listPurchaseOrders(ctx, { status, branchId: branch, supplierId: supplier, q, cursor });
  } catch (err) {
    if (!(err instanceof AppError) || (err.code !== "NOT_FOUND" && err.code !== "VALIDATION_FAILED")) throw err;
  }

  const nextHref = result?.nextCursor
    ? `/purchasing?${new URLSearchParams([...query, ["cursor", result.nextCursor]])}`
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("purchasing.title")}</h1>
        <span className="ms-auto flex gap-2">
          {can.manage ? (
            <Link href="/purchasing/suppliers" className="btn">
              {tr("purchasing.suppliers")}
            </Link>
          ) : null}
          {can.receive ? (
            <Link href="/purchasing/receive" className="btn">
              {tr("purchasing.direct.new")}
            </Link>
          ) : null}
          {can.manage ? (
            <Link href="/purchasing/new" className="btn btn-primary">
              {tr("purchasing.new")}
            </Link>
          ) : null}
        </span>
      </div>
      {managed ? <ManagedNotice locale={locale} area="stock" /> : null}
      {one(params.received) ? <p role="status">{tr("purchasing.direct.done")}</p> : null}

      <form method="get" action="/purchasing" className="flex flex-wrap items-end gap-3">
        <label className="field">
          <span>{tr("purchasing.filter.status")}</span>
          <select name="status" defaultValue={status} className="input">
            {PO_STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {tr(`purchasing.status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {branches.length > 1 ? (
          <label className="field">
            <span>{tr("purchasing.filter.branch")}</span>
            <select name="branch" defaultValue={branch ?? ""} className="input">
              <option value="">{tr("purchasing.filter.allBranches")}</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>{tr("purchasing.filter.supplier")}</span>
          <select name="supplier" defaultValue={supplier ?? ""} className="input">
            <option value="">{tr("purchasing.filter.allSuppliers")}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{tr("purchasing.filter.search")}</span>
          <input name="q" defaultValue={q ?? ""} dir="ltr" className="input w-40" />
        </label>
        <button type="submit" className="btn">
          {tr("purchasing.filter.submit")}
        </button>
      </form>

      {!result || result.rows.length === 0 ? (
        <p className="text-muted">{tr("purchasing.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr className="text-sm text-muted">
                <th>{tr("purchasing.col.number")}</th>
                <th className="text-start">{tr("purchasing.col.supplier")}</th>
                {branches.length > 1 ? <th className="text-start">{tr("purchasing.col.branch")}</th> : null}
                <th className="text-start">{tr("purchasing.col.status")}</th>
                <th className="text-end">{tr("purchasing.col.units")}</th>
                <th className="text-end">{tr("purchasing.col.total")}</th>
                <th className="text-end">{tr("purchasing.col.date")}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/purchasing/${row.id}`} dir="ltr" className="underline-offset-4 hover:underline">
                      {row.number}
                    </Link>
                  </td>
                  <td>{row.supplier.name}</td>
                  {branches.length > 1 ? <td>{row.branch.name}</td> : null}
                  <td>
                    <StatusBadge locale={locale} status={row.status} />
                  </td>
                  <td className="text-end" dir="ltr">
                    {row.totals.orderedUnits} / {row.totals.receivedUnits}
                  </td>
                  <td className="text-end">{formatMinor(row.totals.totalMinor, result.currency, locale)}</td>
                  <td className="text-end text-sm text-muted" dir="ltr">
                    {shopDateTime(row.orderedAt ?? row.createdAt, zone)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextHref ? (
        <Link href={nextHref} className="self-start underline-offset-4 hover:underline">
          {tr("purchasing.next")}
        </Link>
      ) : null}

      <section aria-labelledby="direct-receipts" className="flex flex-col gap-2">
        <h2 id="direct-receipts" className="text-lg font-semibold">
          {tr("purchasing.direct.list")}
        </h2>
        {direct.rows.length === 0 ? (
          <p className="text-muted">{tr("purchasing.direct.none")}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr className="text-sm text-muted">
                  <th>{tr("purchasing.col.number")}</th>
                  <th className="text-start">{tr("purchasing.col.supplier")}</th>
                  {branches.length > 1 ? <th className="text-start">{tr("purchasing.col.branch")}</th> : null}
                  <th className="text-end">{tr("purchasing.direct.units")}</th>
                  <th className="text-end">{tr("purchasing.direct.value")}</th>
                  <th className="text-end">{tr("purchasing.col.date")}</th>
                </tr>
              </thead>
              <tbody>
                {direct.rows.map((row) => (
                  <tr key={row.id}>
                    <td dir="ltr">
                      <Link href={`/purchasing/receipts/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number}
                      </Link>
                    </td>
                    <td>{row.supplier.name}</td>
                    {branches.length > 1 ? <td>{row.branch.name}</td> : null}
                    <td className="text-end" dir="ltr">
                      {row.units}
                    </td>
                    <td className="text-end">{formatMinor(row.valueMinor, direct.currency, locale)}</td>
                    <td className="text-end text-sm text-muted" dir="ltr">
                      {shopDateTime(row.receivedAt, zone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
