"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { QtyUnit } from "@/lib/quantity";
import { recordOpeningAction } from "../actions";
import { errorMessageKey, openingRowsToSave, plain, safeAction, type ItemRef } from "../_lib/form";

/** A KG row's quantity is typed in kg (weighed-selling-spec W7). */
export type OpeningRow = { ref: ItemRef; name: string; variantName: string | null; sku: string; unitType: QtyUnit };

type Props = { locale: Locale; branchId: string; rows: OpeningRow[]; truncated: boolean };

const keyOf = (ref: ItemRef) => `${ref.productId}|${ref.variantId ?? ""}`;

/**
 * Opening-stock grid (UX §2.5). One Save is one transaction on the server. Blank rows are
 * skipped; a row that already has stock at this branch is reported and must be removed.
 */
export function OpeningGrid({ locale, branchId, rows, truncated }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());

  async function save(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const { lines, invalid: bad } = openingRowsToSave(
      rows.map((row) => ({ ref: row.ref, raw: values[keyOf(row.ref)] ?? "", unitType: row.unitType })),
    );
    setInvalid(new Set(bad.map(keyOf)));
    if (bad.length > 0) {
      setMessage({ kind: "error", text: tr("inventory.opening.invalid") });
      return;
    }
    if (lines.length === 0) {
      setMessage({ kind: "error", text: tr("inventory.opening.empty") });
      return;
    }
    setPending(true);
    const result = await safeAction(() => recordOpeningAction({ branchId, lines }));
    setPending(false);
    if (result.ok) {
      setMessage({ kind: "ok", text: tr("inventory.opening.success", { count: lines.length }) });
      setValues({});
      router.refresh();
      return;
    }
    const refs = (result.error.details as { refs?: ItemRef[] } | null)?.refs ?? [];
    setInvalid(new Set(refs.map(keyOf)));
    setMessage({ kind: "error", text: plain(locale, errorMessageKey(result.error)) });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <p className="text-muted">{tr("inventory.opening.help")}</p>
      {rows.length === 0 ? (
        <p>{tr("inventory.opening.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {rows.map((row) => {
                const key = keyOf(row.ref);
                const bad = invalid.has(key);
                return (
                  <tr key={key}>
                    <td>
                      {row.name}
                      {row.variantName ? ` — ${row.variantName}` : ""}{" "}
                      <span dir="ltr" className="text-muted">
                        {row.sku}
                      </span>
                    </td>
                    <td>
                      <input
                        dir="ltr"
                        inputMode={row.unitType === "KG" ? "decimal" : "numeric"}
                        placeholder={row.unitType === "KG" ? "0.000" : undefined}
                        aria-label={`${row.name} ${tr("inventory.adjust.qty")}`}
                        aria-invalid={bad || undefined}
                        value={values[key] ?? ""}
                        onChange={(e) => setValues((current) => ({ ...current, [key]: e.target.value }))}
                        className={`input min-h-9 w-28 px-2 py-1 ${bad ? "border-danger" : ""}`}
                      />
                    </td>
                    {bad ? <td className="text-danger">{tr("inventory.opening.taken")}</td> : <td />}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {truncated ? <p className="text-muted">{tr("inventory.opening.truncated", { count: rows.length })}</p> : null}
      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "text-danger" : ""}
        >
          {message.text}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <button type="submit" disabled={pending} className="btn btn-primary self-start">
          {tr("inventory.opening.save")}
        </button>
      ) : null}
    </form>
  );
}
