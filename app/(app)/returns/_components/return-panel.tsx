"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import type { SaleForReturns } from "@/modules/sales";
import { plain, safeAction } from "../../inventory/_lib/form";
import { keepKeyAfter } from "../../pos/_lib/till";
import { PrintReceiptButton } from "../../_components/receipt-print";
import { refundSaleAction, voidSaleAction } from "../actions";
import {
  canSubmitRefund,
  lineRefundMinor,
  parseRefundQty,
  planRefund,
  refundableOf,
  returnErrorKey,
} from "../_lib/returns";

type Props = {
  locale: Locale;
  sale: SaleForReturns;
  canRefund: boolean;
  canVoid: boolean;
};

type Method = "CASH" | "CARD_MANUAL" | "WALLET";

const METHODS: { value: Method; label: "returns.refund.cash" | "returns.refund.card" | "returns.refund.wallet" }[] = [
  { value: "CASH", label: "returns.refund.cash" },
  { value: "CARD_MANUAL", label: "returns.refund.card" },
  { value: "WALLET", label: "returns.refund.wallet" },
];

/** Errors after which the page data is stale (someone else refunded, voided or closed meanwhile). */
const RELOAD_AFTER: ReadonlySet<MessageKey> = new Set([
  "returns.error.qtyExceeded",
  "returns.error.voided",
  "returns.error.shiftNotOpen",
  "returns.error.hasRefunds",
  "returns.error.voidShiftClosed",
]);

/**
 * Refund some lines of a sale, or void it (T8). Amounts on screen are a preview with the server's
 * rule; the confirmation shows what the server refunded. After each action the page data reloads.
 */
