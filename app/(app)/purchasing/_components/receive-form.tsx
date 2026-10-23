"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { CurrencyCode } from "@/lib/money";
import { receivePoAction } from "../actions";
import {
  costText,
  errorKey,
  parseCost,
  parseQty,
  plain,
  receiptLines,
  safeAction,
  type ReceiveRow,
} from "../_lib/purchasing";

type Line = { poItemId: string; name: string; sku: string; outstanding: number; unitCostMinor: number };

type Props = { locale: Locale; currency: CurrencyCode; poId: string; lines: Line[] };

/**
 * Receiving (UX §1). Quantities start at what is outstanding and costs at the PO cost. One
 * Idempotency-Key per form, kept across retries (R1), so a double submit never receives twice.
 */
export function ReceiveForm({ locale, currency, poId, lines }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<ReceiveRow[]>(() =>
    lines.map((line) => ({
      poItemId: line.poItemId,
      outstanding: line.outstanding,
      qty: String(line.outstanding),
      cost: costText(line.unitCostMinor, currency),
      poCostMinor: line.unitCostMinor,
    })),
  );
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = receiptLines(rows, currency);
  const units = parsed?.reduce((total, line) => total + line.qty, 0) ?? 0;

  function update(index: number, patch: Partial<ReceiveRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function fill(all: boolean) {
    setRows((current) => current.map((row) => ({ ...row, qty: all ? String(row.outstanding) : "0" })));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed || parsed.length === 0) {
      setError(tr("purchasing.error.NOTHING_TO_RECEIVE"));
      return;
    }
    setPending(true);
    const result = await safeAction(() =>
      receivePoAction(poId, key, { lines: parsed, note: note.trim() || undefined }),
    );
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, errorKey(result.error)));
      router.refresh();
      return;
    }
    router.push(`/purchasing/${poId}?received=1`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex gap-2">
        <button type="button" onClick={() => fill(true)} className="btn btn-sm">
          {tr("purchasing.receive.all")}
        </button>
        <button type="button" onClick={() => fill(false)} className="btn btn-sm">
          {tr("purchasing.receive.none")}
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr className="text-sm text-muted">
              <th>{tr("purchasing.line.item")}</th>
              <th className="text-end">{tr("purchasing.line.outstanding")}</th>
              <th className="text-start">{tr("purchasing.receive.qty")}</th>
              <th className="text-start">{tr("purchasing.line.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const row = rows[index];
              const qty = parseQty(row.qty);
              return (
                <tr key={line.poItemId}>
                  <td>
                    {line.name}{" "}
                    <span dir="ltr" className="text-muted">
                      {line.sku}
                    </span>
                  </td>
                  <td className="text-end" dir="ltr">
                    {line.outstanding}
                  </td>
                  <td>
                    <input
                      dir="ltr"
                      inputMode="numeric"
                      aria-label={`${tr("purchasing.receive.qty")} ${line.sku}`}
                      aria-invalid={qty === null || qty > line.outstanding}
                      value={row.qty}
                      onChange={(e) => update(index, { qty: e.target.value })}
                      className="input min-h-9 w-24 px-2 py-1"
                    />
                  </td>
                  <td>
                    <input
                      dir="ltr"
                      inputMode="decimal"
                      aria-label={`${tr("purchasing.line.cost")} ${line.sku}`}
                      aria-invalid={parseCost(row.cost, currency) === null}
                      value={row.cost}
                      onChange={(e) => update(index, { cost: e.target.value })}
                      className="input min-h-9 w-28 px-2 py-1"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className="field">
        <span>{tr("purchasing.receive.note")}</span>
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="input" />
      </label>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending || !parsed || units === 0} className="btn btn-primary self-start">
        {tr("purchasing.receive.submit", { units })}
      </button>
    </form>
  );
}
