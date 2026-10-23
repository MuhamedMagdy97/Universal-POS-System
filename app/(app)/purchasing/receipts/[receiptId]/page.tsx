import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { formatMinor } from "@/lib/money";
import { getDirectReceipt, type DirectReceiptDetail } from "@/modules/purchasing";
import { loadPurchasingContext, shopDateTime } from "../../_lib/context";
import { Denied } from "../../_components/states";

/**
 * One direct receipt (direct-receipt-returns-spec DR11): its lines with what went back, the returns
 * so far, and **Return to supplier** for purchases.manage while something is returnable.
 */

type Props = { params: Promise<{ receiptId: string }> };

export default function DirectReceiptPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <ReceiptContent {...props} />
    </Suspense>
  );
}

async function ReceiptContent({ params }: Props) {
  const { receiptId } = await params;
  const page = await loadPurchasingContext(`/purchasing/receipts/${receiptId}`);
  if (page.kind === "denied") return <Denied locale={page.locale} />;
  const { ctx, locale, can, zone } = page;
  const tr = translator(locale);

  let receipt: DirectReceiptDetail;
  try {
    receipt = await getDirectReceipt(ctx, receiptId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const money = (minor: number) => formatMinor(minor, receipt.currency, locale);
  const returnedUnits = receipt.lines.reduce((total, line) => total + line.qtyReturned, 0);
  const returnable = can.manage && receipt.lines.some((line) => line.returnable > 0);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/purchasing" className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.title")}
      </Link>
      <h1 className="text-2xl font-semibold" dir="ltr">
        {receipt.number}
      </h1>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">{tr("purchasing.po.supplier")}</dt>
        <dd>{receipt.supplier.name}</dd>
        <dt className="text-muted">{tr("purchasing.po.branch")}</dt>
        <dd>{receipt.branch.name}</dd>
        <dt className="text-muted">{tr("purchasing.receipt.date")}</dt>
        <dd dir="ltr" className="text-start">
          {shopDateTime(receipt.receivedAt, zone)}
        </dd>
        <dt className="text-muted">{tr("purchasing.receipt.by")}</dt>
        <dd>{receipt.receivedByName}</dd>
        {receipt.note ? (
          <>
            <dt className="text-muted">{tr("purchasing.po.note")}</dt>
            <dd>{receipt.note}</dd>
          </>
        ) : null}
      </dl>

      {returnable ? (
        <Link href={`/purchasing/receipts/${receipt.id}/return`} className="btn self-start">
          {tr("purchasing.action.return")}
        </Link>
      ) : null}

      <h2 className="text-lg font-semibold">{tr("purchasing.po.lines")}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr className="text-sm text-muted">
              <th>{tr("purchasing.line.item")}</th>
              <th className="text-end">{tr("purchasing.line.received")}</th>
              <th className="text-end">{tr("purchasing.line.returned")}</th>
              <th className="text-end">{tr("purchasing.line.cost")}</th>
              <th className="text-end">{tr("purchasing.line.total")}</th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((line) => (
              <tr key={line.id}>
                <td>
                  {locale === "ar" && line.nameAr ? line.nameAr : line.name}{" "}
                  <span dir="ltr" className="text-muted">
                    {line.sku}
                  </span>
                </td>
                <td className="text-end">{line.qtyReceived}</td>
                <td className="text-end">{line.qtyReturned}</td>
                <td className="text-end">{money(line.unitCostMinor)}</td>
                <td className="text-end">{money(line.lineTotalMinor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <td>{tr("purchasing.po.total")}</td>
              <td className="text-end">{receipt.units}</td>
              <td className="text-end">{returnedUnits}</td>
              <td />
              <td className="text-end">{money(receipt.valueMinor)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {receipt.returns.length > 0 ? (
        <>
          <h2 className="text-lg font-semibold">{tr("purchasing.returns")}</h2>
          <ul className="flex flex-col gap-1">
            {receipt.returns.map((ret) => (
              <li key={ret.id}>
                <span dir="ltr" className="text-muted">
                  {shopDateTime(ret.returnedAt, zone)}
                </span>{" "}
                <Link
                  href={`/purchasing/receipts/${receipt.id}/returns/${ret.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {tr("purchasing.returns.row", {
                    number: ret.number,
                    units: ret.units,
                    value: money(ret.valueMinor),
                    name: ret.returnedByName,
                  })}
                </Link>{" "}
                <span className="text-muted">— {tr(`purchasing.reason.${ret.reason}`)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
