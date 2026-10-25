import { Suspense } from "react";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { listStock } from "@/modules/inventory";
import { loadInventoryContext } from "../_lib/context";
import { NotAllowed, NotFound } from "../_components/states";
import { OpeningGrid, type OpeningRow } from "../_components/opening-grid";

/** Opening-stock grid: items with no movements at this branch, one page of 100, searchable by name, SKU or barcode. */
const GRID_SIZE = 100;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function OpeningPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <OpeningContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

async function OpeningContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requestedBranch = one(params.branch);
  const q = one(params.q)?.trim().slice(0, 100);
  const query = new URLSearchParams();
  if (requestedBranch) query.set("branch", requestedBranch);
  if (q) query.set("q", q);
  const page = await loadInventoryContext(`/inventory/opening${query.size ? `?${query}` : ""}`, requestedBranch);
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { ctx, locale, can, branch, branches } = page;
  const tr = translator(locale);
  if (!can.adjust) return <NotAllowed locale={locale} />;

  let result;
  try {
    result = await listStock(ctx, { branchId: branch.id, q, filter: "unopened", limit: GRID_SIZE });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return <NotAllowed locale={locale} />;
    if (err instanceof AppError && err.code === "NOT_FOUND") return <NotFound locale={locale} branches={branches} />;
    throw err;
  }

  const rows: OpeningRow[] = result.rows.map((row) => ({
    ref: { productId: row.productId, variantId: row.variantId },
    name: row.name,
    variantName: row.variantName,
    sku: row.sku,
    unitType: row.unitType,
  }));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">
        {tr("inventory.opening.title")} — {branch.name}
      </h1>
      <form method="get" action="/inventory/opening" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="branch" value={branch.id} />
        <input
          name="q"
          defaultValue={q ?? ""}
          aria-label={tr("inventory.search.label")}
          placeholder={tr("inventory.search.placeholder")}
          dir="ltr"
          className="input min-w-64 flex-1"
        />
        <button type="submit" className="btn">
          {tr("inventory.search.submit")}
        </button>
      </form>
      <OpeningGrid locale={locale} branchId={branch.id} rows={rows} truncated={result.nextCursor !== null} />
    </div>
  );
}
