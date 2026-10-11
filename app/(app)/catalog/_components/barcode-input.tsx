"use client";

import { useState, type KeyboardEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { addBarcodeChip, removeBarcodeChip } from "../_lib/form-helpers";

type Props = {
  locale: Locale;
  /** Form field path, e.g. "barcodes" or "variants.0.barcodes"; also the input id suffix. */
  path: string;
  codes: string[];
  /** Codes used elsewhere in the form (duplicates are rejected inline). */
  otherCodes: string[];
  /** Server errors keyed by field path ("barcodes.1" marks that chip). */
  errors: Record<string, string>;
  disabled?: boolean;
  onChange: (codes: string[]) => void;
};

/**
 * Scanner-friendly barcode entry: a keyboard-wedge scanner types the code and
 * sends Enter, which adds a chip, clears the field and keeps focus (C-4).
 * Duplicates within the form and invalid codes are rejected inline (C-19).
 */
export function BarcodeInput({ locale, path, codes, otherCodes, errors, disabled, onChange }: Props) {
  const tr = translator(locale);
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  function add() {
    const result = addBarcodeChip(codes, draft, otherCodes);
    if (result.error === "duplicate") setLocalError(tr("catalog.conflict.barcodeDuplicateInForm"));
    else if (result.error === "invalid") setLocalError(tr("catalog.form.error.barcodeInvalid"));
    else {
      setLocalError(null);
      setDraft("");
      if (result.added) onChange(result.codes);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // Never submit the whole form on a scan.
      event.preventDefault();
      add();
    }
  }

  const fieldError = errors[path];
  const chipErrors = codes.map((_, index) => errors[`${path}.${index}`]).filter(Boolean);
  const message = localError ?? fieldError ?? chipErrors[0] ?? null;
  const errorId = `pf-${path}-error`;

  return (
    <div className="flex flex-col gap-2">
      {codes.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={tr("catalog.form.barcodes")}>
          {codes.map((code, index) => {
            const invalid = Boolean(errors[`${path}.${index}`]);
            return (
              <li
                key={code}
                className={`flex items-center gap-1 rounded-full border px-3 py-1 text-sm ${
                  invalid ? "border-red-600 text-red-700" : "border-border"
                }`}
              >
                <bdi dir="ltr" className="font-mono">
                  {code}
                </bdi>
                {disabled ? null : (
                  <button
                    type="button"
                    onClick={() => onChange(removeBarcodeChip(codes, code))}
                    aria-label={tr("catalog.form.barcodeRemove", { code })}
                    className="ms-1 rounded-full px-1 leading-none"
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {disabled ? null : (
        <div className="flex gap-2">
          <input
            id={`pf-${path}`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setLocalError(null);
            }}
            onKeyDown={onKeyDown}
            dir="ltr"
            inputMode="text"
            autoComplete="off"
            maxLength={64}
            placeholder={tr("catalog.form.barcodePlaceholder")}
            aria-label={tr("catalog.form.barcodePlaceholder")}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? errorId : undefined}
            className="min-w-0 flex-1 rounded-md border border-border px-3 py-2 font-mono"
          />
          <button type="button" onClick={add} className="rounded-md border border-border px-3 py-2">
            {tr("catalog.form.barcodeAdd")}
          </button>
        </div>
      )}
      {message ? (
        <p id={errorId} className="text-sm text-red-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}
