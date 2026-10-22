import { Suspense } from "react";
import Link from "next/link";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { listStock } from "@/modules/inventory";
import { isLowStock } from "@/modules/inventory/schemas";
import { loadInventoryContext, type InventoryPageContext } from "./_lib/context";
import { BranchPicker } from "./_components/branch-picker";
import { StockRowActions } from "./_components/stock-row-actions";
import { NotAllowed, NotFound } from "./_components/states";
import { ManagedNotice } from "../_components/managed-notice";

/** Back-office list: 25 item rows per page. */
const PAGE_SIZE = 25;
const FILTERS = ["all", "inStock", "zero", "negative", "unopened"] as const;
type Filter = (typeof FILTERS)[number];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function InventoryPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <InventoryContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

async function InventoryContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requestedBranch = one(params.branch);
  const q = one(params.q)?.trim().slice(0, 100);
  const rawFilter = one(params.filter);
  const filter: Filter = FILTERS.includes(rawFilter as Filter) ? (rawFilter as Filter) : "all";
  const cursor = one(params.cursor);

  const query = new URLSearchParams();
  if (requestedBranch) query.set("branch", requestedBranch);
  if (q) query.set("q", q);
  if (filter !== "all") query.set("filter", filter);
  const listPath = `/inventory${query.size ? `?${query}` : ""}`;

  const page: InventoryPageContext = await loadInventoryContext(listPath, requestedBranch);
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { ctx, locale, can, managed, branches, branch } = page;
  const tr = translator(locale);
  let result;
  try {
    result = await listStock(ctx, { branchId: branch.id, q, filter, cursor, limit: PAGE_SIZE });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return <NotAllowed locale={locale} />;
    if (err instanceof AppError && err.code === "NOT_FOUND") return <NotFound locale={locale} branches={branches} />;
    throw err;
  }

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const branchParam = `branch=${branch.id}`;
  const nextQuery = new URLSearchParams(query);
  if (result.nextCursor) nextQuery.set("cursor", result.nextCursor);
  const nextHref = result.nextCursor ? `/inventory?${nextQuery}` : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("inventory.title")}</h1>
        <div className="ms-auto flex flex-wrap gap-2">
          <Link href={`/inventory/low-stock?${branchParam}`} className="rounded-md border border-border px-3 py-2">
            {tr("inventory.action.lowStock")}
          </Link>
          <Link href={`/inventory/transfers?${branchParam}`} className="rounded-md border border-border px-3 py-2">
            {tr("inventory.action.transfers")}
          </Link>
          <Link href={`/inventory/counts?${branchParam}`} className="rounded-md border border-border px-3 py-2">
            {tr("inventory.action.counts")}
          </Link>
          {can.adjust ? (
            <Link href={`/inventory/opening?${branchParam}`} className="rounded-md border border-border px-3 py-2">
              {tr("inventory.action.opening")}
            </Link>
          ) : null}
          {can.adjust ? (
            <Link href={`/inventory/import?${branchParam}`} className="rounded-md border border-border px-3 py-2">
              {tr("inventory.action.import")}
            </Link>
          ) : null}
          {can.transfer ? (
            <Link
              href={`/inventory/transfer?${branchParam}`}
              className="rounded-md bg-foreground px-3 py-2 text-background"
            >
              {tr("inventory.action.newTransfer")}
            </Link>
          ) : null}
        </div>
      </div>
      {managed ? <ManagedNotice locale={locale} area="stock" /> : null}

      <BranchPicker locale={locale} action="/inventory" branches={branches} currentId={branch.id} />

      <form method="get" action="/inventory" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="branch" value={branch.id} />
        <input
          name="q"
          defaultValue={q ?? ""}
          aria-label={tr("inventory.search.label")}
          placeholder={tr("inventory.search.placeholder")}
          dir="ltr"
          className="min-w-64 flex-1 rounded-md border border-border bg-background px-3 py-2"
        />
        <button type="submit" className="rounded-md border border-border px-4 py-2">
          {tr("inventory.search.submit")}
        </button>
      </form>

      <nav aria-label={tr("inventory.title")} className="flex flex-wrap gap-2">
        {FILTERS.map((value) => {
          const chip = new URLSearchParams();
          chip.set("branch", branch.id);
          if (q) chip.set("q", q);
          if (value !== "all") chip.set("filter", value);
          const active = value === filter;
          return (
            <Link
              key={value}
              href={`/inventory?${chip}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-3 py-1 text-sm ${active ? "bg-foreground text-background" : "border border-border"}`}
            >
              {tr(`inventory.filter.${value}` as const)}
            </Link>
          );
        })}
      </nav>

      {result.rows.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-md border border-border p-6">
          <p className="text-lg font-medium">
            {q || filter !== "all" ? tr("inventory.state.noResults") : tr("inventory.state.empty.title")}
          </p>
          {q || filter !== "all" ? null : <p className="text-muted">{tr("inventory.state.empty.body")}</p>}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="py-2">{tr("inventory.column.item")}</th>
                <th>{tr("inventory.column.sku")}</th>
                <th>{tr("inventory.column.onHand")}</th>
                <th>{tr("inventory.column.incoming")}</th>
                <th>{tr("inventory.column.reorderPoint")}</th>
                <th>{tr("inventory.column.updated")}</th>
                <th>{tr("inventory.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => {
                const label = row.variantName ? `${row.name} — ${row.variantName}` : row.name;
                const historyHref = `/inventory/items/${row.productId}?${branchParam}${row.variantId ? `&variant=${row.variantId}` : ""}`;
                return (
                  <tr key={`${row.productId}|${row.variantId ?? ""}`} className="border-b border-border align-top">
                    <td className="py-2">
                      {label}
                      {row.archived ? (
                        <span className="ms-2 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                          {tr("inventory.badge.archived")}
                        </span>
                      ) : null}
                    </td>
                    <td dir="ltr">{row.sku}</td>
                    <td dir="ltr" className={row.qty < 0 ? "text-red-700" : ""}>
                      {row.qty}
                      {row.qty < 0 ? (
                        <span className="ms-2 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">
                          {tr("inventory.badge.oversold")}
                        </span>
                      ) : null}
                    </td>
                    <td dir="ltr" data-testid="incoming">
                      {row.incoming || "—"}
                    </td>
                    <td dir="ltr">
                      {row.reorderPoint ?? "—"}
                      {isLowStock(row.qty, row.reorderPoint) ? (
                        <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                          {tr("inventory.badge.low")}
                        </span>
                      ) : null}
                    </td>
                    <td>{row.updatedAt ? dateFormat.format(row.updatedAt) : "—"}</td>
                    <td>
                      <StockRowActions
                        locale={locale}
                        branchId={branch.id}
                        itemRef={{ productId: row.productId, variantId: row.variantId }}
                        itemLabel={label}
                        onHand={row.qty}
                        reorderPoint={row.reorderPoint}
                        archived={row.archived}
                        canAdjust={can.adjust}
                        canTransfer={can.transfer}
                        historyHref={historyHref}
                        transferHref={`/inventory/transfer?${branchParam}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextHref ? (
        <Link href={nextHref} className="self-start rounded-md border border-border px-4 py-2">
          {tr("inventory.state.loadMore")}
        </Link>
      ) : null}
    </div>
  );
}
