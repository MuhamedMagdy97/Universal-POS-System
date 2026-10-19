import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { formatMinor } from "@/lib/money";
import { getPurchaseReturn, type PurchaseReturnDetail } from "@/modules/purchasing";
import { loadPurchasingContext, shopDateTime, shopHeader } from "../../../_lib/context";
import { PrintButton } from "../../../../_components/printing";
import { Denied } from "../../../_components/states";

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
  const tr = translator(locale);

  let detail: PurchaseReturnDetail;
  try {
    detail = await getPurchaseReturn(ctx, poId, returnId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const { po, ret } = detail;
  const shop = await shopHeader(ctx.orgId);
  const lineOf = new Map(po.lines.map((line) => [line.id, line]));
  const lines = detail.lines.map((line) => {
    const poLine = lineOf.get(line.poItemId);
    return {
      ...line,
      sku: poLine?.sku ?? "",
      name: (locale === "ar" && poLine?.nameAr ? poLine.nameAr : poLine?.name) ?? "",
    };
  });
  const money = (minor: number) => formatMinor(minor, po.currency, locale);

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/purchasing/${po.id}`} className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.back")}
      </Link>
      <h1 className="text-2xl font-semibold" dir="ltr">
        {ret.number}
      </h1>
      {query.returned ? <p role="status">{tr("purchasing.return.done")}</p> : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">{tr("purchasing.return.order")}</dt>
        <dd dir="ltr" className="text-start">
          {po.number}
        </dd>
        <dt className="text-muted">{tr("purchasing.po.supplier")}</dt>
        <dd>{po.supplier.name}</dd>
        <dt className="text-muted">{tr("purchasing.po.branch")}</dt>
        <dd>{po.branch.name}</dd>
        <dt className="text-muted">{tr("purchasing.return.date")}</dt>
        <dd dir="ltr" className="text-start">
          {shopDateTime(ret.returnedAt, zone)}
        </dd>
        <dt className="text-muted">{tr("purchasing.return.by")}</dt>
        <dd>{ret.returnedByName}</dd>
        <dt className="text-muted">{tr("purchasing.return.reason")}</dt>
        <dd data-testid="return-reason">{tr(`purchasing.reason.${ret.reason}`)}</dd>
        {ret.note ? (
          <>
            <dt className="text-muted">{tr("purchasing.po.note")}</dt>
            <dd>{ret.note}</dd>
          </>
        ) : null}
      </dl>

      <PrintButton label={tr("purchasing.print.return")}>
        <article className="print-a4" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale} data-testid="return-print">
          <header style={{ display: "flex", justifyContent: "space-between", gap: "8mm", marginBottom: "6mm" }}>
            <div>
              <p style={{ fontWeight: 700, fontSize: "14px" }}>{shop.name}</p>
              {shop.address ? <p>{shop.address}</p> : null}
              {shop.phone ? <p dir="ltr">{shop.phone}</p> : null}
              {shop.taxNumber ? <p>{tr("receipt.vatNo", { number: shop.taxNumber })}</p> : null}
            </div>
            <div style={{ textAlign: "end" }}>
              <p style={{ fontWeight: 700, fontSize: "14px" }}>{tr("purchasing.print.returnTitle")}</p>
              <p dir="ltr">{ret.number}</p>
              <p dir="ltr">{shopDateTime(ret.returnedAt, zone)}</p>
            </div>
          </header>
          <p>
            <strong>{tr("purchasing.po.supplier")}:</strong> {po.supplier.name}
            {po.supplier.phone ? (
              <>
                {" "}
                · {tr("purchasing.supplier.phone")}: <bdi>{po.supplier.phone}</bdi>
              </>
            ) : null}
            {po.supplier.taxNumber ? (
              <>
                {" "}
                · {tr("purchasing.supplier.taxNumber")}: <bdi>{po.supplier.taxNumber}</bdi>
              </>
            ) : null}
          </p>
          <p>
            <strong>{tr("purchasing.po.branch")}:</strong> {po.branch.name} ·{" "}
            <strong>{tr("purchasing.return.order")}:</strong> <bdi>{po.number}</bdi>
          </p>
          <p style={{ marginBottom: "4mm" }}>
            <strong>{tr("purchasing.return.reason")}:</strong> {tr(`purchasing.reason.${ret.reason}`)}
          </p>
          <table>
            <thead>
              <tr>
                <th>{tr("purchasing.line.item")}</th>
                <th className="num">{tr("purchasing.line.returned")}</th>
                <th className="num">{tr("purchasing.line.cost")}</th>
                <th className="num">{tr("purchasing.line.total")}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.poItemId}>
                  <td>
                    {line.name} <bdi>{line.sku}</bdi>
                  </td>
                  <td className="num">{line.qty}</td>
                  <td className="num" dir="ltr">
                    {money(line.unitCostMinor)}
                  </td>
                  <td className="num" dir="ltr">
                    {money(line.lineTotalMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>{tr("purchasing.po.total")}</th>
                <th className="num">{ret.units}</th>
                <th />
                <th className="num" dir="ltr">
                  {money(ret.valueMinor)}
                </th>
              </tr>
            </tfoot>
          </table>
          {ret.note ? (
            <p style={{ marginTop: "4mm" }}>
              <strong>{tr("purchasing.po.note")}:</strong> {ret.note}
            </p>
          ) : null}
        </article>
      </PrintButton>

      <table className="w-full text-start">
        <thead>
          <tr className="text-sm text-muted">
            <th className="py-2 text-start">{tr("purchasing.line.item")}</th>
            <th className="text-end">{tr("purchasing.line.returned")}</th>
            <th className="text-end">{tr("purchasing.line.cost")}</th>
            <th className="text-end">{tr("purchasing.line.total")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.poItemId} className="border-t border-border">
              <td className="py-2">
                {line.name}{" "}
                <span dir="ltr" className="text-muted">
                  {line.sku}
                </span>
              </td>
              <td className="text-end">{line.qty}</td>
              <td className="text-end">{money(line.unitCostMinor)}</td>
              <td className="text-end">{money(line.lineTotalMinor)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold">
            <td className="py-2">{tr("purchasing.po.total")}</td>
            <td className="text-end">{ret.units}</td>
            <td />
            <td className="text-end">{money(ret.valueMinor)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
