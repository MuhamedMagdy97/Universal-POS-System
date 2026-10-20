"use client";

import { useState, type FormEvent } from "react";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { parsePercentBp } from "@/lib/money";
import type { ReceiptSettings } from "@/modules/org";
import { plain, safeAction } from "../../inventory/_lib/form";
import { saveReceiptSettingsAction } from "../actions";

type Field = Exclude<keyof ReceiptSettings, "name" | "maxCashierDiscountBp" | "countryCode">;

const FIELDS: { key: Field; label: MessageKey; max: number; ltr?: boolean }[] = [
  { key: "legalName", label: "settings.receipt.legalName", max: 120 },
  { key: "taxNumber", label: "settings.receipt.taxNumber", max: 40, ltr: true },
  { key: "receiptAddress", label: "settings.receipt.address", max: 200 },
  { key: "receiptPhone", label: "settings.receipt.phone", max: 40, ltr: true },
  { key: "receiptHeader", label: "settings.receipt.header", max: 200 },
  { key: "receiptFooter", label: "settings.receipt.footer", max: 200 },
];

/** The six receipt fields (T10 H3), and the cashier discount limit (discounts-spec DC8). An empty field is saved as "not printed". */
export function ReceiptSettingsForm({ locale, initial }: { locale: Locale; initial: ReceiptSettings }) {
  const tr = translator(locale);
  const [values, setValues] = useState<Record<Field, string>>(
    () => Object.fromEntries(FIELDS.map(({ key }) => [key, initial[key] ?? ""])) as Record<Field, string>,
  );
  const [limitRaw, setLimitRaw] = useState(String(initial.maxCashierDiscountBp / 100));
  const limitBp = parsePercentBp(limitRaw);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"saved" | "error" | "vat" | null>(null);
  const saudi = initial.countryCode === "SA";

  async function save(event: FormEvent) {
    event.preventDefault();
    if (limitBp === null) return;
    setPending(true);
    setStatus(null);
    const result = await safeAction(() => saveReceiptSettingsAction({ ...values, maxCashierDiscountBp: limitBp }));
    setPending(false);
    const reason = result.ok ? null : (result.error.details as { reason?: string } | null)?.reason;
    setStatus(result.ok ? "saved" : reason === "INVALID_VAT_NUMBER" ? "vat" : "error");
  }

  return (
    <form onSubmit={save} className="flex max-w-lg flex-col gap-3">
      {FIELDS.map((field) => (
        <label key={field.key} className="flex flex-col gap-1">
          <span>{plain(locale, field.label)}</span>
          <input
            name={field.key}
            value={values[field.key]}
            maxLength={field.max}
            dir={field.ltr ? "ltr" : undefined}
            placeholder={field.key === "legalName" ? initial.name : undefined}
            aria-describedby={saudi && field.key === "taxNumber" ? "vat-hint" : undefined}
            onChange={(e) => setValues((current) => ({ ...current, [field.key]: e.target.value }))}
            className="rounded-md border border-border bg-background px-3 py-2"
          />
          {saudi && field.key === "taxNumber" ? (
            <span id="vat-hint" className="text-sm text-muted">
              {tr("settings.receipt.vatHintSA")}
            </span>
          ) : null}
        </label>
      ))}
      <label className="flex flex-col gap-1">
        <span>{tr("settings.discount.limit")}</span>
        <input
          name="maxCashierDiscount"
          dir="ltr"
          inputMode="decimal"
          value={limitRaw}
          aria-invalid={limitBp === null}
          aria-describedby="discount-limit-hint"
          onChange={(e) => setLimitRaw(e.target.value)}
          className="w-32 rounded-md border border-border bg-background px-3 py-2"
        />
        <span id="discount-limit-hint" className="text-sm text-muted">
          {tr("settings.discount.limitHint")}
        </span>
      </label>
      {status === "saved" ? (
        <p role="status" className="text-green-800">
          {tr("settings.receipt.saved")}
        </p>
      ) : null}
      {status === "vat" ? (
        <p role="alert" className="text-red-700">
          {tr("settings.receipt.vatInvalid")}
        </p>
      ) : null}
      {status === "error" ? (
        <p role="alert" className="text-red-700">
          {tr("settings.receipt.error")}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending || limitBp === null}
        className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
      >
        {pending ? tr("settings.receipt.saving") : tr("settings.receipt.save")}
      </button>
    </form>
  );
}
