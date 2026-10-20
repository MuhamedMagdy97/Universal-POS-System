"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import type { CurrencyCode } from "@/lib/money";
import { SUPPLIER_PAYMENT_METHODS, type SupplierPaymentMethod } from "@/modules/purchasing/schemas";
import type { OpenInvoice } from "@/modules/purchasing/rules";
import { recordPaymentAction, reversePaymentAction } from "../actions";
import { AllocationEditor, allocationLines, suggestAllocation, type AllocationValues } from "./supplier-invoices";
import { errorKey, parseCost, plain, safeAction } from "../_lib/purchasing";

const INPUT = "rounded-md border border-border bg-background px-3 py-2";

type FormProps = {
  locale: Locale;
  currency: CurrencyCode;
  supplierId: string;
  today: string;
  pos: { id: string; number: string }[];
  /** Open invoices, oldest first: the payment is allocated across them (supplier-invoices-spec I9). */
  openInvoices: OpenInvoice[];
};

/**
 * Record a payment to the supplier (supplier-payments-spec S4, S5). One Idempotency-Key per form,
 * kept across retries, so a double submit never pays twice (S8).
 */
export function PaymentForm({ locale, currency, supplierId, today, pos, openInvoices }: FormProps) {
  const tr = translator(locale);
  const router = useRouter();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<SupplierPaymentMethod>("BANK_TRANSFER");
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  // Suggested oldest first from the amount until edited by hand.
  const [allocations, setAllocations] = useState<AllocationValues | null>(null);
  const typedMinor = parseCost(amount, currency);
  const allocationValues = allocations ?? suggestAllocation(typedMinor ?? 0, openInvoices, currency);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amountMinor = parseCost(amount, currency);
    if (amountMinor === null || amountMinor === 0) {
      setError(tr("purchasing.error.amount"));
      return;
    }
    const lines = allocationLines(allocationValues, currency);
    if (lines === null) {
      setError(tr("purchasing.error.amount"));
      return;
    }
    setPending(true);
    const result = await safeAction(() =>
      recordPaymentAction(supplierId, key, {
        amountMinor,
        method,
        paidOn,
        reference,
        note,
        purchaseOrderId: purchaseOrderId || null,
        allocations: lines,
      }),
    );
    setPending(false);
    if (!result.ok) {
      setError(plain(locale, errorKey(result.error)));
      return;
    }
    setError(null);
    setAmount("");
    setReference("");
    setNote("");
    setPurchaseOrderId("");
    setAllocations(null);
    setKey(crypto.randomUUID());
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h2 className="text-lg font-semibold">{tr("purchasing.payment.record")}</h2>
      <p className="text-sm text-muted">{tr("purchasing.payment.hint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.payment.amount")}</span>
          <input
            dir="ltr"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`w-36 ${INPUT}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.payment.method")}</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as SupplierPaymentMethod)} className={INPUT}>
            {SUPPLIER_PAYMENT_METHODS.map((value) => (
              <option key={value} value={value}>
                {tr(`purchasing.method.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.payment.date")}</span>
          <input
            type="date"
            dir="ltr"
            required
            max={today}
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tr("purchasing.payment.reference")}</span>
          <input
            dir="ltr"
            maxLength={80}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className={INPUT}
          />
        </label>
        {pos.length > 0 ? (
          <label className="flex flex-col gap-1">
            <span>{tr("purchasing.payment.po")}</span>
            <select value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)} className={INPUT}>
              <option value="">{tr("purchasing.payment.poNone")}</option>
              {pos.map((po) => (
                <option key={po.id} value={po.id}>
                  {po.number}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <AllocationEditor
        locale={locale}
        currency={currency}
        invoices={openInvoices}
        values={allocationValues}
        onChange={setAllocations}
      />
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
        {tr("purchasing.payment.submit")}
      </button>
    </form>
  );
}

type ReverseProps = { locale: Locale; supplierId: string; paymentId: string; label: string };

/** Reverse one payment with a reason (S9). Opens inline; one key per opened form. */
export function ReversePayment({ locale, supplierId, paymentId, label }: ReverseProps) {
  const tr = translator(locale);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    const result = await safeAction(() => reversePaymentAction(supplierId, paymentId, key, reason));
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
        aria-label={`${tr("purchasing.payment.reverse")} ${label}`}
        className="rounded-md border border-border px-2 py-0.5 text-xs"
      >
        {tr("purchasing.payment.reverse")}
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input
        required
        maxLength={500}
        aria-label={tr("purchasing.payment.reverseReason")}
        placeholder={tr("purchasing.payment.reverseReason")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={pending || reason.trim() === ""}
        className="rounded-md bg-foreground px-2 py-1 text-xs text-background disabled:opacity-50"
      >
        {tr("purchasing.payment.reverseSubmit")}
      </button>
      {error ? (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      ) : null}
    </form>
  );
}