export function ReturnPanel({ locale, sale, canRefund, canVoid }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const money = (minor: number) => formatMoney(minor, sale.currency, locale);
  const nameOf = (line: { name: string; nameAr: string | null }) =>
    locale === "ar" && line.nameAr ? line.nameAr : line.name;

  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<Method>("CASH");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [refundKey, setRefundKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Printed straight after the action is the original; any later print is a copy (T10 H4).
  const [justRefunded, setJustRefunded] = useState<string | null>(null);
  const [justVoided, setJustVoided] = useState(false);

  const completed = sale.status === "COMPLETED";
  const anyLeft = sale.lines.some((line) => refundableOf(line) > 0);
  const showRefund = canRefund && completed && anyLeft;
  const plan = planRefund(sale.lines, qtys);
  // The till paying out: the sale's own till when it is open, else the first open till in the branch.
  const firstOpen = sale.registers.find((till) => till.hasOpenShift)?.id ?? "";
  const [tillId, setTillId] = useState(firstOpen);
  const chosen = sale.registers.find((till) => till.id === tillId && till.hasOpenShift) ? tillId : firstOpen;
  const tillOpen = chosen !== "";
  const ready = canSubmitRefund(plan, reason, pending) && tillOpen;

  function fail(key: MessageKey) {
    setError(key);
    if (RELOAD_AFTER.has(key)) router.refresh();
  }

  async function refund(event: FormEvent) {
    event.preventDefault();
    if (!ready || !plan.ok) return;
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await safeAction(() =>
      refundSaleAction(
        sale.id,
        {
          lines: plan.lines,
          registerId: chosen,
          method,
          reference: method === "CASH" || reference.trim() === "" ? null : reference.trim(),
          reason: reason.trim(),
        },
        refundKey,
      ),
    );
    setPending(false);
    if (result.ok) {
      setMessage(tr("returns.refund.done", { total: money(result.data.totalMinor) }));
      setJustRefunded(result.data.id);
      setQtys({});
      setReason("");
      setReference("");
      setRefundKey(crypto.randomUUID());
      router.refresh();
      return;
    }
    // Only an unknown outcome (dropped connection, 500) keeps the key, so a retry replays the refund.
    if (!keepKeyAfter(result.error)) setRefundKey(crypto.randomUUID());
    fail(returnErrorKey(result.error));
  }

  async function voidIt(event: FormEvent) {
    event.preventDefault();
    if (pending || voidReason.trim() === "") return;
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await safeAction(() => voidSaleAction(sale.id, { reason: voidReason.trim() }));
    setPending(false);
    if (result.ok) {
      setMessage(tr("returns.void.done", { number: result.data.number }));
      setJustVoided(true);
      setVoiding(false);
      setVoidReason("");
      router.refresh();
      return;
    }
    fail(returnErrorKey(result.error));
  }

  return (
    <section aria-labelledby="sale-title" className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="sale-title" className="text-xl font-semibold">
          {tr("returns.sale.title", { number: sale.number })}
        </h2>
        <p className="text-sm text-muted">
          {tr("returns.sale.meta", {
            time: new Date(sale.createdAt).toLocaleString(locale),
            register: sale.registerName,
          })}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <PrintReceiptButton
          locale={locale}
          saleId={sale.id}
          request={{ kind: "SALE", copy: true }}
          label="receipt.reprint"
          className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-50"
        />
        {!completed ? (
          <PrintReceiptButton
            locale={locale}
            saleId={sale.id}
            request={{ kind: "VOID", copy: !justVoided }}
            label="receipt.printVoid"
            className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-50"
          />
        ) : null}
      </div>
      <p>
        {tr("returns.sale.total")}:{" "}
        <strong dir="ltr" data-testid="sale-total">
          {money(sale.totalMinor)}
        </strong>
      </p>

      {!completed ? (
        <div role="status" className="rounded-md border border-border p-3">
          <p className="font-semibold">{tr("returns.sale.voided")}</p>
          {sale.voidReason ? (
            <p className="text-muted">{tr("returns.sale.voidReason", { reason: sale.voidReason })}</p>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p role="status" className="text-green-800" data-testid="returns-message">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-red-700">
          {plain(locale, error)}
        </p>
      ) : null}

      <form onSubmit={refund} aria-label={tr("returns.refund.title")} className="flex flex-col gap-4">
        <table className="w-full text-start">
          <thead>
            <tr className="text-muted">
              <th className="py-1 text-start font-normal">{tr("returns.lines.item")}</th>
              <th className="text-end font-normal">{tr("returns.lines.sold")}</th>
              <th className="text-end font-normal">{tr("returns.lines.refunded")}</th>
              {showRefund ? <th className="text-start font-normal">{tr("returns.lines.refund")}</th> : null}
              {showRefund ? <th className="text-end font-normal">{tr("returns.lines.amount")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {sale.lines.map((line) => {
              const left = refundableOf(line);
              const raw = qtys[line.saleItemId] ?? "";
              const qty = parseRefundQty(raw, left);
              const name = nameOf(line);
              return (
                <tr key={line.saleItemId} className="border-t border-border">
                  <td className="py-2">
                    {name}{" "}
                    <span dir="ltr" className="text-muted">
                      {line.sku}
                    </span>
                  </td>
                  <td dir="ltr" className="text-end">
                    {line.qty}
                  </td>
                  <td dir="ltr" className="text-end" data-testid={`refunded-${line.sku}`}>
                    {line.refundedQty}
                  </td>
                  {showRefund ? (
                    <td>
                      {left > 0 ? (
                        <input
                          dir="ltr"
                          inputMode="numeric"
                          aria-label={tr("returns.lines.qtyFor", { name })}
                          aria-invalid={qty === null}
                          value={raw}
                          placeholder="0"
                          onChange={(e) => setQtys((current) => ({ ...current, [line.saleItemId]: e.target.value }))}
                          className="w-20 rounded-md border border-border bg-background px-2 py-1"
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                  ) : null}
                  {showRefund ? (
                    <td dir="ltr" className="text-end">
                      {qty === null ? "—" : money(lineRefundMinor(line, qty))}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!plan.ok ? <p className="text-red-700">{tr("returns.lines.invalid")}</p> : null}

        {canRefund && completed && !anyLeft ? <p className="text-muted">{tr("returns.refund.nothingLeft")}</p> : null}

        {showRefund ? (
          <div className="flex max-w-md flex-col gap-3">
            {tillOpen ? (
              <label className="flex flex-col gap-1">
                <span>{tr("returns.refund.till")}</span>
                <select
                  value={chosen}
                  onChange={(e) => setTillId(e.target.value)}
                  className="rounded-md border border-border bg-background px-3 py-2"
                >
                  {sale.registers.map((till) => (
                    <option key={till.id} value={till.id} disabled={!till.hasOpenShift}>
                      {till.hasOpenShift ? till.name : tr("returns.refund.tillClosed", { name: till.name })}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p role="alert" className="text-red-700">
                {tr("returns.refund.noShift")}
              </p>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1">{tr("returns.refund.method")}</legend>
              <div className="flex gap-2">
                {METHODS.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-center gap-1 rounded-md border border-border px-3 py-2 has-[:checked]:border-foreground"
                  >
                    <input
                      type="radio"
                      name="refund-method"
                      value={option.value}
                      checked={method === option.value}
                      onChange={() => setMethod(option.value)}
                    />
                    {tr(option.label)}
                  </label>
                ))}
              </div>
            </fieldset>
            {method !== "CASH" ? (
              <label className="flex flex-col gap-1">
                <span>{tr("returns.refund.reference")}</span>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={64}
                  className="rounded-md border border-border bg-background px-3 py-2"
                />
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              <span>{tr("returns.refund.reason")}</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
                className="rounded-md border border-border bg-background px-3 py-2"
              />
            </label>
            <p>
              {tr("returns.refund.total")}:{" "}
              <strong dir="ltr" data-testid="refund-total">
                {money(plan.ok ? plan.totalMinor : 0)}
              </strong>
            </p>
            <p className="text-sm text-muted">{tr("returns.refund.preview")}</p>
            <button
              type="submit"
              disabled={!ready}
              className="self-start rounded-md bg-foreground px-4 py-2 text-background disabled:opacity-50"
            >
              {pending
                ? tr("returns.refund.submitting")
                : tr("returns.refund.submit", { total: money(plan.ok ? plan.totalMinor : 0) })}
            </button>
          </div>
        ) : null}
      </form>

      {sale.refunds.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">{tr("returns.history.title")}</h3>
          <ul className="flex flex-col gap-1">
            {sale.refunds.map((refund) => (
              <li key={refund.id} className="flex flex-wrap justify-between gap-2 text-sm">
                <span>
                  {new Date(refund.createdAt).toLocaleString(locale)} ·{" "}
                  {tr(METHODS.find((m) => m.value === refund.method)?.label ?? "returns.refund.cash")} · {refund.reason}
                </span>
                <span className="flex items-center gap-2">
                  <span dir="ltr">{money(refund.totalMinor)}</span>
                  <PrintReceiptButton
                    locale={locale}
                    saleId={sale.id}
                    request={{ kind: "REFUND", refundId: refund.id, copy: refund.id !== justRefunded }}
                    label="receipt.printRefund"
                    className="rounded-md border border-border px-2 py-0.5 text-xs disabled:opacity-50"
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canVoid && completed ? (
        <div className="flex max-w-md flex-col gap-2 border-t border-border pt-3">
          <h3 className="font-semibold">{tr("returns.void.title")}</h3>
          {!sale.canVoid ? (
            <p className="text-muted">{tr("returns.void.unavailable")}</p>
          ) : !voiding ? (
            <>
              <p className="text-sm text-muted">{tr("returns.void.body")}</p>
              <button
                type="button"
                onClick={() => setVoiding(true)}
                className="self-start rounded-md border border-red-700 px-4 py-2 text-red-700"
              >
                {tr("returns.void.start")}
              </button>
            </>
          ) : (
            <form onSubmit={voidIt} className="flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span>{tr("returns.void.reason")}</span>
                <input
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  maxLength={200}
                  autoFocus
                  className="rounded-md border border-border bg-background px-3 py-2"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={pending || voidReason.trim() === ""}
                  className="rounded-md bg-red-700 px-4 py-2 text-white disabled:opacity-50"
                >
                  {pending ? tr("returns.void.voiding") : tr("returns.void.confirm")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setVoiding(false);
                    setVoidReason("");
                  }}
                  disabled={pending}
                  className="rounded-md border border-border px-4 py-2"
                >
                  {tr("returns.void.cancel")}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </section>
  );
}
