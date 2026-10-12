"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { SupplierRow } from "@/modules/purchasing";
import { createSupplierAction, setSupplierActiveAction, updateSupplierAction } from "../actions";
import { errorKey, plain, safeAction } from "../_lib/purchasing";

type Draft = { name: string; phone: string; email: string; taxNumber: string };

const EMPTY: Draft = { name: "", phone: "", email: "", taxNumber: "" };

function toDraft(row: SupplierRow): Draft {
  return { name: row.name, phone: row.phone ?? "", email: row.email ?? "", taxNumber: row.taxNumber ?? "" };
}

/** Supplier list with an inline add/edit form and archive/restore (P12). */
export function SuppliersManager({ locale, suppliers }: { locale: Locale; suppliers: SupplierRow[] }) {
  const tr = translator(locale);
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start(target: SupplierRow | "new") {
    setEditing(target === "new" ? "new" : target.id);
    setDraft(target === "new" ? EMPTY : toDraft(target));
    setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setPending(true);
    const input = { name: draft.name, phone: draft.phone, email: draft.email, taxNumber: draft.taxNumber };
    const result = await safeAction(() =>
      editing === "new" ? createSupplierAction(input) : updateSupplierAction(editing, input),
    );
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, errorKey(result.error)));
      return;
    }
    setEditing(null);
    router.refresh();
  }

  async function toggle(row: SupplierRow) {
    setPending(true);
    const result = await safeAction(() => setSupplierActiveAction(row.id, !row.isActive));
    setPending(false);
    if (!result.ok) setError(plain(locale, errorKey(result.error)));
    router.refresh();
  }

  const field = (key: keyof Draft, label: string, dir?: "ltr") => (
    <label className="flex flex-col gap-1">
      <span>{label}</span>
      <input
        value={draft[key]}
        dir={dir}
        required={key === "name"}
        maxLength={key === "name" ? 120 : key === "email" ? 254 : 40}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        className="rounded-md border border-border bg-background px-3 py-2"
      />
    </label>
  );

  const form = (
    <form onSubmit={save} className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4">
      {field("name", tr("purchasing.supplier.name"))}
      {field("phone", tr("purchasing.supplier.phone"), "ltr")}
      {field("email", tr("purchasing.supplier.email"), "ltr")}
      {field("taxNumber", tr("purchasing.supplier.taxNumber"), "ltr")}
      <button type="submit" disabled={pending} className="rounded-md bg-foreground px-4 py-2 text-background">
        {tr("purchasing.supplier.save")}
      </button>
      <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-border px-4 py-2">
        {tr("purchasing.supplier.cancel")}
      </button>
    </form>
  );

  return (
    <div className="flex flex-col gap-4">
      {editing === null ? (
        <button
          type="button"
          onClick={() => start("new")}
          className="self-start rounded-md bg-foreground px-4 py-2 text-background"
        >
          {tr("purchasing.supplier.add")}
        </button>
      ) : null}
      {editing === "new" ? form : null}
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      {suppliers.length === 0 ? (
        <p className="text-muted">{tr("purchasing.supplier.none")}</p>
      ) : (
        <table className="w-full text-start">
          <thead>
            <tr className="text-sm text-muted">
              <th className="py-2 text-start">{tr("purchasing.supplier.name")}</th>
              <th className="text-start">{tr("purchasing.supplier.phone")}</th>
              <th className="text-start">{tr("purchasing.supplier.email")}</th>
              <th className="text-start">{tr("purchasing.supplier.taxNumber")}</th>
              <th className="text-start">{tr("purchasing.supplier.status")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {suppliers.map((row) =>
              editing === row.id ? (
                <tr key={row.id} className="border-t border-border">
                  <td colSpan={6} className="py-2">
                    {form}
                  </td>
                </tr>
              ) : (
                <tr key={row.id} className="border-t border-border">
                  <td className="py-2">{row.name}</td>
                  <td dir="ltr">{row.phone}</td>
                  <td dir="ltr">{row.email}</td>
                  <td dir="ltr">{row.taxNumber}</td>
                  <td>{row.isActive ? tr("purchasing.supplier.active") : tr("purchasing.supplier.archived")}</td>
                  <td className="flex justify-end gap-2 py-2">
                    <button
                      type="button"
                      onClick={() => start(row)}
                      className="rounded-md border border-border px-2 py-1 text-sm"
                    >
                      {tr("purchasing.supplier.edit")}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void toggle(row)}
                      className="rounded-md border border-border px-2 py-1 text-sm"
                    >
                      {row.isActive ? tr("purchasing.supplier.archive") : tr("purchasing.supplier.restore")}
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
