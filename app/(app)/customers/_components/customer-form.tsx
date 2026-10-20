"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { CustomerRow } from "@/modules/customers";
import { plain, safeAction } from "../../inventory/_lib/form";
import { createCustomerAction, updateCustomerAction } from "../actions";
import { customerErrorKey } from "../_lib/customers";

type Draft = { name: string; phone: string; email: string; taxNumber: string; note: string };

const EMPTY: Draft = { name: "", phone: "", email: "", taxNumber: "", note: "" };

function toDraft(row: CustomerRow): Draft {
  return {
    name: row.name,
    phone: row.phone,
    email: row.email ?? "",
    taxNumber: row.taxNumber ?? "",
    note: row.note ?? "",
  };
}

/**
 * Add (no `customer`) or edit a customer, plus archive/restore when editing (customers-spec CU4,
 * CU13). A new customer opens on their own page.
 */
export function CustomerForm({ locale, customer }: { locale: Locale; customer?: CustomerRow }) {
  const tr = translator(locale);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(customer ? toDraft(customer) : EMPTY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    const result = await safeAction(() =>
      customer ? updateCustomerAction(customer.id, draft) : createCustomerAction(draft),
    );
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, customerErrorKey(result.error)));
      return;
    }
    setOpen(false);
    setError(null);
    if (customer) router.refresh();
    else router.push(`/customers/${result.data.id}`);
  }

  async function toggleActive() {
    if (!customer) return;
    setPending(true);
    const result = await safeAction(() => updateCustomerAction(customer.id, { isActive: !customer.isActive }));
    setPending(false);
    if (!result.ok) setError(plain(locale, customerErrorKey(result.error)));
    router.refresh();
  }

  const field = (key: keyof Draft, label: string, max: number, dir?: "ltr") => (
    <label className="flex flex-col gap-1">
      <span>{label}</span>
      <input
        value={draft[key]}
        dir={dir}
        required={key === "name" || key === "phone"}
        maxLength={max}
        inputMode={key === "phone" ? "tel" : undefined}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        className="rounded-md border border-border bg-background px-3 py-2"
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      {!open ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(customer ? toDraft(customer) : EMPTY);
              setOpen(true);
            }}
            className="rounded-md bg-foreground px-4 py-2 text-background"
          >
            {customer ? tr("customers.edit") : tr("customers.add")}
          </button>
          {customer ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void toggleActive()}
              className="rounded-md border border-border px-4 py-2"
            >
              {customer.isActive ? tr("customers.archive") : tr("customers.restore")}
            </button>
          ) : null}
        </div>
      ) : (
        <form
          onSubmit={save}
          aria-label={customer ? tr("customers.edit") : tr("customers.add")}
          className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4"
        >
          {field("name", tr("customers.field.name"), 120)}
          {field("phone", tr("customers.field.phone"), 40, "ltr")}
          {field("email", tr("customers.field.email"), 254, "ltr")}
          {field("taxNumber", tr("customers.field.taxNumber"), 40, "ltr")}
          {field("note", tr("customers.field.note"), 500)}
          <button type="submit" disabled={pending} className="rounded-md bg-foreground px-4 py-2 text-background">
            {tr("customers.save")}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-border px-4 py-2">
            {tr("customers.cancel")}
          </button>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
