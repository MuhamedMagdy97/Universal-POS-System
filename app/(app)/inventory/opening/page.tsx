import { Suspense } from "react";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { listStock } from "@/modules/inventory";
import { loadInventoryContext } from "../_lib/context";
import { NotAllowed, NotFound } from "../_components/states";
import { OpeningGrid, type OpeningRow } from "../_components/opening-grid";

/** Opening-stock grid: items with no movements at this branch yet, one page of 100. */
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
  const page = await loadInventoryContext(
    `/inventory/opening${requestedBranch ? `?branch=${requestedBranch}` : ""}`,
    requestedBranch,
  );
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { ctx, locale, can, branch, branches } = page;
  const tr = translator(locale);
  if (!can.adjust) return <NotAllowed locale={locale} />;

  let result;
  try {
    result = await listStock(ctx, { branchId: branch.id, filter: "unopened", limit: GRID_SIZE });
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
  }));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">
        {tr("inventory.opening.title")} — {branch.name}
      </h1>
      <OpeningGrid locale={locale} branchId={branch.id} rows={rows} truncated={result.nextCursor !== null} />
    </div>
  );
}
