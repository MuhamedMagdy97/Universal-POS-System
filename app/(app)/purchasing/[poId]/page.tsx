import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { translator } from "@/lib/i18n";
import { formatMinor, toMajorString } from "@/lib/money";
import { getPurchaseOrder, type PoDetail } from "@/modules/purchasing";
import { canEdit } from "@/modules/purchasing/rules";
import { activeSuppliers, loadPurchasingContext, shopDateTime } from "../_lib/context";
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
  const editable = can.manage && canEdit({ status: po.status, receivedUnits: po.totals.receivedUnits });
  const suppliers = editable ? await activeSuppliers(ctx.orgId) : [];
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
        <StatusBadge locale={locale} status={po.status} />
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

      <PoActions
        locale={locale}
        poId={po.id}
        status={po.status}
        receivedUnits={po.totals.receivedUnits}
        outstandingUnits={outstandingUnits}
        can={can}
      />

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
              qty: String(line.qtyOrdered),
              cost: toMajorString(line.unitCostMinor, currency),
            })),
          }}
        />
      ) : (
        <table className="w-full text-start">
          <thead>
            <tr className="text-sm text-muted">
              <th className="py-2 text-start">{tr("purchasing.line.item")}</th>
              <th className="text-end">{tr("purchasing.line.ordered")}</th>
              <th className="text-end">{tr("purchasing.line.received")}</th>
              <th className="text-end">{tr("purchasing.line.outstanding")}</th>
              <th className="text-end">{tr("purchasing.line.cost")}</th>
              <th className="text-end">{tr("purchasing.line.total")}</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((line) => (
              <tr key={line.id} className="border-t border-border">
                <td className="py-2">
                  {nameOf(line)}{" "}
                  <span dir="ltr" className="text-muted">
                    {line.sku}
                  </span>
                </td>
                <td className="text-end">{line.qtyOrdered}</td>
                <td className="text-end">{line.qtyReceived}</td>
                <td className="text-end">{line.outstanding}</td>
                <td className="text-end">{formatMinor(line.unitCostMinor, po.currency, locale)}</td>
                <td className="text-end">{formatMinor(line.lineTotalMinor, po.currency, locale)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <td className="py-2">{tr("purchasing.po.total")}</td>
              <td className="text-end">{po.totals.orderedUnits}</td>
              <td className="text-end">{po.totals.receivedUnits}</td>
              <td className="text-end">{outstandingUnits}</td>
              <td />
              <td className="text-end">{formatMinor(po.totals.totalMinor, po.currency, locale)}</td>
            </tr>
          </tfoot>
        </table>
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
              {tr("purchasing.receipts.row", {
                units: receipt.units,
                value: formatMinor(receipt.valueMinor, po.currency, locale),
                name: receipt.receivedByName,
              })}
              {receipt.note ? <span className="text-muted"> — {receipt.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
