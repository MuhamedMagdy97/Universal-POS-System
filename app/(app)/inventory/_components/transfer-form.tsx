"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { StockPage, StockRow } from "@/modules/inventory";
import { sendTransferAction, transferStockAction } from "../actions";
import { formatQty, parseQtyInput, type QtyUnit } from "@/lib/quantity";
import { overSourceLines, plain, safeAction, transferErrorKey, type ItemRef, type Line } from "../_lib/form";

type BranchChoice = { id: string; name: string };

type Props = {
  locale: Locale;
  fromBranch: BranchChoice;
  destinations: BranchChoice[];
};

/** A line on the form keeps what the screen shows; `onHand` is the source balance at the time it was added. */
/** `text` is what the box shows (kg for a KG line, weighed-selling-spec W7); `qty` is pieces or grams. */
type FormLine = Line & { name: string; sku: string; onHand: number; unitType: QtyUnit; text: string };

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
  // Instant stays the default (transit-transfers-spec T1).
  const [mode, setMode] = useState<"instant" | "transit">("instant");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function find() {
    const term = search.trim();
    if (!term) return;
    const params = new URLSearchParams({ branchId: fromBranch.id, q: term, limit: "10" });
    let page: StockPage;
    try {
      const response = await fetch(`/api/inventory/stock?${params}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`search failed: ${response.status}`);
      page = (await response.json()) as StockPage;
    } catch {
      setMessage({ kind: "error", text: tr("inventory.state.error") });
      return;
    }
    // An archived item can still be moved out while it holds stock; with none left there is nothing to move.
    setResults(page.rows.filter((row) => !row.archived || row.qty > 0));
  }

  /** Adds one unit of a scanned or searched item, or increments the line that already holds it. */
  function add(row: StockRow) {
    const ref: ItemRef = { productId: row.productId, variantId: row.variantId };
    setLines((current) => {
      const index = current.findIndex((line) => keyOf(line.ref) === keyOf(ref));
      // A KG line starts empty: the weight is typed (W7).
      const kg = row.unitType === "KG";
      if (index === -1) {
        const line = { ref, name: labelOf(row), sku: row.sku, onHand: row.qty, unitType: row.unitType };
        return [...current, { ...line, qty: kg ? 0 : 1, text: kg ? "" : "1" }];
      }
      if (kg) return current;
      return current.map((line, i) =>
        i === index ? { ...line, qty: line.qty + 1, text: String(line.qty + 1) } : line,
      );
    });
    setMessage(null);
  }

  function setQty(index: number, value: string) {
    // Arabic-Indic digits are read; an empty or invalid box counts as 0 and blocks submit.
    setLines((current) =>
      current.map((line, i) =>
        i === index ? { ...line, qty: parseQtyInput(value, line.unitType) ?? 0, text: value } : line,
      ),
    );
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
    const input = {
      transferId,
      fromBranchId: fromBranch.id,
      toBranchId,
      lines: lines.map((line) => ({ ref: line.ref, qty: line.qty })),
      note: note.trim() || undefined,
    };
    if (mode === "transit") {
      const sent = await safeAction(() => sendTransferAction(input));
      if (sent.ok) {
        router.push(`/inventory/transfers/${transferId}?sent=1`);
        return;
      }
      setPending(false);
      setMessage({ kind: "error", text: plain(locale, transferErrorKey(sent.error)) });
      return;
    }
    const result = await safeAction(() => transferStockAction(input));
    setPending(false);
    if (result.ok) {
      setMessage({ kind: "ok", text: tr("inventory.transfer.success", { count: lines.length }) });
      setLines([]);
      setNote("");
      setTransferId(crypto.randomUUID());
      router.refresh();
      return;
    }
    setMessage({ kind: "error", text: plain(locale, transferErrorKey(result.error)) });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p>
        {tr("inventory.branch")}: <strong>{fromBranch.name}</strong>
      </p>

      <label className="field">
        <span>{tr("inventory.transfer.to")}</span>
        <select value={toBranchId} onChange={(e) => setToBranchId(e.target.value)} className="input">
          {destinations.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend>{tr("inventory.transfer.mode.label")}</legend>
        {(["instant", "transit"] as const).map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
            {tr(`inventory.transfer.mode.${value}` as const)}
          </label>
        ))}
      </fieldset>

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
            className="input flex-1"
          />
          <button type="button" onClick={() => void find()} className="btn">
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
                <span className="text-muted">
                  {tr("inventory.transfer.lineOnHand", { onHand: formatQty(row.qty, row.unitType, locale) })}
                </span>
                <button type="button" onClick={() => add(row)} className="btn btn-sm">
                  {tr("inventory.transfer.addItem")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="table-wrap">
        <table className="table">
          <tbody>
            {lines.map((line, index) => {
              const isOver = over.some((o) => keyOf(o.ref) === keyOf(line.ref));
              return (
                <tr key={keyOf(line.ref)}>
                  <td>
                    {line.name}{" "}
                    <span dir="ltr" className="text-muted">
                      {line.sku}
                    </span>
                  </td>
                  <td>
                    <input
                      dir="ltr"
                      inputMode={line.unitType === "KG" ? "decimal" : "numeric"}
                      aria-label={tr("inventory.adjust.qty")}
                      placeholder={line.unitType === "KG" ? "0.000" : undefined}
                      value={line.text}
                      onChange={(e) => setQty(index, e.target.value)}
                      className="input min-h-9 w-24 px-2 py-1"
                    />
                  </td>
                  <td className="text-muted">
                    {tr("inventory.transfer.lineOnHand", { onHand: formatQty(line.onHand, line.unitType, locale) })}
                  </td>
                  <td>{isOver ? <span className="text-danger">{tr("inventory.transfer.overSource")}</span> : null}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                      className="btn btn-sm"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <label className="field">
        <span>{tr("inventory.transfer.note")}</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="input" />
      </label>

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "text-danger" : ""}
        >
          {message.text}
        </p>
      ) : null}

      <button type="submit" disabled={!canSubmit} className="btn btn-primary self-start">
        {mode === "transit" ? tr("inventory.transfer.send") : tr("inventory.transfer.submit")}
      </button>
    </form>
  );
}
