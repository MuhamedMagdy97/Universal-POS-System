import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { getDirectReturn, type DirectReturnDetail } from "@/modules/purchasing";
import { loadPurchasingContext, shopHeader } from "../../../../_lib/context";
import { Denied } from "../../../../_components/states";
import { ReturnDocument } from "../../../../_components/return-document";

/** One return against a direct receipt, with its A4 print (direct-receipt-returns-spec DR11). */

type Props = {
  params: Promise<{ receiptId: string; returnId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function DirectReturnPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReturnContent {...props} />
    </Suspense>
  );
}

async function ReturnContent({ params, searchParams }: Props) {
  const [{ receiptId, returnId }, query] = await Promise.all([params, searchParams]);
  const page = await loadPurchasingContext(`/purchasing/receipts/${receiptId}/returns/${returnId}`);
  if (page.kind === "denied") return <Denied locale={page.locale} />;
  const { ctx, locale, zone } = page;

  let detail: DirectReturnDetail;
  try {
    detail = await getDirectReturn(ctx, receiptId, returnId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { receipt, ret } = detail;
  const lineOf = new Map(receipt.lines.map((line) => [line.id, line]));

  return (
    <ReturnDocument
      locale={locale}
      zone={zone}
      currency={receipt.currency}
      shop={await shopHeader(ctx.orgId)}
      backHref={`/purchasing/receipts/${receipt.id}`}
      justReturned={Boolean(query.returned)}
      source={{ label: translator(locale)("purchasing.receiptReturn.receipt"), number: receipt.number }}
      supplier={receipt.supplier}
      branch={receipt.branch}
      ret={ret}
      lines={detail.lines.map((line) => {
        const receiptLine = lineOf.get(line.goodsReceiptItemId);
        return {
          ...line,
          key: line.goodsReceiptItemId,
          sku: receiptLine?.sku ?? "",
          name: (locale === "ar" && receiptLine?.nameAr ? receiptLine.nameAr : receiptLine?.name) ?? "",
        };
      })}
    />
  );
}
