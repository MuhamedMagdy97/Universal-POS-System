"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { formatMinor, sum, type CurrencyCode } from "@/lib/money";
import { allocateOldestFirst, defaultInputVat, maxInputVat, type OpenInvoice } from "@/modules/purchasing/rules";
import type { SupplierDocumentKind } from "@/modules/purchasing/schemas";
import { allocatePaymentAction, recordInvoiceAction, voidInvoiceAction } from "../actions";
import { costText, errorKey, parseCost, plain, safeAction } from "../_lib/purchasing";

/**
 * Supplier invoices and credit notes (supplier-invoices-spec I1–I6, I9, I16). One Idempotency-Key per
 * form, kept across retries, so a double submit never records twice.
 */

const INPUT = "rounded-md border border-border bg-background px-3 py-2";

export type PickRow = { id: string; number: string; day: string; valueMinor: number };

type InvoiceFormProps = {
  locale: Locale;
  currency: CurrencyCode;
  supplierId: string;
  today: string;
  vatRateBp: number;
  receipts: PickRow[];
  returns: PickRow[];
  openInvoices: OpenInvoice[];
};

export function InvoiceForm(props: InvoiceFormProps) {
  const { locale, currency, supplierId, today, vatRateBp } = props;
  const tr = translator(locale);
  const router = useRouter();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<SupplierDocumentKind>("INVOICE");
  const [number, setNumber] = useState("");
  const [issuedOn, setIssuedOn] = useState(today);
  const [dueOn, setDueOn] = useState("");
  const [receiptIds, setReceiptIds] = useState<string[]>([]);
  const [returnId, setReturnId] = useState("");
  const [appliesTo, setAppliesTo] = useState("");
  const [net, setNet] = useState<string | null>(null);
  const [vat, setVat] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInvoice = kind === "INVOICE";
  // Net follows the picked receipts (or return) until typed over; VAT follows the net (I3, I4, I5).
  const linkedMinor = isInvoice
    ? sum(props.receipts.filter((r) => receiptIds.includes(r.id)).map((r) => r.valueMinor))
    : (props.returns.find((r) => r.id === returnId)?.valueMinor ?? 0);
  const netText = net ?? costText(linkedMinor, currency);
  const netMinor = parseCost(netText, currency);
  const suggestedVat = netMinor === null ? 0 : defaultInputVat(netMinor, vatRateBp);
  const vatText = vat ?? costText(suggestedVat, currency);
  const vatMinor = parseCost(vatText, currency);
  const totalMinor = netMinor !== null && vatMinor !== null ? netMinor + vatMinor : null;
  const vatTooHigh = netMinor !== null && vatMinor !== null && vatMinor > maxInputVat(netMinor, vatRateBp);
  const vatLow = netMinor !== null && vatMinor !== null && vatMinor < suggestedVat;

  function reset(next: SupplierDocumentKind) {
    setKind(next);
    setReceiptIds([]);
    setReturnId("");
    setAppliesTo("");
    setDueOn("");
    setNet(null);
    setVat(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (netMinor === null || vatMinor === null || totalMinor === null || totalMinor === 0) {
      setError(tr("purchasing.error.amount"));
      return;
    }
    setPending(true);
    const result = await safeAction(() =>
      recordInvoiceAction(supplierId, key, {
        kind,
        number,
        issuedOn,
        dueOn: isInvoice && dueOn ? dueOn : null,
        netMinor,
        vatMinor,
        note,
        goodsReceiptIds: isInvoice ? receiptIds : [],
        purchaseReturnId: !isInvoice && returnId ? returnId : null,
        appliesToInvoiceId: !isInvoice && appliesTo ? appliesTo : null,
      }),
    );
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, errorKey(result.error)));
      return;
    }
    setError(null);
    setNumber("");
    setNote("");
    reset(kind);
    setKey(crypto.randomUUID());
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h2 className="text-lg font-semibold">{tr("purchasing.invoice.record")}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.invoice.kind")}</span>
          <select value={kind} onChange={(e) => reset(e.target.value as SupplierDocumentKind)} className={INPUT}>
            <option value="INVOICE">{tr("purchasing.invoice.kind.INVOICE")}</option>
            <option value="CREDIT_NOTE">{tr("purchasing.invoice.kind.CREDIT_NOTE")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.invoice.number")}</span>
          <input
            dir="ltr"
            required
            maxLength={40}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            className={`w-40 ${INPUT}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.invoice.issuedOn")}</span>
          <input
            type="date"
            dir="ltr"
            required
            max={today}
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
            className={INPUT}
          />
        </label>
        {isInvoice ? (
          <label className="flex flex-col gap-1">
            <span>{tr("purchasing.invoice.dueOn")}</span>
            <input
              type="date"
              dir="ltr"
              min={issuedOn}
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
              className={INPUT}
            />
          </label>
        ) : null}
      </div>

      {isInvoice ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1">{tr("purchasing.invoice.receipts")}</legend>
          {props.receipts.length === 0 ? (
            <p className="text-sm text-muted">{tr("purchasing.invoice.noReceipts")}</p>
          ) : (
            props.receipts.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={receiptIds.includes(r.id)}
                  onChange={(e) => {
                    setReceiptIds((ids) => (e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id)));
                    setNet(null);
                    setVat(null);
                  }}
                />
                <span dir="ltr">{`${r.day} · ${r.number}`}</span>
                <span className="tabular-nums" dir="ltr">
                  {formatMinor(r.valueMinor, currency, locale)}
                </span>
              </label>
            ))
          )}
        </fieldset>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span>{tr("purchasing.invoice.return")}</span>
            <select
              value={returnId}
              onChange={(e) => {
                setReturnId(e.target.value);
                setNet(null);
                setVat(null);
              }}
              className={INPUT}
            >
              <option value="">{tr("purchasing.payment.poNone")}</option>
              {props.returns.map((r) => (
                <option key={r.id} value={r.id}>
                  {`${r.day} · ${r.number} · ${formatMinor(r.valueMinor, currency, locale)}`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{tr("purchasing.invoice.appliesTo")}</span>
            <select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)} className={INPUT}>
              <option value="">{tr("purchasing.payment.poNone")}</option>
              {props.openInvoices.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {`${inv.number} · ${formatMinor(inv.openMinor, currency, locale)}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.invoice.net")}</span>
          <input
            dir="ltr"
            inputMode="decimal"
            required
            value={netText}
            onChange={(e) => setNet(e.target.value)}
            className={`w-36 ${INPUT}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.invoice.vat")}</span>
          <input
            dir="ltr"
            inputMode="decimal"
            required
            value={vatText}
            onChange={(e) => setVat(e.target.value)}
            className={`w-36 ${INPUT}`}
          />
        </label>
        <p className="py-2">
          {tr("purchasing.invoice.total")}{" "}
          <span className="font-semibold tabular-nums" dir="ltr" data-testid="invoice-total">
            {totalMinor === null ? "—" : formatMinor(totalMinor, currency, locale)}
          </span>
        </p>
      </div>
      {vatTooHigh ? (
        <p className="text-sm text-red-700">{tr("purchasing.error.VAT_ABOVE_RATE")}</p>
      ) : vatLow ? (
        <p className="text-sm text-amber-700">{tr("purchasing.invoice.vatLow")}</p>
      ) : null}
      <label className="flex flex-col gap-1">
        <span>{tr("purchasing.payment.note")}</span>
        <input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} />
      </label>
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
      >
        {tr("purchasing.invoice.submit")}
      </button>
    </form>
  );
}

type VoidProps = { locale: Locale; supplierId: string; invoiceId: string; label: string };

/** Void one document with a reason (I6). */
export function VoidInvoice({ locale, supplierId, invoiceId, label }: VoidProps) {
  const tr = translator(locale);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    const result = await safeAction(() => voidInvoiceAction(supplierId, invoiceId, reason));
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, errorKey(result.error)));
      return;
    }
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${tr("purchasing.invoice.void")} ${label}`}
        className="rounded-md border border-border px-2 py-0.5 text-xs"
      >
        {tr("purchasing.invoice.void")}
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input
        required
        maxLength={500}
        aria-label={tr("purchasing.invoice.voidReason")}
        placeholder={tr("purchasing.invoice.voidReason")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={pending || reason.trim() === ""}
        className="rounded-md bg-foreground px-2 py-1 text-xs text-background disabled:opacity-50"
      >
        {tr("purchasing.invoice.voidSubmit")}
      </button>
      {error ? (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      ) : null}
    </form>
  );
}

export type AllocationValues = Record<string, string>;

/** Oldest-first suggestion as editable text per invoice (I9). */
export function suggestAllocation(
  amountMinor: number,
  invoices: OpenInvoice[],
  currency: CurrencyCode,
): AllocationValues {
  const values: AllocationValues = {};
  for (const line of allocateOldestFirst(amountMinor, invoices))
    values[line.invoiceId] = costText(line.amountMinor, currency);
  return values;
}

/** Typed allocation amounts → lines (blank or 0 skipped), or null if any amount is not valid. */
export function allocationLines(
  values: AllocationValues,
  currency: CurrencyCode,
): { invoiceId: string; amountMinor: number }[] | null {
  const lines: { invoiceId: string; amountMinor: number }[] = [];
  for (const [invoiceId, text] of Object.entries(values)) {
    if (text.trim() === "") continue;
    const amountMinor = parseCost(text, currency);
    if (amountMinor === null) return null;
    if (amountMinor > 0) lines.push({ invoiceId, amountMinor });
  }
  return lines;
}

type EditorProps = {
  locale: Locale;
  currency: CurrencyCode;
  invoices: OpenInvoice[];
  values: AllocationValues;
  onChange: (values: AllocationValues) => void;
};

/** One amount per open invoice, oldest first. */
export function AllocationEditor({ locale, currency, invoices, values, onChange }: EditorProps) {
  const tr = translator(locale);
  if (invoices.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1">{tr("purchasing.allocation.title")}</legend>
      <p className="text-sm text-muted">{tr("purchasing.allocation.hint")}</p>
      {invoices.map((inv) => (
        <label key={inv.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-56" dir="ltr">
            {`${inv.number} · ${inv.dueOn ?? inv.issuedOn}`}
          </span>
          <span className="w-32 tabular-nums text-muted" dir="ltr">
            {formatMinor(inv.openMinor, currency, locale)}
          </span>
          <input
            dir="ltr"
            inputMode="decimal"
            aria-label={`${tr("purchasing.allocation.amount")} ${inv.number}`}
            value={values[inv.id] ?? ""}
            onChange={(e) => onChange({ ...values, [inv.id]: e.target.value })}
            className="w-32 rounded-md border border-border bg-background px-2 py-1"
          />
        </label>
      ))}
    </fieldset>
  );
}

type AllocateProps = {
  locale: Locale;
  currency: CurrencyCode;
  supplierId: string;
  paymentId: string;
  unallocatedMinor: number;
  invoices: OpenInvoice[];
};

/** Allocate what is left of an earlier payment (I9). */
export function AllocatePayment(props: AllocateProps) {
  const { locale, currency } = props;
  const tr = translator(locale);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<AllocationValues>(() =>
    suggestAllocation(props.unallocatedMinor, props.invoices, currency),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const allocations = allocationLines(values, currency);
    if (allocations === null || allocations.length === 0) {
      setError(tr("purchasing.error.amount"));
      return;
    }
    setPending(true);
    const result = await safeAction(() =>
      allocatePaymentAction(props.supplierId, props.paymentId, key, { allocations }),
    );
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, errorKey(result.error)));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2 py-0.5 text-xs"
      >
        {tr("purchasing.allocation.allocate")}
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <AllocationEditor
        locale={locale}
        currency={currency}
        invoices={props.invoices}
        values={values}
        onChange={setValues}
      />
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-foreground px-2 py-1 text-xs text-background disabled:opacity-50"
      >
        {tr("purchasing.allocation.submit")}
      </button>
      {error ? (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      ) : null}
    </form>
  );
}
