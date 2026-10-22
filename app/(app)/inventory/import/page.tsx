import { Suspense } from "react";
import { translator } from "@/lib/i18n";
import { loadInventoryContext } from "../_lib/context";
import { BranchPicker } from "../_components/branch-picker";
import { NotAllowed, NotFound } from "../_components/states";
import { StockImport } from "../_components/stock-import";
import { ManagedNotice } from "../../_components/managed-notice";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Stock CSV import (docs/planning/stock-import/stock-import-spec.md): opening stock or adjustments for one branch. */
export default function StockImportPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ImportContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ImportContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const raw = Array.isArray(params.branch) ? params.branch[0] : params.branch;
  const requestedBranch = raw?.trim() ? raw : undefined;
  const page = await loadInventoryContext(
    `/inventory/import${requestedBranch ? `?branch=${encodeURIComponent(requestedBranch)}` : ""}`,
    requestedBranch,
  );
  if (page.kind === "denied") return <NotAllowed locale={page.locale} />;
  if (page.kind === "notFound") return <NotFound locale={page.locale} branches={page.branches} />;

  const { locale, can, managed, branch, branches } = page;
  const tr = translator(locale);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">
        {tr("inventory.import.title")} — {branch.name}
      </h1>
      {managed ? (
        <ManagedNotice locale={locale} area="stock" />
      ) : can.adjust ? (
        <>
          <BranchPicker locale={locale} action="/inventory/import" branches={branches} currentId={branch.id} />
          <StockImport key={branch.id} locale={locale} branchId={branch.id} />
        </>
      ) : (
        <NotAllowed locale={locale} />
      )}
    </div>
  );
}
