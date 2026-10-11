"use client";

import { useState, useTransition } from "react";
import { translator, type Locale } from "@/lib/i18n";
import type { CurrencyCode } from "@/lib/money";
import type { ProductDetail } from "@/modules/catalog/schemas";
import { archiveVariantAction, restoreVariantAction } from "../actions";
import { mapErrorBody } from "../_lib/form-errors";
import { otherCodesThan, type ProductFormState, type VariantRow } from "../_lib/product-form-model";
import { BarcodeInput } from "./barcode-input";
import { StatusBadge } from "./shell";

type Props = {
  locale: Locale;
  currency: CurrencyCode;
  state: ProductFormState;
  errors: Record<string, string>;
  canSeeCost: boolean;
  readOnly: boolean;
  disabled: boolean;
  product?: ProductDetail;
  onChange: (rows: VariantRow[]) => void;
  onAdd: () => void;
  onRecordChanged: (product: ProductDetail) => void;
};

const inputClass = "rounded-md border border-border px-3 py-2 disabled:opacity-70";

/**
 * Variants: name, Arabic name, SKU, optional price/cost override (blank =
 * inherit from the product) and their own barcodes. Existing variants are
 * archived/restored immediately; new rows are created on Save.
 */
export function VariantRows(props: Props) {
  const { locale, currency, state, errors, canSeeCost, readOnly, disabled, product, onChange, onAdd } = props;
  const tr = translator(locale);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function patch(index: number, changes: Partial<VariantRow>) {
    onChange(state.variants.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  }

  function toggleArchived(row: VariantRow) {
    if (!product || !row.id || !row.expectedUpdatedAt) return;
    const variantId = row.id;
    const input = { expectedUpdatedAt: row.expectedUpdatedAt };
    startTransition(async () => {
      const result = row.isActive
        ? await archiveVariantAction(product.id, variantId, input)
        : await restoreVariantAction(product.id, variantId, input);
      if (!result.ok) {
        setMessage(mapErrorBody(result.error, tr).summary);
        return;
      }
      setMessage(null);
      props.onRecordChanged(result.data);
    });
  }

  const field = (index: number, name: string) => `variants.${index}.${name}`;
  const invalid = (path: string) => (errors[path] ? true : undefined);
  const err = (path: string) =>
    errors[path] ? (
      <span id={`pf-${path}-error`} className="text-sm text-red-700">
        {errors[path]}
      </span>
    ) : null;

  return (
    <section aria-labelledby="pf-variants-title" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 id="pf-variants-title" className="text-lg font-semibold">
          {tr("catalog.form.variants")}
        </h2>
        {readOnly ? null : (
          <button
            type="button"
            onClick={onAdd}
            disabled={disabled}
            className="rounded-md border border-border px-3 py-1 text-sm"
          >
            {tr("catalog.form.variantAdd")}
          </button>
        )}
      </div>
      <p className="text-sm text-muted">
        {state.variants.length === 0 ? tr("catalog.form.variantsEmpty") : tr("catalog.form.variantsHint")}
      </p>
      {message ? (
        <p role="alert" className="text-sm text-red-700">
          {message}
        </p>
      ) : null}

      {state.variants.map((row, index) => (
        <fieldset
          key={row.key}
          disabled={readOnly}
          className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
        >
          <legend className="flex items-center gap-2 px-1 text-sm">
            <span>
              {tr("catalog.form.variantName")} #{index + 1}
            </span>
            {row.id ? <StatusBadge locale={locale} active={row.isActive} /> : null}
          </legend>
          <label className="flex flex-col gap-1">
            <span>{tr("catalog.form.variantName")}</span>
            <input
              id={`pf-${field(index, "name")}`}
              value={row.name}
              onChange={(e) => patch(index, { name: e.target.value })}
              maxLength={120}
              aria-invalid={invalid(field(index, "name"))}
              className={inputClass}
            />
            {err(field(index, "name"))}
          </label>
          <label className="flex flex-col gap-1">
            <span>{tr("catalog.form.nameAr")}</span>
            <input
              id={`pf-${field(index, "nameAr")}`}
              value={row.nameAr}
              onChange={(e) => patch(index, { nameAr: e.target.value })}
              maxLength={120}
              dir="rtl"
              lang="ar"
              aria-invalid={invalid(field(index, "nameAr"))}
              className={inputClass}
            />
            {err(field(index, "nameAr"))}
          </label>
          <label className="flex flex-col gap-1">
            <span>{tr("catalog.form.sku")}</span>
            <input
              id={`pf-${field(index, "sku")}`}
              value={row.sku}
              onChange={(e) => patch(index, { sku: e.target.value })}
              maxLength={64}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid(field(index, "sku"))}
              className={`${inputClass} font-mono uppercase`}
            />
            {err(field(index, "sku"))}
          </label>
          <label className="flex flex-col gap-1">
            <span>
              {tr("catalog.form.price")} ({currency})
            </span>
            <input
              id={`pf-${field(index, "priceMinor")}`}
              value={row.price}
              onChange={(e) => patch(index, { price: e.target.value })}
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              placeholder={tr("catalog.form.inherit")}
              aria-invalid={invalid(field(index, "priceMinor"))}
              className={`${inputClass} tabular-nums`}
            />
            {err(field(index, "priceMinor"))}
          </label>
          {canSeeCost ? (
            <label className="flex flex-col gap-1">
              <span>
                {tr("catalog.form.cost")} ({currency})
              </span>
              <input
                id={`pf-${field(index, "costMinor")}`}
                value={row.cost}
                onChange={(e) => patch(index, { cost: e.target.value })}
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                placeholder={tr("catalog.form.inherit")}
                aria-invalid={invalid(field(index, "costMinor"))}
                className={`${inputClass} tabular-nums`}
              />
              {err(field(index, "costMinor"))}
            </label>
          ) : null}
          <div className="flex flex-col gap-1 sm:col-span-2">
            <span>{tr("catalog.form.barcodes")}</span>
            <BarcodeInput
              locale={locale}
              path={field(index, "barcodes")}
              codes={row.barcodes}
              otherCodes={otherCodesThan(state, field(index, "barcodes"))}
              errors={errors}
              disabled={disabled}
              onChange={(codes) => patch(index, { barcodes: codes })}
            />
          </div>
          {readOnly ? null : (
            <div className="flex gap-2 sm:col-span-2">
              {row.id ? (
                <button
                  type="button"
                  onClick={() => toggleArchived(row)}
                  disabled={pending || disabled}
                  className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-60"
                >
                  {row.isActive ? tr("catalog.archive.action") : tr("catalog.restore.action")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onChange(state.variants.filter((_, i) => i !== index))}
                  className="rounded-md border border-border px-3 py-1 text-sm"
                >
                  {tr("catalog.form.variantRemove")}
                </button>
              )}
            </div>
          )}
        </fieldset>
      ))}
    </section>
  );
}
