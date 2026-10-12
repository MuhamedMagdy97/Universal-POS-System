import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { getPurchaseOrder, type PoDetail } from "@/modules/purchasing";
import { canReceive } from "@/modules/purchasing/rules";
import { loadPurchasingContext } from "../../_lib/context";
import { Denied } from "../../_components/states";
import { ReceiveForm } from "../../_components/receive-form";

/** Receive goods against a PO (purchases.receive). Only lines with something outstanding are shown. */

type Props = { params: Promise<{ poId: string }> };

export default function ReceivePage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReceiveContent {...props} />
    </Suspense>
  );
}

async function ReceiveContent({ params }: Props) {
  const { poId } = await params;
  const page = await loadPurchasingContext(`/purchasing/${poId}/receive`);
  if (page.kind === "denied" || !page.can.receive) return <Denied locale={page.locale} />;
  const { ctx, locale, currency } = page;
  const tr = translator(locale);

  let po: PoDetail;
  try {
    po = await getPurchaseOrder(ctx, poId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const open = po.lines.filter((line) => line.outstanding > 0);
  const receivable = canReceive({ status: po.status, receivedUnits: po.totals.receivedUnits }) && open.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/purchasing/${po.id}`} className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.back")}
      </Link>
      <h1 className="text-2xl font-semibold">{tr("purchasing.receive.title", { number: po.number })}</h1>
      <p>
        {po.supplier.name} · {po.branch.name}
      </p>
      {receivable ? (
        <ReceiveForm
          locale={locale}
          currency={currency}
          poId={po.id}
          lines={open.map((line) => ({
            poItemId: line.id,
            name: locale === "ar" && line.nameAr ? line.nameAr : line.name,
            sku: line.sku,
            outstanding: line.outstanding,
            unitCostMinor: line.unitCostMinor,
          }))}
        />
      ) : (
        <p className="text-muted">{tr("purchasing.receive.nothingLeft")}</p>
      )}
    </div>
  );
}
