"use client";

import { useState } from "react";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { formatMoney, type CurrencyCode } from "@/lib/money";
import type { ReceiptDoc, ReceiptRequest } from "@/modules/sales";
import { plain, safeAction } from "../inventory/_lib/form";
import { receiptAction } from "../_lib/receipt-action";
import { usePrinter } from "./printing";

const METHOD_LABEL: Record<string, MessageKey> = {
  CASH: "pos.pay.cash",
  CARD_MANUAL: "pos.pay.card",
  WALLET: "pos.pay.wallet",
};

/** Dates and times print in the shop's timezone with Latin digits in both locales (D10, H11). */
export function receiptTime(iso: string, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en-GB", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

/** "14%" or "0% · 15%", Latin digits. */
export function vatRatesLabel(ratesBp: number[]): string {
  return ratesBp.map((bp) => `${bp / 100}%`).join(" · ");
}

/** The 80 mm slip for a sale, refund or void (T10 H1, H2). Print-only layout. */
export function ReceiptSlip({ doc, locale }: { doc: ReceiptDoc; locale: Locale }) {
  const tr = translator(locale);
  const money = (minor: number) => formatMoney(minor, doc.currency as CurrencyCode, locale);
  const { shop } = doc;
  return (
    <article className="print-receipt" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale} data-testid="receipt-slip">
      <header className="receipt-center">
        <p className="receipt-strong">{shop.name}</p>
        <p>{shop.branchName}</p>
        {shop.address ? <p>{shop.address}</p> : null}
        {shop.phone ? <p dir="ltr">{shop.phone}</p> : null}
        {shop.taxNumber ? <p>{tr("receipt.vatNo", { number: shop.taxNumber })}</p> : null}
        {shop.header ? <p>{shop.header}</p> : null}
      </header>
      <p className="receipt-center receipt-strong receipt-rule">
        {tr(`receipt.title.${doc.kind}`)}
        {doc.copy ? ` · ${tr("receipt.copy")}` : ""}
      </p>
      <p>{tr("receipt.sale", { number: doc.saleNumber })}</p>
      <p dir="ltr" className="receipt-start">
        {receiptTime(doc.at, doc.timeZone, locale)}
      </p>
      <p>{tr("receipt.staff", { name: doc.staffName })}</p>
      <p>{tr("receipt.register", { name: doc.registerName })}</p>
      {doc.reason ? <p>{tr("receipt.reason", { reason: doc.reason })}</p> : null}
      <table className="receipt-rule">
        <tbody>
          {doc.lines.map((line, index) => (
            <tr key={index}>
              <td>
                {locale === "ar" && line.nameAr ? line.nameAr : line.name} × <bdi>{line.qty}</bdi>
              </td>
              <td dir="ltr" className="receipt-end">
                {money(line.lineTotalMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="receipt-rule">
        <tbody>
          <tr>
            <td>{tr("receipt.subtotal")}</td>
            <td dir="ltr" className="receipt-end">
              {money(doc.subtotalMinor)}
            </td>
          </tr>
          <tr>
            <td>{tr("receipt.vat", { rates: vatRatesLabel(doc.vatRatesBp) })}</td>
            <td dir="ltr" className="receipt-end">
              {money(doc.vatMinor)}
            </td>
          </tr>
          <tr className="receipt-strong">
            <td>{doc.kind === "REFUND" ? tr("receipt.refunded") : tr("receipt.total")}</td>
            <td dir="ltr" className="receipt-end">
              {money(doc.totalMinor)}
            </td>
          </tr>
          {doc.payments.map((payment, index) => (
            <tr key={index}>
              <td>{plain(locale, METHOD_LABEL[payment.method] ?? "pos.pay.cash")}</td>
              <td dir="ltr" className="receipt-end">
                {money(payment.amountMinor)}
              </td>
            </tr>
          ))}
          {doc.changeMinor > 0 ? (
            <tr>
              <td>{tr("receipt.change")}</td>
              <td dir="ltr" className="receipt-end">
                {money(doc.changeMinor)}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {shop.footer ? <p className="receipt-center receipt-rule">{shop.footer}</p> : null}
    </article>
  );
}

type ButtonProps = {
  locale: Locale;
  saleId: string;
  request: ReceiptRequest;
  label: MessageKey;
  className?: string;
};

/** Loads the receipt from the server (a copy is audited there) and prints it. */
export function PrintReceiptButton({ locale, saleId, request, label, className }: ButtonProps) {
  const tr = translator(locale);
  const { print, portal } = usePrinter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function load() {
    setPending(true);
    setFailed(false);
    const result = await safeAction(() => receiptAction(saleId, request));
    setPending(false);
    if (result.ok) print(<ReceiptSlip doc={result.data} locale={locale} />);
    else setFailed(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void load()}
        disabled={pending}
        className={className ?? "rounded-md border border-border px-4 py-2 disabled:opacity-50"}
      >
        {plain(locale, label)}
      </button>
      {failed ? (
        <span role="alert" className="text-red-700">
          {tr("receipt.error")}
        </span>
      ) : null}
      {portal}
    </>
  );
}
