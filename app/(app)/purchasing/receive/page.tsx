import { Suspense } from "react";
import Link from "next/link";
import { translator } from "@/lib/i18n";
import { branchesInScope } from "@/modules/purchasing";
import { activeSuppliers, loadPurchasingContext } from "../_lib/context";
import { Denied } from "../_components/states";
import { PoEditor } from "../_components/po-editor";

/** Receive stock without a PO (purchases.receive, direct-receipt-spec): supplier, branch and lines, received at once. */
export default function DirectReceiptPage() {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <DirectReceiptContent />
    </Suspense>
  );
}

async function DirectReceiptContent() {
  const page = await loadPurchasingContext("/purchasing/receive");
  if (page.kind === "denied" || !page.can.receive) return <Denied locale={page.locale} />;
  const { ctx, locale, currency } = page;
  const tr = translator(locale);
  const [branches, suppliers] = await Promise.all([branchesInScope(ctx), activeSuppliers(ctx.orgId)]);
  return (
    <div className="flex flex-col gap-4">
      <Link href="/purchasing" className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.title")}
      </Link>
      <h1 className="text-2xl font-semibold">{tr("purchasing.direct.title")}</h1>
      <p className="text-muted">{tr("purchasing.direct.intro")}</p>
      <PoEditor locale={locale} currency={currency} suppliers={suppliers} branches={branches} direct />
    </div>
  );
}
