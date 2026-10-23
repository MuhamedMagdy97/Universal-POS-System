"use client";

import { useEffect, useRef } from "react";
import Form from "next/form";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { VAT_CATEGORY_VALUES, type ProductStatus, type VatCategory } from "@/modules/catalog/schemas";
import { listShortcut } from "../_lib/form-helpers";

type Props = {
  locale: Locale;
  q: string;
  categoryId: string;
  /** "" = any VAT category. */
  vatCategory: VatCategory | "";
  status: ProductStatus;
  canCreate: boolean;
  categories: { id: string; label: string }[];
};

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Search + filters. The state lives in the URL (GET form → `?q&categoryId&vatCategory&status`),
 * so results are shareable and back-button safe. The search box is autofocused
 * for scanners; `/` focuses it and `N` opens a new product when no field has focus.
 */
export function ProductsToolbar({ locale, q, categoryId, vatCategory, status, canCreate, categories }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = listShortcut(event, isEditable(event.target));
      if (action === "focusSearch") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (action === "newProduct" && canCreate) {
        event.preventDefault();
        router.push("/catalog/products/new");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canCreate, router]);

  return (
    <Form
      ref={formRef}
      action="/catalog/products"
      role="search"
      className="flex flex-wrap items-end gap-3"
      aria-describedby="catalog-shortcuts"
    >
      <label className="flex min-w-64 flex-1 flex-col gap-1">
        <span className="text-sm">{tr("catalog.products.search")}</span>
        <input
          ref={searchRef}
          type="search"
          name="q"
          defaultValue={q}
          maxLength={64}
          autoFocus
          autoComplete="off"
          placeholder={tr("catalog.products.searchPlaceholder")}
          className="input"
        />
      </label>
      <label className="field">
        <span className="text-sm">{tr("catalog.products.filter.category")}</span>
        <select
          name="categoryId"
          defaultValue={categoryId}
          onChange={() => formRef.current?.requestSubmit()}
          className="input"
        >
          <option value="">{tr("catalog.products.filter.all")}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="text-sm">{tr("catalog.products.filter.vatCategory")}</span>
        <select
          name="vatCategory"
          defaultValue={vatCategory}
          onChange={() => formRef.current?.requestSubmit()}
          className="input"
        >
          <option value="">{tr("catalog.products.filter.all")}</option>
          {VAT_CATEGORY_VALUES.map((v) => (
            <option key={v} value={v}>
              {tr(`catalog.vatCategory.${v}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="text-sm">{tr("catalog.products.filter.status")}</span>
        <select name="status" defaultValue={status} onChange={() => formRef.current?.requestSubmit()} className="input">
          <option value="active">{tr("catalog.status.active")}</option>
          <option value="archived">{tr("catalog.status.archived")}</option>
          <option value="all">{tr("catalog.products.filter.all")}</option>
        </select>
      </label>
      <button type="submit" className="btn">
        {tr("catalog.products.filter.apply")}
      </button>
      <p id="catalog-shortcuts" className="w-full text-xs text-muted">
        {tr("catalog.products.shortcuts")}
      </p>
    </Form>
  );
}
