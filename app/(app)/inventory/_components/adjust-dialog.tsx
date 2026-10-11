"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { normalizeQty, type AdjustmentReasonValue } from "@/modules/inventory/schemas";
import { adjustStockAction } from "../actions";
import {
  adjustReasonsFor,
  directionOf,
  errorMessageKey,
  needsNote,
  normalizeCount,
  plain,
  previewAfter,
  safeAction,
  signedDelta,
  type ItemRef,
} from "../_lib/form";

type Props = {
  locale: Locale;
  open: boolean;
  onClose: () => void;
  branchId: string;
  itemRef: ItemRef;
  itemLabel: string;
  onHand: number;
  /** Archived items may only lose stock: increase reasons are hidden and the sign is fixed to "remove". */
  archived?: boolean;
};

const DEFAULT_REASON: AdjustmentReasonValue = "COUNT_CORRECTION";

/**
 * Adjust dialog (UX §2.3). Sends `expectedOnHand`; a stale answer updates the preview and asks
 * the user to confirm again. The sign is fixed by the reason, except for reasons that allow both.
 * The form starts empty every time it opens, so a second open cannot repeat the last adjustment.
 */
export function AdjustDialog({ locale, open, onClose, branchId, itemRef, itemLabel, onHand, archived = false }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState<AdjustmentReasonValue>(DEFAULT_REASON);
  const [mode, setMode] = useState<"delta" | "counted">("counted");
  const [qty, setQty] = useState("");
  const [sign, setSign] = useState<"+" | "-">("+");
  const [note, setNote] = useState("");
  const [current, setCurrent] = useState(onHand);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setReason(DEFAULT_REASON);
      setMode("counted");
      setQty("");
      setSign(archived ? "-" : "+");
      setNote("");
      setCurrent(onHand);
      setError(null);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, onHand, archived]);

  const reasonLabel = (value: AdjustmentReasonValue) => plain(locale, `inventory.reason.${value}` as MessageKey);
  const isCount = reason === "COUNT_CORRECTION";
  const effectiveMode = isCount ? mode : "delta";
  const effectiveSign = archived ? "-" : sign;
  // Counted quantities may be 0; a change must be at least 1. Arabic-Indic digits are read by the parsers.
  const counted = qty.trim() === "" ? null : normalizeCount(qty);
  const amount = normalizeQty(qty);
  const delta =
    effectiveMode === "counted"
      ? counted === null
        ? null
        : counted - current
      : amount === null
        ? null
        : signedDelta({ reason, qty: amount, sign: effectiveSign });
  const after = delta === null ? null : previewAfter(current, delta);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (delta === null) {
      setError(tr("inventory.error.generic"));
      return;
    }
    if (delta === 0) {
      setError(tr("inventory.error.noChange"));
      return;
    }
    if (needsNote(reason) && note.trim() === "") {
      setError(tr("inventory.error.noteRequired"));
      return;
    }
    setPending(true);
    const base = { branchId, ref: itemRef, adjustmentReason: reason, note: note || undefined, expectedOnHand: current };
    const payload = effectiveMode === "counted" ? { ...base, countedQty: counted ?? 0 } : { ...base, qtyDelta: delta };
    const result = await safeAction(() => adjustStockAction(payload));
    setPending(false);
    if (result.ok) {
      onClose();
      router.refresh();
      return;
    }
    if (result.error.code === "CONFLICT" && (result.error.details as { reason?: string })?.reason === "STALE_STOCK") {
      const latest = (result.error.details as { onHand: number }).onHand;
      setCurrent(latest);
      setError(tr("inventory.adjust.stale", { onHand: latest }));
      return;
    }
    setError(plain(locale, errorMessageKey(result.error)));
  }

  const showSign = effectiveMode === "delta" && directionOf(reason) === "either" && !archived;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="w-full max-w-md rounded-md border border-border bg-background p-6 text-foreground backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <h2 id={titleId} className="text-lg font-semibold">
          {tr("inventory.adjust.title")}: {itemLabel}
        </h2>

        <label className="flex flex-col gap-1">
          <span>{tr("inventory.adjust.reason")}</span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as AdjustmentReasonValue)}
            className="rounded-md border border-border bg-background px-3 py-2"
          >
            {adjustReasonsFor(archived).map((value) => (
              <option key={value} value={value}>
                {reasonLabel(value)}
              </option>
            ))}
          </select>
        </label>

        {isCount ? (
          <fieldset className="flex gap-4">
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === "counted"} onChange={() => setMode("counted")} />
              {tr("inventory.adjust.mode.counted")}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === "delta"} onChange={() => setMode("delta")} />
              {tr("inventory.adjust.mode.delta")}
            </label>
          </fieldset>
        ) : null}

        <div className="flex gap-2">
          {showSign ? (
            <select
              aria-label={`${tr("inventory.adjust.sign.plus")} / ${tr("inventory.adjust.sign.minus")}`}
              value={sign}
              onChange={(e) => setSign(e.target.value as "+" | "-")}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              <option value="+">{tr("inventory.adjust.sign.plus")}</option>
              <option value="-">{tr("inventory.adjust.sign.minus")}</option>
            </select>
          ) : null}
          <label className="flex flex-1 flex-col gap-1">
            <span>{effectiveMode === "counted" ? tr("inventory.adjust.counted") : tr("inventory.adjust.qty")}</span>
            <input
              dir="ltr"
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span>{tr("inventory.adjust.note")}</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            required={needsNote(reason)}
            className="rounded-md border border-border bg-background px-3 py-2"
          />
        </label>

        <p className="text-muted">
          {after === null ? null : tr("inventory.adjust.preview", { from: current, to: after })}
        </p>

        {error ? (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        ) : null}

        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2">
            {tr("inventory.adjust.cancel")}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            {tr("inventory.adjust.submit")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
