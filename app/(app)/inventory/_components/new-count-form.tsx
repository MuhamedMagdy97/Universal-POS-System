"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { createCountAction } from "../actions";
import { countErrorKey, plain, safeAction } from "../_lib/form";

type Scope = "FULL" | "CATEGORY" | "ITEMS";
const SCOPES: Scope[] = ["FULL", "CATEGORY", "ITEMS"];

/** New count (stock-counts-spec C1, C2): pick the scope, create a draft, open it. */
export function NewCountForm({
  locale,
  branchId,
  categories,
}: {
  locale: Locale;
  branchId: string;
  categories: { id: string; name: string }[];
}) {
  const tr = translator(locale);
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("FULL");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    const result = await safeAction(() =>
      createCountAction({
        branchId,
        scope,
        categoryId: scope === "CATEGORY" ? categoryId : undefined,
        note: note.trim() || undefined,
      }),
    );
    if (result.ok) {
      router.push(`/inventory/counts/${result.data.id}`);
      return;
    }
    setPending(false);
    setError(plain(locale, countErrorKey(result.error)));
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-4">
      <h2 className="text-lg font-medium">{tr("inventory.count.new")}</h2>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1">{tr("inventory.count.scope.label")}</legend>
        {SCOPES.map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="scope"
              value={value}
              checked={scope === value}
              disabled={value === "CATEGORY" && categories.length === 0}
              onChange={() => setScope(value)}
            />
            {tr(`inventory.count.scope.${value}` as const)}
          </label>
        ))}
      </fieldset>
      {scope === "CATEGORY" ? (
        <label className="field">
          <span>{tr("inventory.count.category")}</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field">
        <span>{tr("inventory.count.note")}</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="input" />
      </label>
      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="btn btn-primary self-start">
        {tr("inventory.count.create")}
      </button>
    </form>
  );
}
