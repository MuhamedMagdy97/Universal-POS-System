"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { formatMinor, type CurrencyCode } from "@/lib/money";
import { PURCHASE_RETURN_REASONS, type PurchaseReturnReason } from "@/modules/purchasing/schemas";
import { returnDirectAction, returnPoAction } from "../actions";
import { errorKey, parseQty, plain, returnLines, safeAction, type ReturnRow } from "../_lib/purchasing";

/** `lineId` is the PO line, or the receipt line for a direct receipt. */
type Line = { lineId: string; name: string; sku: string; returnable: number; unitCostMinor: number };

/** What the goods go back against: a PO, or a direct receipt (direct-receipt-returns-spec DR11). */
type Source = { kind: "po"; id: string } | { kind: "receipt"; id: string };

type Props = { locale: Locale; currency: CurrencyCode; source: Source; lines: Line[] };

/**
 * Return to supplier (purchase-returns-spec R13). Quantities start at 0; cost is the PO's (or the
 * receipt's) and not editable (R4). One Idempotency-Key per form, kept across retries, so a double
 * submit never returns twice.
 */
export function ReturnForm({ locale, currency, source, lines }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<ReturnRow[]>(() =>
    lines.map((line) => ({ lineId: line.lineId, returnable: line.returnable, qty: "0" })),
  );
  const [reason, setReason] = useState<PurchaseReturnReason>("DAMAGED");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = returnLines(rows);
  const units = parsed?.reduce((total, line) => total + line.qty, 0) ?? 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed || parsed.length === 0) {
      setError(tr("purchasing.error.NOTHING_TO_RETURN"));
      return;
    }
    setPending(true);
    const base = { reason, note: note.trim() || undefined };
    const result = await safeAction(() =>
      source.kind === "po"
        ? returnPoAction(source.id, key, {
            ...base,
            lines: parsed.map((line) => ({ poItemId: line.lineId, qty: line.qty })),
          })
        : returnDirectAction(source.id, key, {
            ...base,
            lines: parsed.map((line) => ({ goodsReceiptItemId: line.lineId, qty: line.qty })),
          }),
    );
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, errorKey(result.error)));
      router.refresh();
      return;
    }
    const at = source.kind === "po" ? `/purchasing/${source.id}` : `/purchasing/receipts/${source.id}`;
    router.push(`${at}/returns/${result.data.returnId}?returned=1`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-muted">
        {tr(source.kind === "po" ? "purchasing.return.hint" : "purchasing.receiptReturn.hint")}
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr className="text-sm text-muted">
              <th>{tr("purchasing.line.item")}</th>
              <th className="text-end">{tr("purchasing.line.returnable")}</th>
              <th className="text-end">{tr("purchasing.line.cost")}</th>
              <th className="text-start">{tr("purchasing.return.qty")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const row = rows[index];
              const qty = parseQty(row.qty);
              return (
                <tr key={line.lineId}>
                  <td>
                    {line.name}{" "}
                    <span dir="ltr" className="text-muted">
                      {line.sku}
                    </span>
                  </td>
                  <td className="text-end" dir="ltr">
                    {line.returnable}
                  </td>
                  <td className="text-end">{formatMinor(line.unitCostMinor, currency, locale)}</td>
                  <td>
                    <input
                      dir="ltr"
                      inputMode="numeric"
                      aria-label={`${tr("purchasing.return.qty")} ${line.sku}`}
                      aria-invalid={qty === null || qty > line.returnable}
                      value={row.qty}
                      onChange={(e) =>
                        setRows((current) => current.map((r, i) => (i === index ? { ...r, qty: e.target.value } : r)))
                      }
                      className="input min-h-9 w-24 px-2 py-1"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className="field">
        <span>{tr("purchasing.return.reason")}</span>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as PurchaseReturnReason)}
          className="input self-start"
        >
          {PURCHASE_RETURN_REASONS.map((value) => (
            <option key={value} value={value}>
              {tr(`purchasing.reason.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{tr("purchasing.return.note")}</span>
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="input" />
      </label>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending || !parsed || units === 0} className="btn btn-primary self-start">
        {tr("purchasing.return.submit", { units })}
      </button>
    </form>
  );
}
