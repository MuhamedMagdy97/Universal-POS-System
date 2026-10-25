"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { CurrencyCode } from "@/lib/money";
import { VAT_CATEGORY_VALUES, type ProductDetail, type UnitType, type VatCategory } from "@/modules/catalog/schemas";
import { createProductAction, updateProductAction } from "../actions";
import { mapErrorBody, NO_ERRORS, type FormErrors } from "../_lib/form-errors";
import { formShortcut } from "../_lib/form-helpers";
import {
  buildCreatePayload,
  buildUpdatePayload,
  emptyFormState,
  emptyVariantRow,
  formStateFromProduct,
  otherCodesThan,
  priceBelowCost,
  type ProductFormState,
  type VariantRow,
} from "../_lib/product-form-model";
import { BarcodeInput } from "./barcode-input";
import { ProductArchiveControls } from "./product-archive-controls";
import { VariantRows } from "./variant-rows";

export type CategoryOption = { id: string; label: string; isActive: boolean };

type Props = {
  locale: Locale;
  currency: CurrencyCode;
  categories: CategoryOption[];
  canSeeCost: boolean;
  readOnly: boolean;
  /** Absent on /catalog/products/new. */
  product?: ProductDetail;
  /** Notices carried over from a redirect (create → edit). */
  initialNotice?: { saved?: boolean; priceBelowCost?: boolean };
};

const inputClass = "input";

