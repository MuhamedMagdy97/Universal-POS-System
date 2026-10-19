"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { CountDetail, CountLineView, StockPage, StockRow } from "@/modules/inventory";
import {
  addCountItemsAction,
  cancelCountAction,
  postCountAction,
  recordCountEntryAction,
  removeCountItemAction,
  startCountAction,
} from "../actions";
import {
  countErrorKey,
  normalizeCount,
  pickScanned,
  plain,
  safeAction,
  type ActionResult,
  type ItemRef,
} from "../_lib/form";

type Message = { kind: "ok" | "error"; text: string } | null;

const keyOf = (ref: ItemRef) => `${ref.productId}|${ref.variantId ?? ""}`;

/**
 * A stock count by status (stock-counts-spec §5). Counting is blind: on-hand and expected appear
 * only on the review. Every change goes through a Server Action and then refreshes the page data.
 */
export function CountSession({ locale, count, canEdit }: { locale: Locale; count: CountDetail; canEdit: boolean }) {
  const tr = translator(locale);
  const router = useRouter();
  const scanRef = useRef<HTMLInputElement>(null);
  const [reviewing, setReviewing] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<StockRow[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const open = count.status === "DRAFT" || count.status === "COUNTING";
  const editable = canEdit && open;
  const nameOf = (item: { name: string; nameAr?: string | null; variantName: string | null }) => {
    const base = locale === "ar" && item.nameAr ? item.nameAr : item.name;
    return item.variantName ? `${base} — ${item.variantName}` : base;
  };

  /** Runs an action; on success refreshes the page and returns the data, on failure shows the message. */
  async function act<T>(run: () => Promise<ActionResult<T>>): Promise<T | null> {
    setPending(true);
    const result = await safeAction(run);
    setPending(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: plain(locale, countErrorKey(result.error)) });
      return null;
    }
    router.refresh();
    return result.data;
  }

  async function find(term: string): Promise<StockRow[] | null> {
    const params = new URLSearchParams({ branchId: count.branchId, q: term, limit: "10" });
    try {
      const response = await fetch(`/api/inventory/stock?${params}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`search failed: ${response.status}`);
      return ((await response.json()) as StockPage).rows;
    } catch {
      setMessage({ kind: "error", text: tr("inventory.state.error") });
      return null;
    }
  }

  async function addOne(row: {
    productId: string;
    variantId: string | null;
    name: string;
    nameAr: string | null;
    variantName: string | null;
  }) {
    const data = await act(() =>
      recordCountEntryAction(count.id, { ref: { productId: row.productId, variantId: row.variantId }, add: 1 }),
    );
    if (data) {
      setMessage({ kind: "ok", text: tr("inventory.count.scanned", { name: nameOf(row), qty: data.countedQty ?? 0 }) });
      setResults([]);
      setSearch("");
      scanRef.current?.focus();
    }
  }

  /** Enter in the scan box: a code that names one item adds 1 to it; anything else lists the matches. */
  async function scan() {
    const term = search.trim();
    if (!term) return;
    const rows = await find(term);
    if (!rows) return;
    if (count.status === "DRAFT") {
      setResults(rows);
      return;
    }
    const picked = pickScanned(term, rows);
    if (picked) await addOne(picked);
    else {
      setResults(rows);
      setMessage(rows.length === 0 ? { kind: "error", text: tr("inventory.count.noMatch") } : null);
    }
  }

  async function addToDraft(row: StockRow) {
    const data = await act(() =>
      addCountItemsAction(count.id, { refs: [{ productId: row.productId, variantId: row.variantId }] }),
    );
    if (data) {
      setResults([]);
      setSearch("");
      setMessage(null);
    }
  }

  async function setCounted(line: CountLineView, value: number | null) {
    const data = await act(() => recordCountEntryAction(count.id, { ref: line.ref, set: value }));
    if (data) setMessage(null);
  }

  async function post() {
    if (!window.confirm(tr("inventory.count.postConfirm"))) return;
    const data = await act(() => postCountAction(count.id));
    if (data) {
      setReviewing(false);
      setMessage({ kind: "ok", text: tr("inventory.count.posted", { count: data.lines }) });
    }
  }

  async function cancel() {
    if (!window.confirm(tr("inventory.count.cancelConfirm"))) return;
    await act(() => cancelCountAction(count.id));
  }

  const showReview = !open || !canEdit || reviewing;
  const counted = count.lines.filter((line) => line.countedQty !== null);

  return (
    <div className="flex flex-col gap-4">
      {editable && count.status === "DRAFT" ? (
        <p className="text-muted">
          {count.scope === "ITEMS" ? tr("inventory.count.draft.help") : tr("inventory.count.draft.ready")}
        </p>
      ) : null}

      {editable && !showReview && (count.status === "COUNTING" || count.scope === "ITEMS") ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span>{count.status === "COUNTING" ? tr("inventory.count.scan.label") : tr("inventory.search.label")}</span>
            <input
              ref={scanRef}
              autoFocus
              value={search}
              placeholder={tr("inventory.search.placeholder")}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void scan();
                }
              }}
              dir="ltr"
              className="rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          {count.status === "COUNTING" ? <p className="text-sm text-muted">{tr("inventory.count.scan.help")}</p> : null}
          <ul className="flex flex-col gap-1">
            {results.map((row) => (
              <li key={keyOf(row)} className="flex items-center justify-between gap-2">
                <span>
                  {nameOf(row)}{" "}
                  <span dir="ltr" className="text-muted">
                    {row.sku}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void (count.status === "DRAFT" ? addToDraft(row) : addOne(row))}
                  className="rounded-md border border-border px-3 py-1"
                >
                  {count.status === "DRAFT" ? tr("inventory.count.addItem") : tr("inventory.count.addOne")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "text-red-700" : ""}
        >
          {message.text}
        </p>
      ) : null}

      {showReview ? (
        <ReviewTable locale={locale} count={count} nameOf={nameOf} />
      ) : (
        <table className="w-full text-start">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="py-2">{tr("inventory.column.item")}</th>
              <th>{tr("inventory.column.sku")}</th>
              {count.status === "COUNTING" ? <th>{tr("inventory.count.column.counted")}</th> : null}
              <th>{tr("inventory.column.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {count.lines.map((line) => (
              <tr key={keyOf(line.ref)} className="border-b border-border" data-testid="count-line">
                <td className="py-2">{nameOf(line)}</td>
                <td dir="ltr">{line.sku}</td>
                {count.status === "COUNTING" ? (
                  <td>
                    <QtyCell
                      key={`${keyOf(line.ref)}:${line.countedQty ?? ""}`}
                      label={`${tr("inventory.count.column.counted")}: ${nameOf(line)}`}
                      value={line.countedQty}
                      disabled={pending}
                      onCommit={(value) => void setCounted(line, value)}
                    />
                    {line.countedQty === null ? (
                      <span className="ms-2 text-sm text-muted">{tr("inventory.count.notCounted")}</span>
                    ) : null}
                  </td>
                ) : null}
                <td>
                  {count.status === "DRAFT" ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void act(() => removeCountItemAction(count.id, { ref: line.ref }))}
                      className="rounded-md border border-border px-2 py-1"
                    >
                      {tr("inventory.count.remove")}
                    </button>
                  ) : line.countedQty !== null ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void setCounted(line, null)}
                      className="rounded-md border border-border px-2 py-1"
                    >
                      {tr("inventory.count.clear")}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editable ? (
        <div className="flex flex-wrap gap-2">
          {count.status === "DRAFT" ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void act(() => startCountAction(count.id))}
              className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
            >
              {tr("inventory.count.start")}
            </button>
          ) : reviewing ? (
            <>
              <button
                type="button"
                disabled={pending || counted.length === 0}
                onClick={() => void post()}
                className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
              >
                {tr("inventory.count.post")}
              </button>
              <button
                type="button"
                onClick={() => setReviewing(false)}
                className="rounded-md border border-border px-4 py-2"
              >
                {tr("inventory.count.backToCounting")}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={counted.length === 0}
              onClick={() => {
                setMessage(null);
                setReviewing(true);
              }}
              className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
            >
              {tr("inventory.count.review")}
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => void cancel()}
            className="rounded-md border border-border px-4 py-2"
          >
            {tr("inventory.count.cancel")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Typed quantity: Enter or leaving the box replaces the counted quantity (0 … 1,000,000, Arabic-Indic digits ok). */
function QtyCell({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number | null;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const commit = () => {
    const next = normalizeCount(text);
    if (next === null || next === value) {
      setText(value === null ? "" : String(value));
      return;
    }
    onCommit(next);
  };
  return (
    <input
      dir="ltr"
      inputMode="numeric"
      aria-label={label}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      className="w-24 rounded-md border border-border bg-background px-2 py-1"
    />
  );
}

/** Expected (snapshot), moved since, counted and difference; on a closed count, on-hand when posted. */
function ReviewTable({
  locale,
  count,
  nameOf,
}: {
  locale: Locale;
  count: CountDetail;
  nameOf: (line: CountLineView) => string;
}) {
  const tr = translator(locale);
  const open = count.status === "DRAFT" || count.status === "COUNTING";
  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
  return (
    <div className="flex flex-col gap-2">
      {open ? <p className="text-sm text-muted">{tr("inventory.count.review.help")}</p> : null}
      {open && count.uncounted > 0 ? (
        <p role="note" data-testid="count-uncounted">
          {tr("inventory.count.uncounted", { count: count.uncounted })}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-start">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="py-2">{tr("inventory.column.item")}</th>
              <th>{tr("inventory.column.sku")}</th>
              <th>{tr("inventory.count.column.expected")}</th>
              <th>{open ? tr("inventory.count.column.since") : tr("inventory.count.column.onHand")}</th>
              <th>{tr("inventory.count.column.counted")}</th>
              <th>{tr("inventory.count.column.difference")}</th>
            </tr>
          </thead>
          <tbody>
            {count.lines.map((line) => (
              <tr key={keyOf(line.ref)} className="border-b border-border" data-testid="review-line">
                <td className="py-2">{nameOf(line)}</td>
                <td dir="ltr">{line.sku}</td>
                <td dir="ltr">{line.expectedQty ?? "—"}</td>
                <td dir="ltr">
                  {open ? (line.expectedQty === null ? "—" : signed(line.onHand - line.expectedQty)) : line.onHand}
                </td>
                <td dir="ltr">{line.countedQty ?? tr("inventory.count.notCounted")}</td>
                <td
                  dir="ltr"
                  className={
                    line.qtyDelta && line.qtyDelta < 0 ? "text-red-700" : line.qtyDelta ? "text-green-700" : ""
                  }
                >
                  {line.qtyDelta === null ? "—" : signed(line.qtyDelta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
