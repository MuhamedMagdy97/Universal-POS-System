"use client";

import Link from "next/link";
import { useState, useTransition, type ChangeEvent } from "react";
import type { ErrorBody } from "@/lib/errors";
import { translator, type Locale } from "@/lib/i18n";
import type { ImportPreview } from "@/modules/catalog/import";
import { importProductsAction, previewImportAction } from "../actions";
import { mapErrorBody, type Translate } from "../_lib/form-errors";

/** Server Action bodies are capped at 1 MB; refuse bigger files before sending them. */
const MAX_FILE_BYTES = 900_000;

function fileErrorMessage(body: ErrorBody, tr: Translate): string {
  const details = (body.details ?? {}) as Record<string, unknown>;
  const column = String(details.column ?? "");
  switch (details.reason) {
    case "CSV_TOO_LARGE":
      return tr("catalog.import.fileError.tooLarge");
    case "CSV_MALFORMED":
      return tr("catalog.import.fileError.malformed");
    case "CSV_EMPTY":
      return tr("catalog.import.fileError.empty");
    case "CSV_TOO_MANY_ROWS":
      return tr("catalog.import.fileError.tooManyRows", { max: String(details.max ?? "") });
    case "CSV_MISSING_COLUMN":
      return tr("catalog.import.fileError.missingColumn", { column });
    case "CSV_UNKNOWN_COLUMN":
      return tr("catalog.import.fileError.unknownColumn", { column });
    case "CSV_HAS_ERRORS":
      return tr("catalog.import.fileError.hasErrors");
    case "MANAGED_BY_INVENTORY":
      return tr("managed.catalog");
  }
  const mapped = mapErrorBody(body, tr);
  return Object.values(mapped.fields)[0] ?? mapped.summary ?? tr("catalog.form.error.generic");
}

/** Upload a CSV → preview with per-row errors → confirm (all rows in one transaction). */
export function ProductImport({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  const [pending, startTransition] = useTransition();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setPreview(null);
    setError(null);
    setCreated(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(tr("catalog.import.fileError.tooLarge"));
      return;
    }
    const text = await file.text();
    setCsv(text);
    startTransition(async () => {
      const result = await previewImportAction(text);
      if (result.ok) setPreview(result.data);
      else setError(fileErrorMessage(result.error, tr));
    });
  }

  function onConfirm() {
    startTransition(async () => {
      const result = await importProductsAction(csv);
      if (!result.ok) {
        setError(fileErrorMessage(result.error, tr));
        return;
      }
      setPreview(null);
      setCreated(result.data.created);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{tr("catalog.import.help")}</p>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{tr("catalog.import.file")}</span>
        <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={pending} />
      </label>

      {pending ? <p aria-live="polite">{tr("catalog.import.checking")}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {created !== null ? (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-border p-4">
          <span>{tr("catalog.import.done", { count: created })}</span>
          <Link href="/catalog/products" className="underline">
            {tr("catalog.import.viewProducts")}
          </Link>
        </div>
      ) : null}

      {preview ? (
        <>
          <p className="font-medium">
            {tr("catalog.import.summary", { valid: preview.validCount, errors: preview.errorCount })}
          </p>
          {preview.errorCount > 0 ? (
            <p className="text-sm text-red-700">{tr("catalog.import.fixErrors")}</p>
          ) : (
            <button
              type="button"
              onClick={onConfirm}
              disabled={pending}
              className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-60"
            >
              {tr("catalog.import.confirm", { count: preview.validCount })}
            </button>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-start font-medium">{tr("catalog.import.column.row")}</th>
                  <th className="px-2 py-2 text-start font-medium">{tr("catalog.products.column.name")}</th>
                  <th className="px-2 py-2 text-start font-medium">{tr("catalog.products.column.sku")}</th>
                  <th className="px-2 py-2 text-start font-medium">{tr("catalog.import.column.problems")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.line} className="border-b border-border">
                    <td className="px-2 py-2 tabular-nums">{row.line}</td>
                    <td className="px-2 py-2">{row.name}</td>
                    <td className="px-2 py-2" dir="ltr">
                      <bdi className="font-mono">{row.sku}</bdi>
                    </td>
                    <td className="px-2 py-2">
                      {row.errors.length === 0 ? (
                        <span className="text-green-800">{tr("catalog.import.rowOk")}</span>
                      ) : (
                        <ul className="text-red-700">
                          {row.errors.map((e, i) => {
                            const message = tr(`catalog.import.error.${e.code}`);
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
