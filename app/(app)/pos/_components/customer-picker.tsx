"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { translator, type Locale } from "@/lib/i18n";
import type { CustomerRow } from "@/modules/customers";
import { plain, safeAction } from "../../inventory/_lib/form";
import { createCustomerAction } from "../../customers/actions";
import { customerErrorKey, takenCustomerId } from "../../customers/_lib/customers";
import type { TillCustomer } from "../_lib/till";

type Props = {
  locale: Locale;
  customer: TillCustomer | null;
  onChange: (customer: TillCustomer | null) => void;
  canCreate: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Back to the item search after a pick. */
  onDone: () => void;
};

const toTill = (row: CustomerRow): TillCustomer => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  taxNumber: row.taxNumber,
});

/**
 * The sale's customer (customers-spec CU12): F9 focuses the search, typing 2+ characters lists up
 * to 10 active customers by phone or name, ↑/↓ and Enter pick, Esc closes. "Add customer" is a
 * name + phone quick-add. Walk-in is the default and "Remove" goes back to it.
 */
export function CustomerPicker({ locale, customer, onChange, canCreate, inputRef, onDone }: Props) {
  const tr = translator(locale);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerRow[] | null>(null);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<{ name: string; phone: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the latest search may fill the list.
  const searchSeq = useRef(0);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function search(q: string) {
    const seq = ++searchSeq.current;
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    const params = new URLSearchParams({ q: q.trim(), limit: "10" });
    try {
      const response = await fetch(`/api/customers?${params}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`customer search failed: ${response.status}`);
      const rows = (await response.json()) as CustomerRow[];
      if (seq !== searchSeq.current) return;
      setResults(rows);
      setActive(0);
    } catch {
      if (seq === searchSeq.current) setError(tr("pos.error.generic"));
    }
  }

  function close() {
    if (typing.current) clearTimeout(typing.current);
    searchSeq.current++;
    setQuery("");
    setResults(null);
    setAdding(null);
    setError(null);
  }

  function pick(row: TillCustomer) {
    onChange(row);
    close();
    onDone();
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // Handled here, so the till's own Esc does not also run.
      event.stopPropagation();
      close();
      onDone();
    } else if (event.key === "ArrowDown" && results?.length) {
      event.preventDefault();
      setActive((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp" && results?.length) {
      event.preventDefault();
      setActive((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (results?.[active]) pick(toTill(results[active]));
    }
  }

  function startAdd() {
    // A typed phone goes to the phone box, anything else to the name.
    const looksLikePhone = /^[+\d\s\-()٠-٩۰-۹]+$/.test(query.trim());
    setAdding({ name: looksLikePhone ? "" : query.trim(), phone: looksLikePhone ? query.trim() : "" });
    setResults(null);
    setError(null);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!adding) return;
    setPending(true);
    const result = await safeAction(() => createCustomerAction({ name: adding.name, phone: adding.phone }));
    setPending(false);
    if (result.ok) {
      pick(toTill(result.data));
      return;
    }
    setError(plain(locale, customerErrorKey(result.error)));
    // The phone is someone's already: list them so the cashier can pick them.
    if (takenCustomerId(result.error)) {
      setQuery(adding.phone);
      void search(adding.phone);
    }
  }

  if (customer) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
        data-testid="till-customer"
      >
        <span>
          {tr("pos.customer.label")}: <strong>{customer.name}</strong>{" "}
          <span dir="ltr" className="text-muted">
            {customer.phone}
          </span>
        </span>
        {customer.taxNumber ? (
          <span className="text-sm text-muted">{tr("pos.customer.vatNo", { number: customer.taxNumber })}</span>
        ) : null}
        <button
          type="button"
          onClick={() => onChange(null)}
          className="ms-auto rounded-md border border-border px-2 py-1 text-sm"
        >
          {tr("pos.customer.remove")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={results !== null && results.length > 0}
          aria-controls="customer-results"
          aria-activedescendant={results?.[active] ? `customer-${results[active].id}` : undefined}
          aria-label={tr("pos.customer.search")}
          placeholder={tr("pos.customer.placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setError(null);
            // Search once typing pauses, not on every key.
            const q = e.target.value;
            if (typing.current) clearTimeout(typing.current);
            typing.current = setTimeout(() => void search(q), 200);
          }}
          onKeyDown={onKey}
          className="min-w-48 flex-1 rounded-md border border-border bg-background px-3 py-2"
        />
        <span className="text-sm text-muted">{tr("pos.customer.walkIn")}</span>
        {canCreate && !adding ? (
          <button type="button" onClick={startAdd} className="rounded-md border border-border px-3 py-2 text-sm">
            {tr("pos.customer.add")}
          </button>
        ) : null}
      </div>
      {results !== null ? (
        results.length === 0 ? (
          <p className="text-sm text-muted">{tr("pos.customer.none")}</p>
        ) : (
          <ul id="customer-results" role="listbox" aria-label={tr("pos.customer.search")} className="flex flex-col">
            {results.map((row, index) => (
              <li
                key={row.id}
                id={`customer-${row.id}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(e) => {
                  // Keep focus in the box until the pick lands.
                  e.preventDefault();
                  pick(toTill(row));
                }}
                className="flex cursor-pointer justify-between gap-2 rounded-md px-2 py-1 aria-selected:bg-foreground/10"
              >
                <span>{row.name}</span>
                <span dir="ltr" className="text-muted">
                  {row.phone}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {adding ? (
        <form
          onSubmit={add}
          aria-label={tr("pos.customer.add")}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
        >
          <label className="flex flex-col gap-1">
            <span>{tr("customers.field.name")}</span>
            <input
              autoFocus={adding.name === ""}
              required
              maxLength={120}
              value={adding.name}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })}
              className="rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>{tr("customers.field.phone")}</span>
            <input
              autoFocus={adding.name !== ""}
              required
              dir="ltr"
              inputMode="tel"
              maxLength={40}
              value={adding.phone}
              onChange={(e) => setAdding({ ...adding, phone: e.target.value })}
              className="rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <button type="submit" disabled={pending} className="rounded-md bg-foreground px-3 py-2 text-background">
            {tr("pos.customer.save")}
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              onDone();
            }}
            className="rounded-md px-3 py-2 underline-offset-4 hover:underline"
          >
            {tr("pos.discount.cancel")}
          </button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
