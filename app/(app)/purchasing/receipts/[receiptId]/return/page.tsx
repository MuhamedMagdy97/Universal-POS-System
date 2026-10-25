import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { getDirectReceipt, type DirectReceiptDetail } from "@/modules/purchasing";
import { loadPurchasingContext } from "../../../_lib/context";
import { Denied } from "../../../_components/states";
import { ReturnForm } from "../../../_components/return-form";

/** Return goods from a direct receipt (direct-receipt-returns-spec DR1, DR11; purchases.manage). */

type Props = { params: Promise<{ receiptId: string }> };

export default function DirectReturnFormPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReturnContent {...props} />
    </Suspense>
  );
}

async function ReturnContent({ params }: Props) {
  const { receiptId } = await params;
  const page = await loadPurchasingContext(`/purchasing/receipts/${receiptId}/return`);
  if (page.kind === "denied" || !page.can.manage) return <Denied locale={page.locale} />;
  const { ctx, locale, currency } = page;
  const tr = translator(locale);

  let receipt: DirectReceiptDetail;
  try {
    receipt = await getDirectReceipt(ctx, receiptId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const open = receipt.lines.filter((line) => line.returnable > 0);

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/purchasing/receipts/${receipt.id}`} className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.back")}
      </Link>
      <h1 className="text-2xl font-semibold">{tr("purchasing.return.title", { number: receipt.number })}</h1>
      <p>
        {receipt.supplier.name} · {receipt.branch.name}
      </p>
      {open.length > 0 ? (
        <ReturnForm
          // A new returnable amount starts a fresh form (fresh quantities and Idempotency-Key), as on the PO.
          key={open.map((line) => `${line.id}:${line.returnable}`).join(",")}
          locale={locale}
          currency={currency}
          source={{ kind: "receipt", id: receipt.id }}
          lines={open.map((line) => ({
            lineId: line.id,
            name: locale === "ar" && line.nameAr ? line.nameAr : line.name,
            sku: line.sku,
            returnable: line.returnable,
            unitCostMinor: line.unitCostMinor,
            unitType: line.unitType,
          }))}
        />
      ) : (
        <p className="text-muted">{tr("purchasing.receiptReturn.nothing")}</p>
      )}
    </div>
  );
}
