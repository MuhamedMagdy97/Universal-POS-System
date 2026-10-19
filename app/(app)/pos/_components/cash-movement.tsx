"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import type { CurrencyCode } from "@/lib/money";
import { plain, safeAction } from "../../inventory/_lib/form";
import { addCashMovementAction } from "../actions";
import { movementDraft, movementErrorKey, movementTypesFor, type CashMovementType } from "../_lib/close";
import { parseCash } from "../_lib/till";

type Props = {
  locale: Locale;
  shiftId: string;
  currency: CurrencyCode;
  canCloseShift: boolean;
};

/**
 * Pay-in, pay-out and drop on the open shift (T7, shift-close-data-model-and-api.md §4–5). The API has
 * no replay, so the button stays disabled while a request is in flight and a lost reply is not retried.
 */
export function CashMovement({ locale, shiftId, currency, canCloseShift }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const types = movementTypesFor(canCloseShift);

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CashMovementType>("PAY_IN");
  const [amountRaw, setAmountRaw] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);

  const draft = movementDraft(type, amountRaw, reason, currency);
  const amountInvalid = amountRaw.trim() !== "" && !((parseCash(amountRaw, currency) ?? 0) >= 1);

  function reset() {
    setOpen(false);
    setType("PAY_IN");
    setAmountRaw("");
    setReason("");
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    const result = await safeAction(() => addCashMovementAction(shiftId, draft));
    setPending(false);
    if (result.ok) {
      reset();
      setSaved(true);
      // The close panel's expected cash includes this movement after the refresh.
      router.refresh();
      return;
    }
    const key = movementErrorKey(result.error);
    setError(key);
    // Closed elsewhere, or the reply was lost: reload so the screen shows what the server holds.
    if (key === "pos.close.alreadyClosed" || key === "pos.cash.unknown") router.refresh();
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        {saved ? (
          <p role="status" className="text-sm text-muted">
            {tr("pos.cash.saved")}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setSaved(false);
            setOpen(true);
          }}
          className="rounded-md border border-border px-4 py-2"
        >
          {tr("pos.cash.open")}
        </button>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="cash-title"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) reset();
      }}
      className="flex max-w-md flex-col gap-4 rounded-md border border-border p-4"
    >
      <h2 id="cash-title" className="text-xl font-semibold">
        {tr("pos.cash.title")}
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1">{tr("pos.cash.type")}</legend>
          {types.map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input type="radio" name="cash-type" value={t} checked={type === t} onChange={() => setType(t)} />
              {plain(locale, `pos.cash.${t}`)}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1">
          <span>
            {tr("pos.cash.amount")} ({currency})
          </span>
          <input
            dir="ltr"
            inputMode="decimal"
            value={amountRaw}
            onChange={(e) => setAmountRaw(e.target.value)}
            aria-invalid={amountInvalid}
            autoFocus
            className="rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        {amountInvalid ? <p className="text-red-700">{tr("pos.cash.invalidAmount")}</p> : null}
        <label className="flex flex-col gap-1">
          <span>{tr("pos.cash.reason")}</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            className="rounded-md border border-border bg-background px-3 py-2"
          />
        </label>

        {error ? (
          <p role="alert" className="text-red-700">
            {plain(locale, error)}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!draft || pending}
            className="rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
          >
            {pending ? tr("pos.cash.saving") : tr("pos.cash.submit")}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={pending}
            className="rounded-md border border-border px-4 py-2"
          >
            {tr("pos.cash.cancel")}
          </button>
        </div>
      </form>
    </section>
  );
}
