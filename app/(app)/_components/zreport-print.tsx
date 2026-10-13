"use client";

import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { formatMoney, type CurrencyCode } from "@/lib/money";
import type { ZReport } from "@/modules/registers";
import { plain, safeAction } from "../inventory/_lib/form";
import { zReportAction } from "../_lib/receipt-action";
import { LoadAndPrintButton } from "./printing";
import { receiptTime } from "./receipt-print";

const ROWS: { key: keyof ZReport; label: MessageKey; strong?: boolean }[] = [
  { key: "openingFloatMinor", label: "pos.close.openingFloat" },
  { key: "cashSalesMinor", label: "pos.close.cashSales" },
  { key: "payInMinor", label: "pos.close.payIn" },
  { key: "payOutMinor", label: "pos.close.payOut" },
  { key: "dropMinor", label: "pos.close.drop" },
  { key: "cashRefundsMinor", label: "pos.close.cashRefunds" },
  { key: "expectedCashMinor", label: "pos.close.expected", strong: true },
  { key: "countedCashMinor", label: "pos.close.counted" },
  { key: "discrepancyMinor", label: "pos.close.difference", strong: true },
];

/** The 80 mm Z-report slip for a closed shift (T10 H9). */
export function ZReportSlip({ report, locale }: { report: ZReport; locale: Locale }) {
  const tr = translator(locale);
  const money = (minor: number) => formatMoney(minor, report.currency as CurrencyCode, locale);
  const time = (iso: string) => receiptTime(iso, report.timeZone, locale);
  return (
    <article className="print-receipt" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale} data-testid="zreport-slip">
      <p className="receipt-center receipt-strong">{tr("zreport.title")}</p>
      <p className="receipt-center">
        {report.branchName} · {report.registerName}
      </p>
      <p className="receipt-rule">{tr("zreport.opened", { time: time(report.openedAt), name: report.openedBy })}</p>
      <p>{tr("zreport.closed", { time: time(report.closedAt), name: report.closedBy })}</p>
      <table className="receipt-rule">
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.key} className={row.strong ? "receipt-strong" : undefined}>
              <td>{plain(locale, row.label)}</td>
              <td dir="ltr" className="receipt-end">
                {money(report[row.key] as number)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.discrepancyNote ? (
        <p className="receipt-rule">{tr("zreport.note", { note: report.discrepancyNote })}</p>
      ) : null}
    </article>
  );
}

export function PrintZReportButton({
  locale,
  shiftId,
  className,
}: {
  locale: Locale;
  shiftId: string;
  className?: string;
}) {
  return (
    <LoadAndPrintButton
      label={plain(locale, "zreport.print")}
      errorLabel={plain(locale, "receipt.error")}
      className={className}
      load={() => safeAction(() => zReportAction(shiftId))}
      render={(report) => <ZReportSlip report={report} locale={locale} />}
    />
  );
}
