"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { formatMoney, type CurrencyCode } from "@/lib/money";
import type { CashBreakdown, ShiftCloseSummary } from "@/modules/registers";
import { plain, safeAction } from "../../inventory/_lib/form";
import { PrintZReportButton } from "../../_components/zreport-print";
import { closeShiftAction } from "../actions";
import { canSubmitClose, closeErrorKey, countPreview } from "../_lib/close";
import { parseCash } from "../_lib/till";
import { loadQueue } from "../_lib/offline-db";

type Props = {
  locale: Locale;
  shiftId: string;
  registerId: string;
  currency: CurrencyCode;
  cash: CashBreakdown;
};

/**
 * Shift close (T7, shift-close-spec.md): show the expected cash, take the count, note any
 * difference, then close. The server recomputes the expected cash under a lock and is the authority.
 */
/** What the server said about the register's offline device (OF14). */
type Unsynced = { offlineCode: string | null; queued: number; reportedAt: string | null };

export function CloseShift({ locale, shiftId, registerId, currency, cash }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const money = (minor: number) => formatMoney(minor, currency, locale);

  const [open, setOpen] = useState(false);
  const [countedRaw, setCountedRaw] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [result, setResult] = useState<ShiftCloseSummary | null>(null);
  // Set when the server found a difference this screen did not (its expected cash was stale).
  const [serverNeedsNote, setServerNeedsNote] = useState(false);
  // OF14: sales this browser still holds (the close waits for them), and another device's report (needs a note).
  const [queuedHere, setQueuedHere] = useState(0);
  const [unsynced, setUnsynced] = useState<Unsynced | null>(null);
  const [unsyncedNote, setUnsyncedNote] = useState("");
  // True until a refresh of the server data (the expected cash) has landed.
  const [refreshing, startRefresh] = useTransition();

  const counted = countPreview(cash.expectedCashMinor, countedRaw, currency);
  const preview = { ...counted, noteRequired: counted.noteRequired || serverNeedsNote };
  const ready = canSubmitClose(preview, note, pending || refreshing) && (!unsynced || unsyncedNote.trim() !== "");

  function refresh() {
    startRefresh(() => router.refresh());
  }

  function reset() {
    setOpen(false);
    setCountedRaw("");
    setNote("");
    setError(null);
    setServerNeedsNote(false);
    setQueuedHere(0);
    setUnsynced(null);
    setUnsyncedNote("");
  }

  /** The till never closes over its own unsynced offline sales (OF14): they replay every 30 s once it is online. */
  async function countUnsyncedHere(): Promise<number> {
    const held = await loadQueue(registerId).catch(() => []);
    const waiting = held.filter((entry) => entry.status === "PENDING").length;
    setQueuedHere(waiting);
    return waiting;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || preview.countedMinor === null) return;
    setPending(true);
    setError(null);
    if ((await countUnsyncedHere()) > 0) {
      setPending(false);
      return;
    }
    const result = await safeAction(() =>
      closeShiftAction(shiftId, {
        countedCashMinor: preview.countedMinor ?? 0,
        // Only a note the cashier can see is sent; a note left from an earlier count is dropped.
        discrepancyNote: preview.noteRequired && note.trim() !== "" ? note.trim() : null,
        unsyncedNote: unsynced && unsyncedNote.trim() !== "" ? unsyncedNote.trim() : null,
      }),
    );
    setPending(false);
    if (result.ok) {
      setResult(result.data);
      return;
    }
    const details = result.error.details as ({ reason?: string } & Partial<Unsynced>) | null;
    if (details?.reason === "OFFLINE_SALES_UNSYNCED") {
      setUnsynced({
        offlineCode: details.offlineCode ?? null,
        queued: details.queued ?? 0,
        reportedAt: details.reportedAt ?? null,
      });
      return;
    }
    const key = closeErrorKey(result.error);
    setError(key);
    if (key === "pos.close.noteRequired") {
      // The cash moved since this screen loaded: show the note box and the fresh expected cash.
      setServerNeedsNote(true);
      refresh();
    }
    // Another device closed it: reload into the "no open shift" state.
    if (key === "pos.close.alreadyClosed") refresh();
  }

  if (result) {
    return (
      <section
        aria-labelledby="close-result-title"
        className="flex max-w-md flex-col gap-3 rounded-md border border-border p-4"
      >
        <h2 id="close-result-title" className="text-xl font-semibold">
          {tr("pos.close.resultTitle")}
        </h2>
        <dl className="grid grid-cols-2 gap-1">
          <dt>{tr("pos.close.expected")}</dt>
          <dd dir="ltr" className="text-end">
            {money(result.expectedCashMinor)}
          </dd>
          <dt>{tr("pos.close.counted")}</dt>
          <dd dir="ltr" className="text-end">
            {money(result.countedCashMinor)}
          </dd>
          <dt>{tr("pos.close.difference")}</dt>
          <dd dir="ltr" className="text-end" data-testid="close-difference">
            {money(result.discrepancyMinor)}
          </dd>
        </dl>
        {result.discrepancyNote ? <p className="text-sm text-muted">{result.discrepancyNote}</p> : null}
        <div className="flex flex-wrap gap-2">
          <PrintZReportButton locale={locale} shiftId={result.id} />
          <button
            type="button"
            onClick={() => router.refresh()}
            autoFocus
            className="rounded-md bg-foreground px-4 py-2 text-background"
          >
            {tr("pos.close.done")}
          </button>
        </div>
      </section>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={async () => {
            // Checked before any server call: offline, a refresh would reload the whole page.
            if ((await countUnsyncedHere()) > 0) return;
            // Sales from another device may have moved the cash since this page loaded. Closing
            // waits until the fresh numbers have landed.
            refresh();
            setOpen(true);
          }}
          className="self-start rounded-md border border-border px-4 py-2"
        >
          {tr("pos.close.open")}
        </button>
        {queuedHere > 0 ? (
          <p role="alert" className="max-w-xs text-sm text-red-700" data-testid="close-offline-queued">
            {tr("pos.close.offlineQueued", { count: String(queuedHere) })}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="close-title"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) reset();
      }}
      className="flex max-w-md flex-col gap-4 rounded-md border border-border p-4"
    >
      <h2 id="close-title" className="text-xl font-semibold">
        {tr("pos.close.title")}
      </h2>
      <p className="text-muted">{tr("pos.close.intro")}</p>

      <dl className="grid grid-cols-2 gap-1 aria-busy:opacity-50" aria-busy={refreshing} data-testid="close-breakdown">
        <dt>{tr("pos.close.openingFloat")}</dt>
        <dd dir="ltr" className="text-end">
          {money(cash.openingFloatMinor)}
        </dd>
        <dt>{tr("pos.close.cashSales")}</dt>
        <dd dir="ltr" className="text-end">
          {money(cash.cashSalesMinor)}
        </dd>
        <dt>{tr("pos.close.payIn")}</dt>
        <dd dir="ltr" className="text-end">
          {money(cash.payInMinor)}
        </dd>
        <dt>{tr("pos.close.payOut")}</dt>
        <dd dir="ltr" className="text-end">
          {money(cash.payOutMinor === 0 ? 0 : -cash.payOutMinor)}
        </dd>
        <dt>{tr("pos.close.drop")}</dt>
        <dd dir="ltr" className="text-end">
          {money(cash.dropMinor === 0 ? 0 : -cash.dropMinor)}
        </dd>
        <dt>{tr("pos.close.cashRefunds")}</dt>
        <dd dir="ltr" className="text-end">
          {money(cash.cashRefundsMinor === 0 ? 0 : -cash.cashRefundsMinor)}
        </dd>
        <dt className="font-semibold">{tr("pos.close.expected")}</dt>
        <dd dir="ltr" className="text-end font-semibold" data-testid="close-expected">
          {money(cash.expectedCashMinor)}
        </dd>
      </dl>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>
            {tr("pos.close.counted")} ({currency})
          </span>
          <input
            dir="ltr"
            inputMode="decimal"
            value={countedRaw}
            onChange={(e) => setCountedRaw(e.target.value)}
            aria-invalid={countedRaw.trim() !== "" && preview.countedMinor === null}
            className="rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        {countedRaw.trim() !== "" && parseCash(countedRaw, currency) === null ? (
          <p className="text-red-700">{tr("pos.close.invalidCount")}</p>
        ) : preview.differenceMinor !== null ? (
          <p>
            {tr("pos.close.difference")}:{" "}
            <strong dir="ltr" data-testid="close-live-difference">
              {money(preview.differenceMinor)}
            </strong>
          </p>
        ) : null}

        {preview.noteRequired ? (
          <label className="flex flex-col gap-1">
            <span>{tr("pos.close.noteLabel")}</span>
            <span className="text-sm text-muted">{tr("pos.close.noteHint")}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              className="rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
        ) : null}

        {queuedHere > 0 ? (
          <p role="alert" className="text-red-700" data-testid="close-offline-queued">
            {tr("pos.close.offlineQueued", { count: String(queuedHere) })}
          </p>
        ) : null}
        {unsynced ? (
          <label className="flex flex-col gap-1">
            <span role="alert" className="text-red-700" data-testid="close-offline-unsynced">
              {tr("pos.close.offlineUnsynced", {
                code: unsynced.offlineCode ?? "—",
                count: String(unsynced.queued),
                time: unsynced.reportedAt ? new Date(unsynced.reportedAt).toLocaleTimeString(locale) : "—",
              })}
            </span>
            <span>{tr("pos.close.offlineNoteLabel")}</span>
            <textarea
              value={unsyncedNote}
              onChange={(e) => setUnsyncedNote(e.target.value)}
              maxLength={500}
              rows={2}
              className="rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="text-red-700">
            {plain(locale, error)}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!ready}
            className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            {pending ? tr("pos.close.closing") : tr("pos.close.submit")}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={pending}
            className="rounded-md border border-border px-4 py-2"
          >
            {tr("pos.close.cancel")}
          </button>
        </div>
      </form>
    </section>
  );
}
