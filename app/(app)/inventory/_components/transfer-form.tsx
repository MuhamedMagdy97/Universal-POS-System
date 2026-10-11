"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { StockPage, StockRow } from "@/modules/inventory";
import { transferStockAction } from "../actions";
import { normalizeQty } from "@/modules/inventory/schemas";
import { overSourceLines, type ItemRef, type Line } from "../_lib/form";

type BranchChoice = { id: string; name: string };

type Props = {
  locale: Locale;
  fromBranch: BranchChoice;
  destinations: BranchChoice[];
};

/** A line on the form keeps what the screen shows; `onHand` is the source balance at the time it was added. */
type FormLine = Line & { name: string; sku: string; onHand: number };

const keyOf = (ref: ItemRef) => `${ref.productId}|${ref.variantId ?? ""}`;

function labelOf(row: StockRow): string {
  return row.variantName ? `${row.name} — ${row.variantName}` : row.name;
}

/**
 * New transfer (UX §2.4). The transfer number is generated once per form and kept across
 * retries, so a double submit cannot move stock twice. Source balances are a preview; the
 * server decides.
 */
export function TransferForm({ locale, fromBranch, destinations }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const [transferId, setTransferId] = useState(() => crypto.randomUUID());
  const [toBranchId, setToBranchId] = useState(destinations[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<StockRow[]>([]);
  const [lines, setLines] = useState<FormLine[]>([]);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function find() {
    const term = search.trim();
    if (!term) return;
    const params = new URLSearchParams({ branchId: fromBranch.id, q: term, limit: "10" });
    const response = await fetch(`/api/inventory/stock?${params}`, { headers: { accept: "application/json" } });
    if (!response.ok) {
      setMessage({ kind: "error", text: tr("inventory.state.error") });
      return;
    }
    const page = (await response.json()) as StockPage;
    setResults(page.rows.filter((row) => !row.archived));
  }

  /** Adds one unit of a scanned or searched item, or increments the line that already holds it. */
  function add(row: StockRow) {
    const ref: ItemRef = { productId: row.productId, variantId: row.variantId };
    setLines((current) => {
      const index = current.findIndex((line) => keyOf(line.ref) === keyOf(ref));
      if (index === -1) return [...current, { ref, qty: 1, name: labelOf(row), sku: row.sku, onHand: row.qty }];
      return current.map((line, i) => (i === index ? { ...line, qty: line.qty + 1 } : line));
    });
    setMessage(null);
  }

  function setQty(index: number, value: string) {
    // Arabic-Indic digits are read by normalizeQty; an empty or invalid box counts as 0 and blocks submit.
    const qty = normalizeQty(value) ?? 0;
    setLines((current) => current.map((line, i) => (i === index ? { ...line, qty } : line)));
  }

  const over = overSourceLines(lines, (ref) => lines.find((l) => keyOf(l.ref) === keyOf(ref))?.onHand ?? 0);
  const canSubmit =
    lines.length > 0 && lines.every((line) => line.qty >= 1) && over.length === 0 && toBranchId !== "" && !pending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lines.length === 0) {
      setMessage({ kind: "error", text: tr("inventory.transfer.empty") });
      return;
    }
    if (!toBranchId) {
      setMessage({ kind: "error", text: tr("inventory.transfer.noDestination") });
      return;
    }
    setPending(true);
    const result = await transferStockAction({
      transferId,
      fromBranchId: fromBranch.id,
      toBranchId,
      lines: lines.map((line) => ({ ref: line.ref, qty: line.qty })),
      note: note.trim() || undefined,
    });
    setPending(false);
    if (result.ok) {
      setMessage({ kind: "ok", text: tr("inventory.transfer.success", { count: lines.length }) });
      setLines([]);
      setNote("");
      setTransferId(crypto.randomUUID());
      router.refresh();
      return;
    }
    const reason = (result.error.details as { reason?: string } | null)?.reason;
    if (reason === "INSUFFICIENT_STOCK") {
      setMessage({ kind: "error", text: tr("inventory.transfer.overSource") });
      return;
    }
    setMessage({ kind: "error", text: tr("inventory.error.generic") });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p>
        {tr("inventory.branch")}: <strong>{fromBranch.name}</strong>
      </p>

      <label className="flex flex-col gap-1">
        <span>{tr("inventory.transfer.to")}</span>
        <select
          value={toBranchId}
          onChange={(e) => setToBranchId(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-2"
        >
          {destinations.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            aria-label={tr("inventory.search.label")}
            placeholder={tr("inventory.search.placeholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // A scanner sends Enter after the code: search instead of submitting the transfer.
              if (e.key === "Enter") {
                e.preventDefault();
                void find();
              }
            }}
            dir="ltr"
            className="flex-1 rounded-md border border-border bg-background px-3 py-2"
          />
          <button type="button" onClick={() => void find()} className="rounded-md border border-border px-4 py-2">
            {tr("inventory.search.submit")}
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {results.map((row) => (
            <li key={`${row.productId}|${row.variantId ?? ""}`} className="flex items-center justify-between gap-2">
              <span>
                {labelOf(row)}{" "}
                <span dir="ltr" className="text-muted">
                  {row.sku}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-muted">{tr("inventory.transfer.lineOnHand", { onHand: row.qty })}</span>
                <button type="button" onClick={() => add(row)} className="rounded-md border border-border px-3 py-1">
                  {tr("inventory.transfer.addItem")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <table className="w-full text-start">
        <tbody>
          {lines.map((line, index) => {
            const isOver = over.some((o) => keyOf(o.ref) === keyOf(line.ref));
            return (
              <tr key={keyOf(line.ref)} className="border-t border-border">
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
                    aria-label={tr("inventory.adjust.qty")}
                    value={line.qty}
                    onChange={(e) => setQty(index, e.target.value)}
                    className="w-24 rounded-md border border-border bg-background px-2 py-1"
                  />
                </td>
                <td className="text-muted">{tr("inventory.transfer.lineOnHand", { onHand: line.onHand })}</td>
                <td>{isOver ? <span className="text-red-700">{tr("inventory.transfer.overSource")}</span> : null}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                    className="rounded-md border border-border px-2 py-1"
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <label className="flex flex-col gap-1">
        <span>{tr("inventory.transfer.note")}</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          className="rounded-md border border-border bg-background px-3 py-2"
        />
      </label>

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
        disabled={!canSubmit}
        className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
      >
        {tr("inventory.transfer.submit")}
      </button>
    </form>
  );
}
