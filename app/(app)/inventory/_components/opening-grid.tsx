"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { recordOpeningAction } from "../actions";
import { errorMessageKey, openingRowsToSave, plain, safeAction, type ItemRef } from "../_lib/form";

export type OpeningRow = { ref: ItemRef; name: string; variantName: string | null; sku: string };

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
      rows.map((row) => ({ ref: row.ref, raw: values[keyOf(row.ref)] ?? "" })),
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
        <table className="w-full text-start">
          <tbody>
            {rows.map((row) => {
              const key = keyOf(row.ref);
              const bad = invalid.has(key);
              return (
                <tr key={key} className="border-t border-border">
                  <td className="py-2">
                    {row.name}
                    {row.variantName ? ` — ${row.variantName}` : ""}{" "}
                    <span dir="ltr" className="text-muted">
                      {row.sku}
                    </span>
                  </td>
                  <td>
                    <input
                      dir="ltr"
                      inputMode="numeric"
                      aria-label={`${row.name} ${tr("inventory.adjust.qty")}`}
                      aria-invalid={bad || undefined}
                      value={values[key] ?? ""}
                      onChange={(e) => setValues((current) => ({ ...current, [key]: e.target.value }))}
                      className={`w-28 rounded-md border bg-background px-2 py-1 ${bad ? "border-red-700" : "border-border"}`}
                    />
                  </td>
                  {bad ? <td className="text-red-700">{tr("inventory.opening.taken")}</td> : <td />}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {truncated ? <p className="text-muted">{tr("inventory.opening.truncated", { count: rows.length })}</p> : null}
      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "text-red-700" : ""}
        >
          {message.text}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
        >
          {tr("inventory.opening.save")}
        </button>
      ) : null}
    </form>
  );
}
