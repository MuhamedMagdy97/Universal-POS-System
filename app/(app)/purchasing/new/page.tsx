import { Suspense } from "react";
import Link from "next/link";
import { translator } from "@/lib/i18n";
import { branchesInScope } from "@/modules/purchasing";
import { activeSuppliers, loadPurchasingContext } from "../_lib/context";
import { Denied } from "../_components/states";
import { PoEditor } from "../_components/po-editor";

/** New purchase order (purchases.manage): a draft with supplier, branch and lines. */
export default function NewPurchaseOrderPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <NewContent />
    </Suspense>
  );
}

async function NewContent() {
  const page = await loadPurchasingContext("/purchasing/new");
  if (page.kind === "denied" || !page.can.manage) return <Denied locale={page.locale} />;
  const { ctx, locale, currency } = page;
  const tr = translator(locale);
  const [branches, suppliers] = await Promise.all([branchesInScope(ctx), activeSuppliers(ctx.orgId)]);
  return (
    <div className="flex flex-col gap-4">
      <Link href="/purchasing" className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.title")}
      </Link>
      <h1 className="text-2xl font-semibold">{tr("purchasing.new")}</h1>
      <PoEditor locale={locale} currency={currency} suppliers={suppliers} branches={branches} />
    </div>
  );
}
