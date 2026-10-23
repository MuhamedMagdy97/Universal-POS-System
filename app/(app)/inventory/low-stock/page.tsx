import { Suspense } from "react";
import Link from "next/link";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { LOW_STOCK_CAP, listLowStock } from "@/modules/inventory";
import { loadInventoryContext } from "../_lib/context";
import { BranchPicker } from "../_components/branch-picker";
import { NotAllowed, NotFound } from "../_components/states";
import { ManagedNotice } from "../../_components/managed-notice";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Low stock at one branch: tracked items at or below their reorder point (low-stock-spec L7, L8). */
export default function LowStockPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <LowStockContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

async function LowStockContent({ searchParams }: { searchParams: SearchParams }) {
  const requestedBranch = one((await searchParams).branch);
  const page = await loadInventoryContext(
    `/inventory/low-stock${requestedBranch ? `?branch=${requestedBranch}` : ""}`,
    requestedBranch,
  );
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { ctx, locale, managed, branches, branch } = page;
  const tr = translator(locale);
  let result;
  try {
    result = await listLowStock(ctx, { branchId: branch.id });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return <NotAllowed locale={locale} />;
    if (err instanceof AppError && err.code === "NOT_FOUND") return <NotFound locale={locale} branches={branches} />;
    throw err;
  }
  const csvHref = `/api/inventory/low-stock?${new URLSearchParams({ branchId: branch.id, format: "csv", locale })}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/inventory?branch=${branch.id}`} className="underline">
          {tr("inventory.title")}
        </Link>
        <h1 className="text-2xl font-semibold">{tr("inventory.lowStock.title")}</h1>
        {result.rows.length > 0 ? (
          <a href={csvHref} download className="btn btn-primary ms-auto">
            {tr("inventory.lowStock.export")}
          </a>
        ) : null}
      </div>

      {managed ? <ManagedNotice locale={locale} area="stock" /> : null}
      <BranchPicker locale={locale} action="/inventory/low-stock" branches={branches} currentId={branch.id} />

      {result.rows.length === 0 ? (
        <p className="card text-muted">{tr("inventory.lowStock.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="py-2">{tr("inventory.column.item")}</th>
                <th>{tr("inventory.column.sku")}</th>
                <th>{tr("inventory.column.onHand")}</th>
                <th>{tr("inventory.column.reorderPoint")}</th>
                <th>{tr("inventory.column.shortfall")}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => {
                const name = locale === "ar" && row.nameAr ? row.nameAr : row.name;
                const label = row.variantName ? `${name} — ${row.variantName}` : name;
                const historyHref = `/inventory/items/${row.productId}?branch=${branch.id}${row.variantId ? `&variant=${row.variantId}` : ""}`;
                return (
                  <tr key={`${row.productId}|${row.variantId ?? ""}`}>
                    <td>
                      <Link href={historyHref} className="underline-offset-4 hover:underline">
                        {label}
                      </Link>
                      {row.archived ? <span className="badge ms-2">{tr("inventory.badge.archived")}</span> : null}
                    </td>
                    <td dir="ltr">{row.sku}</td>
                    <td dir="ltr" className={row.qty < 0 ? "text-danger" : ""}>
                      {row.qty}
                    </td>
                    <td dir="ltr">{row.reorderPoint}</td>
                    <td dir="ltr" className="font-semibold">
                      {row.reorderPoint - row.qty}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {result.truncated ? (
        <p className="text-sm text-muted">{tr("inventory.lowStock.truncated", { count: LOW_STOCK_CAP })}</p>
      ) : null}
    </div>
  );
}
