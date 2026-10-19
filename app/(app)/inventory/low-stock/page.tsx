import { Suspense } from "react";
import Link from "next/link";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { LOW_STOCK_CAP, listLowStock } from "@/modules/inventory";
import { loadInventoryContext } from "../_lib/context";
import { BranchPicker } from "../_components/branch-picker";
import { NotAllowed, NotFound } from "../_components/states";

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

  const { ctx, locale, branches, branch } = page;
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
          <a href={csvHref} download className="ms-auto rounded-md bg-foreground px-4 py-2 text-background">
            {tr("inventory.lowStock.export")}
          </a>
        ) : null}
      </div>

      <BranchPicker locale={locale} action="/inventory/low-stock" branches={branches} currentId={branch.id} />

      {result.rows.length === 0 ? (
        <p className="rounded-md border border-border p-6 text-muted">{tr("inventory.lowStock.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start">
            <thead>
              <tr className="border-b border-border text-muted">
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
                  <tr key={`${row.productId}|${row.variantId ?? ""}`} className="border-b border-border">
                    <td className="py-2">
                      <Link href={historyHref} className="underline-offset-4 hover:underline">
                        {label}
                      </Link>
                      {row.archived ? (
                        <span className="ms-2 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-700">
                          {tr("inventory.badge.archived")}
                        </span>
                      ) : null}
                    </td>
                    <td dir="ltr">{row.sku}</td>
                    <td dir="ltr" className={row.qty < 0 ? "text-red-700" : ""}>
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
