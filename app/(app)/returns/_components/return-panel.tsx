"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import { formatQty } from "@/lib/quantity";
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
  const plan = planRefund(sale.lines, qtys, sale.serviceCharge);
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
    <section aria-labelledby="sale-title" className="card flex flex-col gap-4 p-4">
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
          className="btn btn-sm"
        />
        {!completed ? (
          <PrintReceiptButton
            locale={locale}
            saleId={sale.id}
            request={{ kind: "VOID", copy: !justVoided }}
            label="receipt.printVoid"
            className="btn btn-sm"
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
        <div role="status" className="card p-3">
          <p className="font-semibold">{tr("returns.sale.voided")}</p>
          {sale.voidReason ? (
            <p className="text-muted">{tr("returns.sale.voidReason", { reason: sale.voidReason })}</p>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p role="status" className="notice notice-success" data-testid="returns-message">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="notice notice-error">
          {plain(locale, error)}
        </p>
      ) : null}

      <form onSubmit={refund} aria-label={tr("returns.refund.title")} className="flex flex-col gap-4">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr className="text-muted">
                <th className="py-1 text-start font-normal">{tr("returns.lines.item")}</th>
                <th className="text-end">{tr("returns.lines.sold")}</th>
                <th className="text-end">{tr("returns.lines.refunded")}</th>
                {showRefund ? <th className="text-start font-normal">{tr("returns.lines.refund")}</th> : null}
                {showRefund ? <th className="text-end">{tr("returns.lines.amount")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((line) => {
                const left = refundableOf(line);
                const raw = qtys[line.saleItemId] ?? "";
                const qty = parseRefundQty(raw, left, line.unitType);
                const kg = line.unitType === "KG";
                const name = nameOf(line);
                return (
                  <tr key={line.saleItemId}>
                    <td>
                      {name}{" "}
                      <span dir="ltr" className="text-muted">
                        {line.sku}
                      </span>
                      {/* Two lines of one item differ by options or note (restaurant-cafe-spec R9). */}
                      {line.options.length > 0 || line.note || line.staffName ? (
                        <span className="block text-sm text-muted">
                          {[
                            ...line.options.map((option) => (locale === "ar" && option.nameAr) || option.name),
                            ...(line.note ? [`“${line.note}”`] : []),
                            ...(line.staffName ? [tr("receipt.by", { name: line.staffName })] : []),
                          ].join(" · ")}
                        </span>
                      ) : null}
                      {line.discountMinor > 0 ? (
                        <span className="block text-sm text-muted">
                          {tr("returns.lines.discounted", {
                            discount: money(line.discountMinor),
                            paid: money(line.lineTotalMinor),
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td dir="ltr" className="text-end">
                      {formatQty(line.qty, line.unitType, locale)}
                    </td>
                    <td dir="ltr" className="text-end" data-testid={`refunded-${line.sku}`}>
                      {formatQty(line.refundedQty, line.unitType, locale)}
                    </td>
                    {showRefund ? (
                      <td>
                        {left > 0 ? (
                          <input
                            dir="ltr"
                            inputMode={kg ? "decimal" : "numeric"}
                            aria-label={tr("returns.lines.qtyFor", { name })}
                            aria-invalid={qty === null}
                            value={raw}
                            placeholder={kg ? "0.000" : "0"}
                            onChange={(e) => setQtys((current) => ({ ...current, [line.saleItemId]: e.target.value }))}
                            className="input min-h-9 w-20 px-2 py-1"
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
        </div>
        {!plan.ok ? <p className="text-danger">{tr("returns.lines.invalid")}</p> : null}

        {canRefund && completed && !anyLeft ? <p className="text-muted">{tr("returns.refund.nothingLeft")}</p> : null}

        {showRefund ? (
          <div className="flex max-w-md flex-col gap-3">
            {tillOpen ? (
              <label className="field">
                <span>{tr("returns.refund.till")}</span>
                <select value={chosen} onChange={(e) => setTillId(e.target.value)} className="input">
                  {sale.registers.map((till) => (
                    <option key={till.id} value={till.id} disabled={!till.hasOpenShift}>
                      {till.hasOpenShift ? till.name : tr("returns.refund.tillClosed", { name: till.name })}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p role="alert" className="notice notice-error">
                {tr("returns.refund.noShift")}
              </p>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1">{tr("returns.refund.method")}</legend>
              <div className="flex gap-2">
                {METHODS.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-center gap-1 min-h-12 cursor-pointer rounded-lg border border-border-strong px-4 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
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
              <label className="field">
                <span>{tr("returns.refund.reference")}</span>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={64}
                  className="input"
                />
              </label>
            ) : null}
            <label className="field">
              <span>{tr("returns.refund.reason")}</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="input" />
            </label>
            <p>
              {tr("returns.refund.total")}:{" "}
              <strong dir="ltr" data-testid="refund-total">
                {money(plan.ok ? plan.totalMinor : 0)}
              </strong>
            </p>
            <p className="text-sm text-muted">{tr("returns.refund.preview")}</p>
            <button type="submit" disabled={!ready} className="btn btn-primary self-start">
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
                    className="btn btn-sm"
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
                className="btn border-danger text-danger self-start"
              >
                {tr("returns.void.start")}
              </button>
            </>
          ) : (
            <form onSubmit={voidIt} className="flex flex-col gap-2">
              <label className="field">
                <span>{tr("returns.void.reason")}</span>
                <input
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  maxLength={200}
                  autoFocus
                  className="input"
                />
              </label>
              <div className="flex gap-2">
                <button type="submit" disabled={pending || voidReason.trim() === ""} className="btn btn-danger">
                  {pending ? tr("returns.void.voiding") : tr("returns.void.confirm")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setVoiding(false);
                    setVoidReason("");
                  }}
                  disabled={pending}
                  className="btn"
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
