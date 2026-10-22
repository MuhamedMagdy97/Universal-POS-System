"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { formatMinor, type CurrencyCode } from "@/lib/money";
import type { SellableSummary } from "@/modules/catalog/schemas";
import { createPoAction, receiveDirectAction, updatePoAction } from "../actions";
import {
  editorTotal,
  errorKey,
  linesToSubmit,
  parseCost,
  parseQty,
  plain,
  safeAction,
  type EditorLine,
} from "../_lib/purchasing";

type Option = { id: string; name: string };

type Props = {
  locale: Locale;
  currency: CurrencyCode;
  suppliers: Option[];
  /** New PO: the branches to choose from. Existing PO: null (the branch never changes). */
  branches: Option[] | null;
  existing?: { id: string; supplierId: string; note: string | null; lines: EditorLine[] };
  /** Receive the lines now, with no PO (direct-receipt-spec D2), instead of saving a draft. */
  direct?: boolean;
};

const keyOf = (line: { productId: string; variantId: string | null }) => `${line.productId}|${line.variantId ?? ""}`;

/**
 * Create or edit a PO while it is still editable (P4): supplier, branch (new only), note and lines
 * found by name, SKU or barcode. Costs are typed in major units; the server re-validates everything.
 */
export function PoEditor({ locale, currency, suppliers, branches, existing, direct = false }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  // Direct receipt: one Idempotency-Key per form, kept across retries, so a double submit never receives twice.
  const [key] = useState(() => crypto.randomUUID());
  const [supplierId, setSupplierId] = useState(existing?.supplierId ?? "");
  const [branchId, setBranchId] = useState(branches?.[0]?.id ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [lines, setLines] = useState<EditorLine[]>(existing?.lines ?? []);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SellableSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function find() {
    const q = search.trim();
    if (!q) return;
    try {
      const response = await fetch(`/api/catalog/search?${new URLSearchParams({ q, limit: "10" })}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(String(response.status));
      setResults((await response.json()) as SellableSummary[]);
    } catch {
      setMessage({ kind: "error", text: tr("purchasing.error.generic") });
    }
  }

  function add(item: SellableSummary) {
    setLines((current) => {
      const index = current.findIndex((line) => keyOf(line) === keyOf(item));
      if (index !== -1) {
        return current.map((line, i) => (i === index ? { ...line, qty: String((parseQty(line.qty) ?? 0) + 1) } : line));
      }
      return [
        ...current,
        { productId: item.productId, variantId: item.variantId, name: item.name, sku: item.sku, qty: "1", cost: "" },
      ];
    });
    setMessage(null);
  }

  function update(index: number, patch: Partial<EditorLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  const total = editorTotal(lines, currency);
  const qtyLabel = direct ? "purchasing.direct.qty" : "purchasing.line.ordered";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lines.length === 0) {
      setMessage({ kind: "error", text: tr("purchasing.po.noLines") });
      return;
    }
    const parsed = linesToSubmit(lines, currency);
    if (!parsed) {
      setMessage({ kind: "error", text: tr("purchasing.po.badLine") });
      return;
    }
    setPending(true);
    if (direct) {
      const received = await safeAction(() =>
        receiveDirectAction(key, { branchId, supplierId, note: note.trim() || null, lines: parsed }),
      );
      setPending(false);
      if (received.ok) router.push("/purchasing?received=1");
      else setMessage({ kind: "error", text: plain(locale, errorKey(received.error)) });
      return;
    }
    const result = await safeAction(() =>
      existing
        ? updatePoAction(existing.id, { supplierId, note: note.trim() || null, lines: parsed })
        : createPoAction({ branchId, supplierId, note: note.trim() || null, lines: parsed }),
    );
    setPending(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: plain(locale, errorKey(result.error)) });
      return;
    }
    if (existing) {
      setMessage({ kind: "ok", text: tr("purchasing.po.saved") });
      router.refresh();
    } else {
      router.push(`/purchasing/${result.data.id}`);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.po.supplier")}</span>
          <select
            required
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2"
          >
            <option value="" disabled>
              {tr("purchasing.po.chooseSupplier")}
            </option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {branches && branches.length > 1 ? (
          <label className="flex flex-col gap-1">
            <span>{tr("purchasing.po.branch")}</span>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex min-w-64 flex-1 flex-col gap-1">
          <span>{tr("purchasing.po.note")}</span>
          <input
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span>{tr("purchasing.search.label")}</span>
        <div className="flex gap-2">
          <input
            aria-label={tr("purchasing.search.label")}
            placeholder={tr("purchasing.search.placeholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // A scanner sends Enter after the code: search instead of submitting the order.
              if (e.key === "Enter") {
                e.preventDefault();
                void find();
              }
            }}
            dir="ltr"
            className="flex-1 rounded-md border border-border bg-background px-3 py-2"
          />
          <button type="button" onClick={() => void find()} className="rounded-md border border-border px-4 py-2">
            {tr("purchasing.search.submit")}
          </button>
        </div>
        {results !== null && results.length === 0 ? <p className="text-muted">{tr("purchasing.search.none")}</p> : null}
        <ul className="flex flex-col gap-1">
          {(results ?? []).map((item) => (
            <li key={keyOf(item)} className="flex items-center justify-between gap-2">
              <span>
                {item.name}{" "}
                <span dir="ltr" className="text-muted">
                  {item.sku}
                </span>
              </span>
              <button type="button" onClick={() => add(item)} className="rounded-md border border-border px-3 py-1">
                {tr("purchasing.search.add")}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <table className="w-full text-start">
        <thead>
          <tr className="text-sm text-muted">
            <th className="py-2 text-start">{tr("purchasing.line.item")}</th>
            <th className="text-start">{tr(qtyLabel)}</th>
            <th className="text-start">{tr("purchasing.line.cost")}</th>
            <th className="text-end">{tr("purchasing.line.total")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const qty = parseQty(line.qty);
            const cost = parseCost(line.cost, currency);
            return (
              <tr key={keyOf(line)} className="border-t border-border">
                <td className="py-2">
                  {line.name}{" "}
                  <span dir="ltr" className="text-muted">
                    {line.sku}
                  </span>
                </td>
                <td>
                  <input
                    dir="ltr"
                    inputMode="numeric"
                    aria-label={`${tr(qtyLabel)} ${line.sku}`}
                    aria-invalid={qty === null || qty < 1}
                    value={line.qty}
                    onChange={(e) => update(index, { qty: e.target.value })}
                    className="w-24 rounded-md border border-border bg-background px-2 py-1"
                  />
                </td>
                <td>
                  <input
                    dir="ltr"
                    inputMode="decimal"
                    aria-label={`${tr("purchasing.line.cost")} ${line.sku}`}
                    aria-invalid={cost === null}
                    value={line.cost}
                    onChange={(e) => update(index, { cost: e.target.value })}
                    className="w-28 rounded-md border border-border bg-background px-2 py-1"
                  />
                </td>
                <td className="text-end">
                  {qty !== null && cost !== null ? formatMinor(qty * cost, currency, locale) : "—"}
                </td>
                <td className="text-end">
                  <button
                    type="button"
                    onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                    className="rounded-md border border-border px-2 py-1 text-sm"
                  >
                    {tr("purchasing.line.remove")}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold">
            <td className="py-2">{tr("purchasing.po.total")}</td>
            <td colSpan={2} />
            <td className="text-end">{total === null ? "—" : formatMinor(total, currency, locale)}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "text-red-700" : ""}
        >
          {message.text}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || supplierId === ""}
        className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
      >
        {direct ? tr("purchasing.direct.submit") : existing ? tr("purchasing.po.save") : tr("purchasing.po.create")}
      </button>
    </form>
  );
}
