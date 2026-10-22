import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { getPurchaseOrder, type PoDetail } from "@/modules/purchasing";
import { loadPurchasingContext } from "../../_lib/context";
import { Denied } from "../../_components/states";
import { ReturnForm } from "../../_components/return-form";

/** Return received goods to the supplier (purchases.manage). Only lines with something returnable are shown. */

type Props = { params: Promise<{ poId: string }> };

export default function ReturnPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReturnContent {...props} />
    </Suspense>
  );
}

async function ReturnContent({ params }: Props) {
  const { poId } = await params;
  const page = await loadPurchasingContext(`/purchasing/${poId}/return`);
  if (page.kind === "denied" || !page.can.manage) return <Denied locale={page.locale} />;
  const { ctx, locale, currency } = page;
  const tr = translator(locale);

  let po: PoDetail;
  try {
    po = await getPurchaseOrder(ctx, poId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const open = po.lines.filter((line) => line.returnable > 0);

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/purchasing/${po.id}`} className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.back")}
      </Link>
      <h1 className="text-2xl font-semibold">{tr("purchasing.return.title", { number: po.number })}</h1>
      <p>
        {po.supplier.name} · {po.branch.name}
      </p>
      {open.length > 0 ? (
        <ReturnForm
          // A new returnable amount starts a fresh form (fresh quantities and Idempotency-Key), as on receive.
          key={open.map((line) => `${line.id}:${line.returnable}`).join(",")}
          locale={locale}
          currency={currency}
          source={{ kind: "po", id: po.id }}
          lines={open.map((line) => ({
            lineId: line.id,
            name: locale === "ar" && line.nameAr ? line.nameAr : line.name,
            sku: line.sku,
            returnable: line.returnable,
            unitCostMinor: line.unitCostMinor,
          }))}
        />
      ) : (
        <p className="text-muted">{tr("purchasing.return.nothing")}</p>
      )}
    </div>
  );
}
