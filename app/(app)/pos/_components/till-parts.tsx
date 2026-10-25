"use client";

import { useState } from "react";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { formatQty, parseQtyInput, type QtyUnit } from "@/lib/quantity";
import type { ReceiptDoc } from "@/modules/sales";
import type { Discount } from "@/modules/sales/totals";
import { plain } from "../../inventory/_lib/form";
import { ReceiptSlip } from "../../_components/receipt-print";
import { usePrinter } from "../../_components/printing";
import { stockShort } from "../_lib/till";
import type { OfflineBlock } from "../_lib/offline";
import type { useOfflineTill } from "../_lib/use-offline";

/** Self-contained parts of the till, moved out of till.tsx (business-profiles-spec BP6). */

export type DiscountDraft = { target: string | "SALE"; kind: Discount["kind"]; raw: string; invalid: boolean };

/**
 * The weight box (weighed-selling-spec W5): a KG item asks for its weight in kg (up to 3 decimals) before it joins the
 * cart. Enter adds, Esc or Cancel drops it. `onAdd` gets grams.
 */
export function WeightBox({
  locale,
  name,
  priceLabel,
  inputRef,
  onAdd,
  onCancel,
}: {
  locale: Locale;
  name: string;
  priceLabel: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onAdd: (grams: number) => void;
  onCancel: () => void;
}) {
  const tr = translator(locale);
  const [raw, setRaw] = useState("");
  const [invalid, setInvalid] = useState(false);
  function add() {
    const grams = parseQtyInput(raw, "KG");
    if (grams === null) setInvalid(true);
    else onAdd(grams);
  }
  return (
    <div role="group" aria-labelledby="weight-title" className="card flex flex-col gap-2 p-3" data-testid="weight-box">
      <p id="weight-title" className="font-semibold">
        {name} <span className="text-sm font-normal text-muted">({priceLabel})</span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="field">
          <span>{tr("pos.weight.label")}</span>
          <input
            ref={inputRef}
            dir="ltr"
            inputMode="decimal"
            autoFocus
            placeholder="0.000"
            value={raw}
            aria-invalid={invalid}
            aria-describedby={invalid ? "weight-invalid" : undefined}
            onChange={(e) => {
              setRaw(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className="input w-32 text-lg tabular-nums"
          />
        </label>
        <button type="button" onClick={add} className="btn btn-primary">
          {tr("pos.weight.add")}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost">
          {tr("pos.discount.cancel")}
        </button>
      </div>
      {invalid ? (
        <p id="weight-invalid" role="alert" className="notice notice-error">
          {tr("pos.weight.invalid")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The discount box (F6 / F7): a number and a percent-or-amount switch. Enter applies, Esc cancels
 * (handled by the till's key listener), an empty box removes the discount. Not a form: the sale
 * discount opens from inside the charge form.
 */
export function DiscountBox({
  locale,
  draft,
  inputRef,
  currency,
  limitLabel,
  title,
  onChange,
  onApply,
  onCancel,
}: {
  locale: Locale;
  draft: DiscountDraft;
  inputRef: React.RefObject<HTMLInputElement | null>;
  currency: string;
  limitLabel: string | null;
  title: string;
  onChange: (draft: DiscountDraft) => void;
  onApply: (draft: DiscountDraft, clear?: boolean) => void;
  onCancel: () => void;
}) {
  const tr = translator(locale);
  const kinds: { kind: Discount["kind"]; label: string }[] = [
    { kind: "PERCENT", label: tr("pos.discount.percent") },
    { kind: "AMOUNT", label: tr("pos.discount.amount", { currency }) },
  ];
  return (
    <div
      role="group"
      aria-labelledby="discount-title"
      className="card flex flex-col gap-2 p-3"
      data-testid="discount-box"
    >
      <p id="discount-title" className="font-semibold">
        {title}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="field">
          <span>{tr("pos.discount.value")}</span>
          <input
            ref={inputRef}
            dir="ltr"
            inputMode="decimal"
            value={draft.raw}
            aria-invalid={draft.invalid}
            aria-describedby={draft.invalid ? "discount-invalid" : undefined}
            onChange={(e) => onChange({ ...draft, raw: e.target.value, invalid: false })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onApply(draft);
              }
            }}
            className="input w-28"
          />
        </label>
        <div role="radiogroup" aria-labelledby="discount-title" className="flex gap-1">
          {kinds.map((option) => (
            <label
              key={option.kind}
              className="flex items-center gap-1 min-h-12 cursor-pointer rounded-lg border border-border-strong px-4 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="radio"
                name="discount-kind"
                checked={draft.kind === option.kind}
                onChange={() => onChange({ ...draft, kind: option.kind, invalid: false })}
              />
              {option.label}
            </label>
          ))}
        </div>
        <button type="button" onClick={() => onApply(draft)} className="btn btn-primary">
          {tr("pos.discount.apply")}
        </button>
        <button type="button" onClick={() => onApply(draft, true)} className="btn">
          {tr("pos.discount.remove")}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost">
          {tr("pos.discount.cancel")}
        </button>
      </div>
      {limitLabel ? <p className="text-sm text-muted">{tr("pos.discount.limit", { limit: limitLabel })}</p> : null}
      {draft.invalid ? (
        <p id="discount-invalid" role="alert" className="notice notice-error">
          {tr("pos.discount.invalid")}
        </p>
      ) : null}
    </div>
  );
}

export function ExactCashButton({ locale, onClick }: { locale: Locale; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="btn self-end">
      {translator(locale)("pos.pay.exact")}
    </button>
  );
}

/** On-hand at this branch; red when it is zero, negative or below the line's quantity. Nothing until loaded or when unknown. */
export function StockNote({
  locale,
  onHand,
  qty,
  block,
  unitType = "EACH",
}: {
  locale: Locale;
  onHand?: number | null;
  qty: number;
  block?: boolean;
  /** Grams for KG, shown in kg (weighed-selling-spec W7). */
  unitType?: QtyUnit;
}) {
  if (onHand === undefined || onHand === null) return null;
  return (
    <span
      data-testid="till-stock"
      className={`text-sm ${block ? "block " : ""}${stockShort(onHand, qty) ? "font-semibold text-danger" : "text-muted"}`}
    >
      {translator(locale)("pos.stock.onHand", { qty: formatQty(onHand, unitType, locale) })}
    </span>
  );
}

export const OFFLINE_BLOCK: Record<OfflineBlock, MessageKey> = {
  NOT_ENABLED: "pos.offline.block.NOT_ENABLED",
  NO_DEVICE: "pos.offline.block.NO_DEVICE",
  NO_SHIFT: "pos.offline.block.NO_SHIFT",
  OTHER_USER: "pos.offline.block.OTHER_USER",
  STALE_SNAPSHOT: "pos.offline.block.STALE_SNAPSHOT",
  CONTACT_LIMIT: "pos.offline.block.CONTACT_LIMIT",
  QUEUE_FULL: "pos.offline.block.QUEUE_FULL",
  SESSION_EXPIRED: "pos.offline.block.SESSION_EXPIRED",
  CUSTOMER: "pos.offline.block.CUSTOMER",
};

/**
 * The offline state above the till (OF6, OF13, OF16): the red "Offline — N sales waiting" bar, sales still to
 * sync, refused ones (red, never removed here), and the Owner's button to set this browser up for offline sales.
 */
export function OfflineBar({
  locale,
  off,
  canEnrol,
}: {
  locale: Locale;
  off: ReturnType<typeof useOfflineTill>;
  canEnrol: boolean;
}) {
  const tr = translator(locale);
  const [enrolling, setEnrolling] = useState(false);
  const [enrolFailed, setEnrolFailed] = useState(false);
  const pending = off.queue.filter((entry) => entry.status === "PENDING").length;
  const rejected = off.queue.filter((entry) => entry.status === "REJECTED");
  const showEnrol = canEnrol && !off.device;
  if (!off.offline && pending === 0 && rejected.length === 0 && !showEnrol && !off.device) return null;
  return (
    <div className="flex flex-col gap-2 lg:col-span-2" data-testid="offline-bar">
      {off.offline ? (
        <p role="status" className="rounded-lg bg-danger px-3 py-2 font-semibold text-danger-foreground">
          {tr("pos.offline.bar", { count: String(pending) })}
          {off.block ? ` — ${plain(locale, OFFLINE_BLOCK[off.block])}` : ""}
        </p>
      ) : pending > 0 ? (
        <p role="status" className="text-sm">
          {tr("pos.offline.waiting", { count: String(pending) })}
        </p>
      ) : off.device && off.block === null ? (
        <p className="text-sm text-muted" data-testid="offline-ready">
          {tr("pos.offline.ready", { code: off.device.offlineCode })}
        </p>
      ) : null}
      {off.needsSignIn ? (
        <p role="alert" className="notice notice-error">
          {tr("pos.offline.signIn")}
        </p>
      ) : null}
      {rejected.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="offline-rejected">
          {rejected.map((entry) => (
            <li key={entry.key} role="alert" className="text-danger">
              {tr(entry.error?.code === "IDEMPOTENCY_CONFLICT" ? "pos.offline.rejectedTwice" : "pos.offline.rejected", {
                number: entry.number,
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {showEnrol ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={enrolling}
            onClick={async () => {
              setEnrolling(true);
              setEnrolFailed(!(await off.enrol()));
              setEnrolling(false);
            }}
            className="btn btn-sm"
          >
            {tr("pos.offline.enrol")}
          </button>
          {enrolFailed ? (
            <span role="alert" className="text-danger">
              {tr("pos.offline.enrolFailed")}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The slip of a sale rung up offline, built on the device (OF9); printed from here, it never reaches the server first. */
export function OfflineReceipt({
  locale,
  doc,
  queued,
  onNewSale,
}: {
  locale: Locale;
  doc: ReceiptDoc;
  queued: number;
  onNewSale: () => void;
}) {
  const tr = translator(locale);
  const { print, portal } = usePrinter();
  return (
    <section aria-labelledby="receipt-title" className="card flex max-w-md flex-col gap-3 p-4">
      <h2 id="receipt-title" className="text-xl font-semibold">
        {tr("pos.receipt.title", { number: doc.saleNumber })}
      </h2>
      <p role="status" className="font-semibold text-danger" data-testid="offline-receipt-note">
        {tr("pos.offline.receiptNote", { count: String(queued) })}
      </p>
      <div className="card py-2">
        <ReceiptSlip doc={doc} locale={locale} />
      </div>
      <div className="flex gap-2 print:hidden">
        <button type="button" onClick={() => print(<ReceiptSlip doc={doc} locale={locale} />)} className="btn">
          {tr("pos.receipt.print")}
        </button>
        <button type="button" onClick={onNewSale} autoFocus className="btn btn-primary">
          {tr("pos.receipt.newSale")}
        </button>
      </div>
      {portal}
    </section>
  );
}
