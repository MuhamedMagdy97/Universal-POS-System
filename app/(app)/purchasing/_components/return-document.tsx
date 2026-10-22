import Link from "next/link";
import { translator, type Locale } from "@/lib/i18n";
import { formatMinor, type CurrencyCode } from "@/lib/money";
import type { PoReturn } from "@/modules/purchasing";
import { shopDateTime, type shopHeader } from "../_lib/context";
import { PrintButton } from "../../_components/printing";

/**
 * One return to the supplier with its A4 print, laid out like the PO print (purchase-returns-spec R13).
 * Shared by PO returns and returns against a direct receipt (direct-receipt-returns-spec DR11): only the
 * source line (purchase order or receipt) differs.
 */

type Props = {
  locale: Locale;
  zone: string;
  currency: CurrencyCode;
  shop: Awaited<ReturnType<typeof shopHeader>>;
  backHref: string;
  justReturned: boolean;
  /** "Purchase order" or "Goods receipt", and its number. */
  source: { label: string; number: string };
  supplier: { name: string; phone: string | null; taxNumber: string | null };
  branch: { name: string };
  ret: PoReturn;
  lines: { key: string; name: string; sku: string; qty: number; unitCostMinor: number; lineTotalMinor: number }[];
};

export function ReturnDocument(props: Props) {
  const { locale, zone, shop, source, supplier, branch, ret, lines } = props;
  const tr = translator(locale);
  const money = (minor: number) => formatMinor(minor, props.currency, locale);

  return (
    <div className="flex flex-col gap-4">
      <Link href={props.backHref} className="text-sm underline-offset-4 hover:underline">
        {tr("purchasing.back")}
      </Link>
      <h1 className="text-2xl font-semibold" dir="ltr">
        {ret.number}
      </h1>
      {props.justReturned ? <p role="status">{tr("purchasing.return.done")}</p> : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">{source.label}</dt>
        <dd dir="ltr" className="text-start">
          {source.number}
        </dd>
        <dt className="text-muted">{tr("purchasing.po.supplier")}</dt>
        <dd>{supplier.name}</dd>
        <dt className="text-muted">{tr("purchasing.po.branch")}</dt>
        <dd>{branch.name}</dd>
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
            <strong>{tr("purchasing.po.supplier")}:</strong> {supplier.name}
            {supplier.phone ? (
              <>
                {" "}
                · {tr("purchasing.supplier.phone")}: <bdi>{supplier.phone}</bdi>
              </>
            ) : null}
            {supplier.taxNumber ? (
              <>
                {" "}
                · {tr("purchasing.supplier.taxNumber")}: <bdi>{supplier.taxNumber}</bdi>
              </>
            ) : null}
          </p>
          <p>
            <strong>{tr("purchasing.po.branch")}:</strong> {branch.name} · <strong>{source.label}:</strong>{" "}
            <bdi>{source.number}</bdi>
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
                <tr key={line.key}>
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
            <tr key={line.key} className="border-t border-border">
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
