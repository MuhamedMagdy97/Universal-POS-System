import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { formatMinor, toMajorString } from "@/lib/money";
import { formatQty, qtyInputValue } from "@/lib/quantity";
import { getPurchaseOrder, type PoDetail } from "@/modules/purchasing";
import { canEdit } from "@/modules/purchasing/rules";
import { activeSuppliers, loadPurchasingContext, shopDateTime, shopHeader } from "../_lib/context";
import { PrintButton } from "../../_components/printing";
import { Denied, StatusBadge } from "../_components/states";
import { PoActions } from "../_components/po-actions";
import { PoEditor } from "../_components/po-editor";

/**
 * One purchase order: header, actions by state, lines (editable while P4 allows, for
 * purchases.manage) and the receipts so far.
 */

type Props = {
  params: Promise<{ poId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default function PurchaseOrderPage(props: Props) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <PoContent {...props} />
    </Suspense>
  );
}

async function PoContent({ params, searchParams }: Props) {
  const [{ poId }, query] = await Promise.all([params, searchParams]);
  const page = await loadPurchasingContext(`/purchasing/${poId}`);
  if (page.kind === "denied") return <Denied locale={page.locale} />;
  const { ctx, locale, can, currency, zone } = page;
  const tr = translator(locale);

  let po: PoDetail;
  try {
    po = await getPurchaseOrder(ctx, poId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const outstandingUnits = po.lines.reduce((total, line) => total + line.outstanding, 0);
  const returnedUnits = po.lines.reduce((total, line) => total + line.qtyReturned, 0);
  // Grams and pieces do not add up: a weighed order shows "—" for its unit totals (weighed-selling-spec W9).
  const units = (total: number) => (po.totals.weighed ? "—" : total);
  const returnable = can.manage && po.lines.some((line) => line.returnable > 0);
  const editable = can.manage && canEdit({ status: po.status, receivedUnits: po.totals.receivedUnits });
  const [suppliers, shop] = await Promise.all([
    editable ? activeSuppliers(ctx.orgId) : Promise.resolve<{ id: string; name: string }[]>([]),
    shopHeader(ctx.orgId),
  ]);
  // Keep the current supplier pickable even if it was archived after the PO was raised.
  if (editable && !suppliers.some((s) => s.id === po.supplier.id)) suppliers.unshift(po.supplier);
  const nameOf = (line: { name: string; nameAr: string | null }) =>
    locale === "ar" && line.nameAr ? line.nameAr : line.name;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/purchasing" className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.title")}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold" dir="ltr">
          {po.number}
        </h1>
        <span data-testid="po-status">
          <StatusBadge locale={locale} status={po.status} />
        </span>
      </div>
      {query.received ? <p role="status">{tr("purchasing.receive.done")}</p> : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">{tr("purchasing.po.supplier")}</dt>
        <dd>{po.supplier.name}</dd>
        <dt className="text-muted">{tr("purchasing.po.branch")}</dt>
        <dd>{po.branch.name}</dd>
        <dt className="text-muted">{tr("purchasing.po.created")}</dt>
        <dd dir="ltr" className="text-start">
          {shopDateTime(po.createdAt, zone)}
        </dd>
        {po.orderedAt ? (
          <>
            <dt className="text-muted">{tr("purchasing.po.ordered")}</dt>
            <dd dir="ltr" className="text-start">
              {shopDateTime(po.orderedAt, zone)}
            </dd>
          </>
        ) : null}
        {po.closedAt ? (
          <>
            <dt className="text-muted">{tr("purchasing.po.closed")}</dt>
            <dd dir="ltr" className="text-start">
              {shopDateTime(po.closedAt, zone)}
            </dd>
          </>
        ) : null}
        {po.closeReason ? (
          <>
            <dt className="text-muted">{tr("purchasing.po.closeReason")}</dt>
            <dd>{po.closeReason}</dd>
          </>
        ) : null}
        {po.note && !editable ? (
          <>
            <dt className="text-muted">{tr("purchasing.po.note")}</dt>
            <dd>{po.note}</dd>
          </>
        ) : null}
      </dl>

      <PrintButton label={tr("purchasing.print")}>
        <article className="print-a4" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale} data-testid="po-print">
          <header style={{ display: "flex", justifyContent: "space-between", gap: "8mm", marginBottom: "6mm" }}>
            <div>
              <p style={{ fontWeight: 700, fontSize: "14px" }}>{shop.name}</p>
              {shop.address ? <p>{shop.address}</p> : null}
              {shop.phone ? <p dir="ltr">{shop.phone}</p> : null}
              {shop.taxNumber ? <p>{tr("receipt.vatNo", { number: shop.taxNumber })}</p> : null}
            </div>
            <div style={{ textAlign: "end" }}>
              <p style={{ fontWeight: 700, fontSize: "14px" }}>{tr("purchasing.print.title")}</p>
              <p dir="ltr">{po.number}</p>
              <p dir="ltr">{shopDateTime(po.orderedAt ?? po.createdAt, zone)}</p>
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
          <p style={{ marginBottom: "4mm" }}>
            <strong>{tr("purchasing.po.branch")}:</strong> {po.branch.name}
          </p>
          <table>
            <thead>
              <tr>
                <th>{tr("purchasing.line.item")}</th>
                <th className="num">{tr("purchasing.line.ordered")}</th>
                <th className="num">{tr("purchasing.line.cost")}</th>
                <th className="num">{tr("purchasing.line.total")}</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    {nameOf(line)} <bdi>{line.sku}</bdi>
                  </td>
                  <td className="num">{formatQty(line.qtyOrdered, line.unitType, locale)}</td>
                  <td className="num" dir="ltr">
                    {formatMinor(line.unitCostMinor, po.currency, locale)}
                    {line.unitType === "KG" ? ` / ${tr("pos.weight.kg")}` : ""}
                  </td>
                  <td className="num" dir="ltr">
                    {formatMinor(line.lineTotalMinor, po.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>{tr("purchasing.po.total")}</th>
                <th className="num">{units(po.totals.orderedUnits)}</th>
                <th />
                <th className="num" dir="ltr">
                  {formatMinor(po.totals.totalMinor, po.currency, locale)}
                </th>
              </tr>
            </tfoot>
          </table>
          {po.note ? (
            <p style={{ marginTop: "4mm" }}>
              <strong>{tr("purchasing.po.note")}:</strong> {po.note}
            </p>
          ) : null}
        </article>
      </PrintButton>

      <PoActions
        locale={locale}
        poId={po.id}
        status={po.status}
        receivedUnits={po.totals.receivedUnits}
        outstandingUnits={po.totals.weighed ? null : outstandingUnits}
        can={can}
      />
      {returnable ? (
        <Link href={`/purchasing/${po.id}/return`} className="btn self-start">
          {tr("purchasing.action.return")}
        </Link>
      ) : null}

      <h2 className="text-lg font-semibold">{tr("purchasing.po.lines")}</h2>
      {editable ? (
        <PoEditor
          locale={locale}
          currency={currency}
          suppliers={suppliers}
          branches={null}
          existing={{
            id: po.id,
            supplierId: po.supplier.id,
            note: po.note,
            lines: po.lines.map((line) => ({
              productId: line.productId,
              variantId: line.variantId,
              name: nameOf(line),
              sku: line.sku,
              unitType: line.unitType,
              qty: qtyInputValue(line.qtyOrdered, line.unitType),
              cost: toMajorString(line.unitCostMinor, currency),
            })),
          }}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr className="text-sm text-muted">
                <th>{tr("purchasing.line.item")}</th>
                <th className="text-end">{tr("purchasing.line.ordered")}</th>
                <th className="text-end">{tr("purchasing.line.received")}</th>
                <th className="text-end">{tr("purchasing.line.outstanding")}</th>
                <th className="text-end">{tr("purchasing.line.returned")}</th>
                <th className="text-end">{tr("purchasing.line.cost")}</th>
                <th className="text-end">{tr("purchasing.line.total")}</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    {nameOf(line)}{" "}
                    <span dir="ltr" className="text-muted">
                      {line.sku}
                    </span>
                  </td>
                  <td className="text-end">{formatQty(line.qtyOrdered, line.unitType, locale)}</td>
                  <td className="text-end">{formatQty(line.qtyReceived, line.unitType, locale)}</td>
                  <td className="text-end">{formatQty(line.outstanding, line.unitType, locale)}</td>
                  <td className="text-end">{formatQty(line.qtyReturned, line.unitType, locale)}</td>
                  <td className="text-end">
                    {formatMinor(line.unitCostMinor, po.currency, locale)}
                    {line.unitType === "KG" ? ` / ${tr("pos.weight.kg")}` : ""}
                  </td>
                  <td className="text-end">{formatMinor(line.lineTotalMinor, po.currency, locale)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold">
                <td>{tr("purchasing.po.total")}</td>
                <td className="text-end">{units(po.totals.orderedUnits)}</td>
                <td className="text-end">{units(po.totals.receivedUnits)}</td>
                <td className="text-end">{units(outstandingUnits)}</td>
                <td className="text-end">{units(returnedUnits)}</td>
                <td />
                <td className="text-end">{formatMinor(po.totals.totalMinor, po.currency, locale)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <h2 className="text-lg font-semibold">{tr("purchasing.receipts")}</h2>
      {po.receipts.length === 0 ? (
        <p className="text-muted">{tr("purchasing.receipts.none")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {po.receipts.map((receipt) => (
            <li key={receipt.id}>
              <span dir="ltr" className="text-muted">
                {shopDateTime(receipt.receivedAt, zone)}
              </span>{" "}
              {po.totals.weighed
                ? tr("purchasing.receipts.rowWeighed", {
                    value: formatMinor(receipt.valueMinor, po.currency, locale),
                    name: receipt.receivedByName,
                  })
                : tr("purchasing.receipts.row", {
                    units: receipt.units,
                    value: formatMinor(receipt.valueMinor, po.currency, locale),
                    name: receipt.receivedByName,
                  })}
              {receipt.note ? <span className="text-muted"> — {receipt.note}</span> : null}
            </li>
          ))}
        </ul>
      )}

      {po.returns.length > 0 ? (
        <>
          <h2 className="text-lg font-semibold">{tr("purchasing.returns")}</h2>
          <ul className="flex flex-col gap-1">
            {po.returns.map((ret) => (
              <li key={ret.id}>
                <span dir="ltr" className="text-muted">
                  {shopDateTime(ret.returnedAt, zone)}
                </span>{" "}
                <Link href={`/purchasing/${po.id}/returns/${ret.id}`} className="underline-offset-4 hover:underline">
                  {po.totals.weighed
                    ? tr("purchasing.returns.rowWeighed", {
                        number: ret.number,
                        value: formatMinor(ret.valueMinor, po.currency, locale),
                        name: ret.returnedByName,
                      })
                    : tr("purchasing.returns.row", {
                        number: ret.number,
                        units: ret.units,
                        value: formatMinor(ret.valueMinor, po.currency, locale),
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