export function ProductForm({ locale, currency, categories, canSeeCost, readOnly, product, initialNotice }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState<ProductDetail | undefined>(product);
  const initial = useMemo(
    () => (product ? formStateFromProduct(product, currency) : emptyFormState()),
    [product, currency],
  );
  const [state, setState] = useState<ProductFormState>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [saved, setSaved] = useState(Boolean(initialNotice?.saved));
  const [serverBelowCost, setServerBelowCost] = useState(Boolean(initialNotice?.priceBelowCost));
  const [focusErrors, setFocusErrors] = useState(0);
  const nextKey = useRef(0);

  const dirty = JSON.stringify(state) !== baseline;
  const isEdit = Boolean(current);
  const disabled = readOnly || pending;

  // Focus the first invalid field after a failed save (summary stays in the role="alert" region).
  useEffect(() => {
    if (focusErrors === 0) return;
    const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.focus();
  }, [focusErrors]);

  // Ctrl/Cmd+S saves, Esc cancels (confirm if dirty). An open <dialog> handles its own Esc.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = formShortcut(event);
      if (!action || document.querySelector("dialog[open]")) return;
      if (action === "save") {
        event.preventDefault();
        if (!readOnly && !pending) formRef.current?.requestSubmit();
      } else {
        event.preventDefault();
        if (!dirty || window.confirm(tr("catalog.form.discardConfirm"))) router.push("/catalog/products");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, pending, readOnly, router, tr]);

  function update<K extends keyof ProductFormState>(key: K, value: ProductFormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
    setSaved(false);
  }

  function showErrors(next: FormErrors) {
    setErrors(next);
    setFocusErrors((n) => n + 1);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || pending) return;
    const options = {
      currency,
      canSeeCost,
      messages: { required: tr("catalog.form.error.required"), invalidAmount: tr("catalog.form.error.invalidAmount") },
    };
    const built = current ? buildUpdatePayload(state, current.updatedAt, options) : buildCreatePayload(state, options);
    if (!built.ok) {
      showErrors({ fields: built.fields, summary: tr("catalog.form.errorSummary"), stale: false });
      return;
    }
    setErrors(NO_ERRORS);
    startTransition(async () => {
      const result = current
        ? await updateProductAction(current.id, built.payload)
        : await createProductAction(built.payload);
      if (!result.ok) {
        showErrors(mapErrorBody(result.error, tr));
        return;
      }
      const below = result.data.warnings.includes("PRICE_BELOW_COST");
      if (!current) {
        const params = new URLSearchParams({ saved: "1", ...(below ? { warn: "PRICE_BELOW_COST" } : {}) });
        router.push(`/catalog/products/${result.data.product.id}?${params}`);
        return;
      }
      const fresh = formStateFromProduct(result.data.product, currency);
      setCurrent(result.data.product);
      setState(fresh);
      setBaseline(JSON.stringify(fresh));
      setSaved(true);
      setServerBelowCost(below);
    });
  }

  /** After archive/restore of the product or a variant: keep unsaved edits, refresh versions. */
  function onRecordChanged(next: ProductDetail) {
    setCurrent(next);
    setErrors(NO_ERRORS);
    setState((s) => ({
      ...s,
      variants: s.variants.map((row) => {
        const v = next.variants.find((nv) => nv.id === row.id);
        return v ? { ...row, isActive: v.isActive, expectedUpdatedAt: v.updatedAt } : row;
      }),
    }));
  }

  function setVariants(variants: VariantRow[]) {
    update("variants", variants);
  }

  function addVariant() {
    nextKey.current += 1;
    setVariants([...state.variants, emptyVariantRow(`new-${nextKey.current}`)]);
  }

  const fieldError = (path: string) => errors.fields[path];
  const describe = (path: string) => (fieldError(path) ? `pf-${path}-error` : undefined);
  const errorText = (path: string) =>
    fieldError(path) ? (
      <span id={`pf-${path}-error`} className="text-sm text-danger">
        {fieldError(path)}
      </span>
    ) : null;

  const priceChanged = isEdit && state.price !== initial.price;
  const belowCost = canSeeCost && (priceBelowCost(state, currency) || (serverBelowCost && !dirty));
  const categoryOptions = categories.filter((c) => c.isActive || c.id === state.categoryId);

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">
          {isEdit ? tr("catalog.form.editTitle") : tr("catalog.form.newTitle")}
        </h1>
        <Link href="/catalog/products" className="text-sm underline">
          {tr("catalog.state.backToList")}
        </Link>
      </div>

      {readOnly ? <p className="card p-3">{tr("catalog.form.readOnly")}</p> : null}
      {current && !current.isActive ? (
        <p className="rounded-lg border border-warning bg-warning-soft p-3 text-warning">
          {tr("catalog.archive.archivedNotice")}
        </p>
      ) : null}

      <div role="alert" aria-live="assertive">
        {errors.summary ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger bg-danger-soft p-3 text-danger">
            <span>{errors.summary}</span>
            {errors.stale ? (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="btn border-danger text-danger btn-sm"
              >
                {tr("catalog.form.reload")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div role="status" aria-live="polite">
        {saved ? <p className="text-success">{tr("catalog.form.saved")}</p> : null}
      </div>

      <fieldset disabled={readOnly} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="field">
          <span>{tr("catalog.form.name")}</span>
          <input
            id="pf-name"
            value={state.name}
            onChange={(e) => update("name", e.target.value)}
            maxLength={120}
            required
            autoFocus={!isEdit}
            aria-invalid={fieldError("name") ? true : undefined}
            aria-describedby={describe("name")}
            className={inputClass}
          />
          {errorText("name")}
        </label>
        <label className="field">
          <span>{tr("catalog.form.nameAr")}</span>
          <input
            id="pf-nameAr"
            value={state.nameAr}
            onChange={(e) => update("nameAr", e.target.value)}
            maxLength={120}
            dir="rtl"
            lang="ar"
            aria-invalid={fieldError("nameAr") ? true : undefined}
            aria-describedby={describe("nameAr")}
            className={inputClass}
          />
          {errorText("nameAr")}
        </label>
        <label className="field">
          <span>{tr("catalog.form.sku")}</span>
          <input
            id="pf-sku"
            value={state.sku}
            onChange={(e) => update("sku", e.target.value)}
            maxLength={64}
            required
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={fieldError("sku") ? true : undefined}
            aria-describedby={describe("sku")}
            className={`${inputClass} font-mono uppercase`}
          />
          {errorText("sku")}
        </label>
        <label className="field">
          <span>{tr("catalog.form.category")}</span>
          <select
            id="pf-categoryId"
            value={state.categoryId}
            onChange={(e) => update("categoryId", e.target.value)}
            aria-invalid={fieldError("categoryId") ? true : undefined}
            aria-describedby={describe("categoryId")}
            className={inputClass}
          >
            <option value="">{tr("catalog.category.none")}</option>
            {categoryOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.isActive ? c.label : `${c.label} (${tr("catalog.status.archived")})`}
              </option>
            ))}
          </select>
          {errorText("categoryId")}
        </label>
        <label className="field">
          <span>{tr("catalog.form.unit")}</span>
          {/* Immutable after creation; a KG product is priced per kg and has no variants (weighed-selling W2, W4). */}
          <select
            id="pf-unitType"
            value={state.unitType}
            disabled={isEdit || state.variants.length > 0}
            onChange={(e) => update("unitType", e.target.value as UnitType)}
            className={inputClass}
          >
            <option value="EACH">{tr("catalog.form.unit.each")}</option>
            <option value="KG" disabled={state.isService}>
              {tr("catalog.form.unit.kg")}
            </option>
          </select>
          {isEdit ? <span className="text-xs text-muted">{tr("catalog.form.unitHint")}</span> : null}
        </label>
        {/* A service holds no stock and has a duration (salon-spec S2); chosen on create only. */}
        <label className="flex items-center gap-2 self-end pb-2">
          <input
            type="checkbox"
            checked={state.isService}
            disabled={isEdit || state.unitType === "KG" || state.variants.length > 0}
            onChange={(e) => update("isService", e.target.checked)}
          />
          {tr("catalog.service.is")}
        </label>
        {state.isService ? (
          <label className="field">
            <span>{tr("catalog.service.duration")}</span>
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={state.duration}
              onChange={(e) => update("duration", e.target.value)}
            />
          </label>
        ) : null}
        <label className="field">
          <span>{tr("catalog.form.vatCategory")}</span>
          <select
            id="pf-vatCategory"
            value={state.vatCategory}
            onChange={(e) => update("vatCategory", e.target.value as VatCategory)}
            aria-invalid={fieldError("vatCategory") ? true : undefined}
            className={inputClass}
          >
            {VAT_CATEGORY_VALUES.map((v) => (
              <option key={v} value={v}>
                {tr(`catalog.vatCategory.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            {tr("catalog.form.price")} ({currency}
            {state.unitType === "KG" ? ` ${tr("catalog.form.perKg")}` : ""})
          </span>
          <input
            id="pf-priceMinor"
            value={state.price}
            onChange={(e) => update("price", e.target.value)}
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            required
            placeholder="0.00"
            aria-invalid={fieldError("priceMinor") ? true : undefined}
            aria-describedby={describe("priceMinor") ?? (priceChanged ? "pf-price-hint" : undefined)}
            className={`${inputClass} tabular-nums`}
          />
          {errorText("priceMinor")}
          {priceChanged ? (
            <span id="pf-price-hint" className="text-xs text-muted">
              {tr("catalog.form.priceChangeHint")}
            </span>
          ) : null}
        </label>
        {canSeeCost ? (
          <label className="field">
            <span>
              {tr("catalog.form.cost")} ({currency}
              {state.unitType === "KG" ? ` ${tr("catalog.form.perKg")}` : ""})
            </span>
            <input
              id="pf-costMinor"
              value={state.cost}
              onChange={(e) => update("cost", e.target.value)}
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              aria-invalid={fieldError("costMinor") ? true : undefined}
              aria-describedby={describe("costMinor")}
              className={`${inputClass} tabular-nums`}
            />
            {errorText("costMinor")}
          </label>
        ) : null}
        {belowCost ? (
          <p role="status" className="text-sm text-warning sm:col-span-2">
            {tr("catalog.form.warning.priceBelowCost")}
          </p>
        ) : null}

        <div className="flex flex-col gap-1 sm:col-span-2">
          <span>{tr("catalog.form.barcodes")}</span>
          <BarcodeInput
            locale={locale}
            path="barcodes"
            codes={state.barcodes}
            otherCodes={otherCodesThan(state, "barcodes")}
            errors={errors.fields}
            disabled={disabled}
            onChange={(codes) => update("barcodes", codes)}
          />
        </div>
      </fieldset>

      {state.unitType === "KG" || state.isService ? null : (
        <VariantRows
          locale={locale}
          currency={currency}
          state={state}
          errors={errors.fields}
          canSeeCost={canSeeCost}
          readOnly={readOnly}
          disabled={disabled}
          product={current}
          onChange={setVariants}
          onAdd={addVariant}
          onRecordChanged={onRecordChanged}
        />
      )}

      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <button type="submit" disabled={pending} className="btn btn-primary">
            {pending ? tr("catalog.form.saving") : tr("catalog.form.save")}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!dirty || window.confirm(tr("catalog.form.discardConfirm"))) router.push("/catalog/products");
            }}
            className="btn"
          >
            {tr("catalog.form.cancel")}
          </button>
          <span className="text-xs text-muted">{tr("catalog.form.shortcuts")}</span>
          {current ? <ProductArchiveControls locale={locale} product={current} onChanged={onRecordChanged} /> : null}
        </div>
      )}
    </form>
  );
}
