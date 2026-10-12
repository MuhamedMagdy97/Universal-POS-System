import { Suspense } from "react";
import Link from "next/link";
import { translator } from "@/lib/i18n";
import { listSuppliers } from "@/modules/purchasing";
import { loadPurchasingContext } from "../_lib/context";
import { Denied } from "../_components/states";
import { SuppliersManager } from "../_components/suppliers-manager";

/** Suppliers (purchases.manage): add, edit, archive and restore. `?archived=1` lists archived ones too. */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function SuppliersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <SuppliersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function SuppliersContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const showArchived = params.archived === "1";
  const page = await loadPurchasingContext("/purchasing/suppliers");
  if (page.kind === "denied" || !page.can.manage) return <Denied locale={page.locale} />;
  const { ctx, locale } = page;
  const tr = translator(locale);
  const suppliers = await listSuppliers(ctx, showArchived ? { includeArchived: "true" } : {});
  return (
    <div className="flex flex-col gap-4">
      <Link href="/purchasing" className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.title")}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{tr("purchasing.suppliers")}</h1>
        <Link
          href={showArchived ? "/purchasing/suppliers" : "/purchasing/suppliers?archived=1"}
          className="ms-auto text-sm underline-offset-4 hover:underline"
        >
          {showArchived ? tr("purchasing.supplier.active") : tr("purchasing.supplier.showArchived")}
        </Link>
      </div>
      <SuppliersManager locale={locale} suppliers={suppliers} />
    </div>
  );
}
