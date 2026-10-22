import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { getPurchaseReturn, type PurchaseReturnDetail } from "@/modules/purchasing";
import { loadPurchasingContext, shopHeader } from "../../../_lib/context";
import { Denied } from "../../../_components/states";
import { ReturnDocument } from "../../../_components/return-document";

/** One return to the supplier, with its A4 print (purchase-returns-spec R13), laid out like the PO print. */

type Props = {
  params: Promise<{ poId: string; returnId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function PurchaseReturnPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReturnContent {...props} />
    </Suspense>
  );
}

async function ReturnContent({ params, searchParams }: Props) {
  const [{ poId, returnId }, query] = await Promise.all([params, searchParams]);
  const page = await loadPurchasingContext(`/purchasing/${poId}/returns/${returnId}`);
  if (page.kind === "denied") return <Denied locale={page.locale} />;
  const { ctx, locale, zone } = page;

  let detail: PurchaseReturnDetail;
  try {
    detail = await getPurchaseReturn(ctx, poId, returnId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { po, ret } = detail;
  const lineOf = new Map(po.lines.map((line) => [line.id, line]));

  return (
    <ReturnDocument
      locale={locale}
      zone={zone}
      currency={po.currency}
      shop={await shopHeader(ctx.orgId)}
      backHref={`/purchasing/${po.id}`}
      justReturned={Boolean(query.returned)}
      source={{ label: translator(locale)("purchasing.return.order"), number: po.number }}
      supplier={po.supplier}
      branch={po.branch}
      ret={ret}
      lines={detail.lines.map((line) => {
        const poLine = lineOf.get(line.poItemId);
        return {
          ...line,
          key: line.poItemId,
          sku: poLine?.sku ?? "",
          name: (locale === "ar" && poLine?.nameAr ? poLine.nameAr : poLine?.name) ?? "",
        };
      })}
    />
  );
}
