"use client";

import { useState } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { LoadAndPrintButton } from "../../../_components/printing";
import { countSheetAction } from "../actions";
import { sheetRows, type SheetRow } from "../_lib/sheet";

/**
 * A4 count sheet (C15). Its own named page adds page numbers; the table head repeats on every
 * page and a row never splits. Blind by default: expected quantities only when asked for.
 */
const SHEET_CSS = `
@page count-sheet {
  size: A4;
  margin: 12mm 12mm 16mm;
  @bottom-center { content: counter(page) " / " counter(pages); font-size: 10px; }
}
.count-sheet thead { display: table-header-group; }
.count-sheet tr { break-inside: avoid; }
.count-sheet td { padding-block: 2.5mm; }
.count-sheet .blank { width: 28mm; }
`;

export function CountSheetPrint({
  locale,
  countId,
  heading,
}: {
  locale: Locale;
  countId: string;
  /** Branch, scope and date line, as on the count page. */
  heading: string;
}) {
  const tr = translator(locale);
  const [showExpected, setShowExpected] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <LoadAndPrintButton
        label={tr("inventory.count.sheet.print")}
        errorLabel={tr("inventory.count.sheet.failed")}
        load={() => countSheetAction(countId, showExpected)}
        render={(items) => (
          <CountSheet locale={locale} heading={heading} rows={sheetRows(items, locale)} showExpected={showExpected} />
        )}
      />
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={showExpected} onChange={(e) => setShowExpected(e.target.checked)} />
        {tr("inventory.count.sheet.showExpected")}
      </label>
    </div>
  );
}

function CountSheet({
  locale,
  heading,
  rows,
  showExpected,
}: {
  locale: Locale;
  heading: string;
  rows: SheetRow[];
  showExpected: boolean;
}) {
  const tr = translator(locale);
  const printedAt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date());
  return (
    <article
      className="print-a4 count-sheet"
      style={{ page: "count-sheet" }}
      dir={locale === "ar" ? "rtl" : "ltr"}
      lang={locale}
      data-testid="count-sheet"
    >
      <style>{SHEET_CSS}</style>
      <header style={{ marginBottom: "4mm" }}>
        <p style={{ fontWeight: 700, fontSize: "14px" }}>{tr("inventory.count.sheet.title")}</p>
        <p>{heading}</p>
        <p>
          {tr("inventory.count.sheet.printed", { date: printedAt })} ·{" "}
          {tr("inventory.count.sheet.items", { count: rows.length })}
        </p>
      </header>
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>{tr("inventory.count.category")}</th>
            <th>{tr("inventory.count.sheet.item")}</th>
            <th>SKU</th>
            <th>{tr("inventory.count.sheet.barcode")}</th>
            {showExpected ? <th className="num">{tr("inventory.count.column.expected")}</th> : null}
            <th className="blank">{tr("inventory.count.column.counted")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.sku}|${index}`} data-testid="sheet-row">
              <td className="num">{index + 1}</td>
              <td>{row.category ?? "—"}</td>
              <td>{row.name}</td>
              <td>
                <bdi>{row.sku}</bdi>
              </td>
              <td>{row.barcode ? <bdi>{row.barcode}</bdi> : "—"}</td>
              {showExpected ? <td className="num">{row.expected}</td> : null}
              <td className="blank" />
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: "8mm" }}>
        {tr("inventory.count.sheet.countedBy")}: ____________________ &nbsp; {tr("inventory.count.sheet.date")}:
        ____________
      </p>
    </article>
  );
}
