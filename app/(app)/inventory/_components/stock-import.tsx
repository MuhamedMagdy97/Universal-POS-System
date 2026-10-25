"use client";

import Link from "next/link";
import { useState, useTransition, type ChangeEvent } from "react";
import type { ErrorBody } from "@/lib/errors";
import { translator, type Locale } from "@/lib/i18n";
import { formatQty } from "@/lib/quantity";
import type { StockImportPreview } from "@/modules/inventory/import";
import { STOCK_IMPORT_MODES, type StockImportMode } from "@/modules/inventory/schemas";
import { importStockAction, previewStockImportAction } from "../actions";
import { errorMessageKey, plain, safeAction } from "../_lib/form";

/** Server Action bodies are capped at 1 MB; refuse bigger files before sending them. */
const MAX_FILE_BYTES = 900_000;

function fileErrorMessage(body: ErrorBody, locale: Locale): string {
  const tr = translator(locale);
  const details = (body.details ?? {}) as Record<string, unknown>;
  const column = String(details.column ?? "");
  // The file-shape messages are shared with the product import.
  switch (details.reason) {
    case "CSV_TOO_LARGE":
      return tr("catalog.import.fileError.tooLarge");
    case "CSV_MALFORMED":
      return tr("catalog.import.fileError.malformed");
    case "CSV_EMPTY":
      return tr("inventory.import.fileError.empty");
    case "CSV_TOO_MANY_ROWS":
      return tr("catalog.import.fileError.tooManyRows", { max: String(details.max ?? "") });
    case "CSV_MISSING_COLUMN":
      return tr("catalog.import.fileError.missingColumn", { column });
    case "CSV_UNKNOWN_COLUMN":
      return tr("catalog.import.fileError.unknownColumn", { column });
    case "CSV_HAS_ERRORS":
      return tr("inventory.import.fileError.hasErrors");
    case "MANAGED_BY_INVENTORY":
      return tr("managed.stock");
  }
  return plain(locale, errorMessageKey(body));
}

/**
 * Pick a mode and a CSV → per-row preview against the branch → apply (one transaction). The
 * import id is fixed per checked file, so a repeated click or retry cannot apply it twice.
 */
export function StockImport({ locale, branchId }: { locale: Locale; branchId: string }) {
  const tr = translator(locale);
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<StockImportMode>("opening");
  const [csv, setCsv] = useState("");
  const [importId, setImportId] = useState("");
  const [preview, setPreview] = useState<StockImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

  function check(text: string, nextMode: StockImportMode) {
    setPreview(null);
    setError(null);
    setApplied(null);
    setImportId(crypto.randomUUID());
    startTransition(async () => {
      const result = await safeAction(() => previewStockImportAction({ branchId, mode: nextMode, csv: text }));
      if (result.ok) setPreview(result.data);
      else setError(fileErrorMessage(result.error, locale));
    });
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setPreview(null);
    setApplied(null);
    setError(null);
    setCsv("");
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(tr("catalog.import.fileError.tooLarge"));
      return;
    }
    const text = await file.text();
    setCsv(text);
    check(text, mode);
  }

  function onMode(next: StockImportMode) {
    setMode(next);
    if (csv) check(csv, next);
  }

  function onConfirm() {
    startTransition(async () => {
      const result = await safeAction(() => importStockAction({ branchId, mode, csv, importId }));
      if (!result.ok) {
        setError(fileErrorMessage(result.error, locale));
        return;
      }
      setPreview(null);
      setApplied(result.data.applied);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-wrap gap-4" disabled={pending}>
        <legend className="mb-1 text-sm">{tr("inventory.import.mode")}</legend>
        {STOCK_IMPORT_MODES.map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input type="radio" name="mode" checked={mode === value} onChange={() => onMode(value)} />
            {tr(`inventory.import.mode.${value}`)}
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-muted">{tr(`inventory.import.help.${mode}`)}</p>
      <label className="field">
        <span className="text-sm">{tr("catalog.import.file")}</span>
        <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={pending} />
      </label>

      {pending ? <p aria-live="polite">{tr("catalog.import.checking")}</p> : null}
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      {applied !== null ? (
        <div role="status" className="card flex flex-wrap items-center gap-3 p-4">
          <span>{tr("inventory.import.done", { count: applied })}</span>
          <Link href={`/inventory?branch=${branchId}`} className="underline">
            {tr("inventory.import.viewStock")}
          </Link>
        </div>
      ) : null}

      {preview ? (
        <>
          <p className="font-medium">
            {tr("catalog.import.summary", { valid: preview.validCount, errors: preview.errorCount })}
          </p>
          {preview.errorCount > 0 ? (
            <p className="text-sm text-danger">{tr("inventory.import.fixErrors")}</p>
          ) : (
            <button type="button" onClick={onConfirm} disabled={pending} className="btn btn-primary self-start">
              {tr("inventory.import.confirm", { count: preview.validCount })}
            </button>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr("catalog.import.column.row")}</th>
                  <th>{tr("inventory.import.column.code")}</th>
                  <th>{tr("inventory.import.column.item")}</th>
                  <th>{tr("inventory.import.column.qty")}</th>
                  <th>{tr("inventory.import.column.after")}</th>
                  <th>{tr("catalog.import.column.problems")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.line}>
                    <td className="tabular-nums">{row.line}</td>
                    <td dir="ltr">
                      <bdi className="font-mono">{row.code}</bdi>
                    </td>
                    <td>{row.name ?? ""}</td>
                    <td className="tabular-nums" dir="ltr">
                      {row.qty === null
                        ? ""
                        : `${mode === "adjustment" && row.qty > 0 ? "+" : ""}${formatQty(row.qty, row.unitType, locale)}`}
                    </td>
                    <td className="tabular-nums" dir="ltr">
                      {row.after === null ? "" : formatQty(row.after, row.unitType, locale)}
                    </td>
                    <td>
                      {row.errors.length === 0 ? (
                        <span className="text-success">{tr("catalog.import.rowOk")}</span>
                      ) : (
                        <ul className="text-danger">
                          {row.errors.map((e, i) => {
                            const message = tr(`inventory.import.error.${e.code}`);
                            return (
                              <li key={i}>
                                {e.column ? tr("catalog.import.withColumn", { column: e.column, message }) : message}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
