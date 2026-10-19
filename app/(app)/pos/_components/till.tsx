"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { formatMoney, toMajorString } from "@/lib/money";
import type { SaleDetail } from "@/modules/sales";
import type { PayMethod } from "@/modules/sales/totals";
import { plain, safeAction } from "../../inventory/_lib/form";
import { PrintReceiptButton } from "../../_components/receipt-print";
import { createSaleAction, tillStockAction } from "../actions";
import {
  addToCart,
  bumpQty,
  canCharge,
  displayName,
  exactCashMinor,
  keepKeyAfter,
  lineKey,
  parseCash,
  planPayment,
  planSplit,
  previewCart,
  removeLine,
  saleErrorKey,
  setLineQty,
  shortLines,
  stockShort,
  tillShortcut,
  type CartLine,
  type TillItem,
  type TillSettings,
} from "../_lib/till";

type Props = {
  locale: Locale;
  branchId: string;
  registerId: string;
  settings: TillSettings;
};

const METHODS: { value: PayMethod; label: "pos.pay.cash" | "pos.pay.card" | "pos.pay.wallet" }[] = [
  { value: "CASH", label: "pos.pay.cash" },
  { value: "CARD_MANUAL", label: "pos.pay.card" },
  { value: "WALLET", label: "pos.pay.wallet" },
];

const NO_SPLIT: Record<PayMethod, string> = { CASH: "", CARD_MANUAL: "", WALLET: "" };

/**
 * The till (checkout UX): scan or search, build the cart, take one payment, charge. Totals on
 * screen are a preview; the server prices the sale and the receipt shows its numbers.
 */
export function Till({ locale, branchId, registerId, settings }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  // The cash box on screen: "Cash received", or the cash row of a split.
  const cashRef = useRef<HTMLInputElement>(null);
  const money = (minor: number) => formatMoney(minor, settings.currency, locale);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TillItem[] | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [method, setMethod] = useState<PayMethod | "SPLIT">("CASH");
  const [cashRaw, setCashRaw] = useState("");
  const [reference, setReference] = useState("");
  // Split tenders: typed amount and reference per method.
  const [splitRaw, setSplitRaw] = useState(NO_SPLIT);
  const [splitRef, setSplitRef] = useState(NO_SPLIT);
  const [saleKey, setSaleKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SaleDetail | null>(null);
  // The sale just finished, for "Reprint last receipt" once the next cart starts (T10 H4).
  const [lastSaleId, setLastSaleId] = useState<string | null>(null);
  // On-hand at this branch by line key, as loaded when the item was found. Display only.
  const [stock, setStock] = useState<Record<string, number>>({});
  // The line + and - act on: the one last added or focused, else the last line.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const preview = previewCart(cart, settings);
  const totalMinor = preview.ok ? preview.totalMinor : 0;
  const splitTenders = METHODS.map(({ value }) => ({
    method: value,
    amountMinor: splitRaw[value].trim() === "" ? 0 : parseCash(splitRaw[value], settings.currency),
    reference: splitRef[value],
  }));
  const splitEnteredMinor = splitTenders.reduce((sum, tender) => sum + (tender.amountMinor ?? 0), 0);
  const plan =
    method === "SPLIT"
      ? planSplit(totalMinor, splitTenders)
      : planPayment({
          method,
          totalMinor,
          cashReceivedMinor: method === "CASH" ? parseCash(cashRaw, settings.currency) : null,
          reference,
        });
  const ready = canCharge(cart, preview, plan) && !pending;
  const selected =
    selectedKey && cart.some((line) => lineKey(line) === selectedKey)
      ? selectedKey
      : cart.length > 0
        ? lineKey(cart[cart.length - 1])
        : null;

  function focusSearch() {
    searchRef.current?.focus();
  }

  /** Loads on-hand for these items; a failure just leaves the stock out. */
  async function loadStock(items: readonly TillItem[]) {
    if (items.length === 0) return;
    const result = await safeAction(() =>
      tillStockAction({
        branchId,
        refs: items.map((item) => ({ productId: item.productId, variantId: item.variantId })),
      }),
    );
    if (!result.ok) return;
    const found = result.data;
    setStock((current) => {
      const next = { ...current };
      items.forEach((item, index) => (next[lineKey(item)] = found[index]));
      return next;
    });
  }

  /** Exact cash (F8): fills the cash box with what is still due in cash. */
  function fillExactCash() {
    if (totalMinor === 0) return;
    if (method === "SPLIT") {
      const due = exactCashMinor(totalMinor, splitTenders);
      setSplitRaw((current) => ({ ...current, CASH: due > 0 ? toMajorString(due, settings.currency) : "" }));
    } else {
      setMethod("CASH");
      setCashRaw(toMajorString(totalMinor, settings.currency));
    }
    // The box may only render after the method switch.
    requestAnimationFrame(() => cashRef.current?.focus());
  }

  useEffect(() => {
    if (receipt) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editable = target?.closest("input, textarea, select, [contenteditable='true']");
      // The search box right after a scan is empty, so + and - still work there.
      const inField = editable !== null && editable !== undefined && !(editable === searchRef.current && query === "");
      const action = tillShortcut(event.key, inField);
      if (!action) return;
      if (action === "close") {
        if (results === null) return;
        setResults(null);
        setQuery("");
        focusSearch();
        return;
      }
      event.preventDefault();
      if (action === "search") focusSearch();
      else if (action === "cash") {
        if (totalMinor === 0) return;
        if (method !== "SPLIT") setMethod("CASH");
        requestAnimationFrame(() => cashRef.current?.focus());
      } else if (action === "exact") fillExactCash();
      else if (selected) setCart((current) => bumpQty(current, selected, action === "inc" ? 1 : -1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function add(item: TillItem) {
    setCart((current) => addToCart(current, item));
    setSelectedKey(lineKey(item));
    setResults(null);
    setQuery("");
    setError(null);
    focusSearch();
  }

  async function find() {
    const q = query.trim();
    if (!q) return;
    const params = new URLSearchParams({ q, limit: "10" });
    let items: TillItem[];
    try {
      const response = await fetch(`/api/catalog/search?${params}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`search failed: ${response.status}`);
      items = (await response.json()) as TillItem[];
    } catch {
      setError(tr("pos.error.generic"));
      return;
    }
    // A scan that finds exactly one item goes straight into the cart.
    if (items.length === 1) add(items[0]);
    else setResults(items);
    void loadStock(items);
  }

  function newSale() {
    setCart([]);
    setCashRaw("");
    setReference("");
    setSplitRaw(NO_SPLIT);
    setSplitRef(NO_SPLIT);
    setMethod("CASH");
    // Stock moved with the sale: reload it as items are scanned again.
    setStock({});
    setSelectedKey(null);
    if (receipt) setLastSaleId(receipt.id);
    setReceipt(null);
    setError(null);
    setSaleKey(crypto.randomUUID());
    focusSearch();
  }

  async function charge(event: FormEvent) {
    event.preventDefault();
    if (!ready || !plan) return;
    setPending(true);
    setError(null);
    const result = await safeAction(() =>
      createSaleAction(
        {
          branchId,
          registerId,
          lines: cart.map((line) => ({ ref: { productId: line.productId, variantId: line.variantId }, qty: line.qty })),
          payments: plan.payments,
        },
        saleKey,
      ),
    );
    setPending(false);
    if (result.ok) {
      setReceipt(result.data);
      // The shift's expected cash changed: refresh the server data the close screen reads.
      router.refresh();
      return;
    }
    if (!keepKeyAfter(result.error)) setSaleKey(crypto.randomUUID());
    const key = saleErrorKey(result.error);
    if (key === "pos.error.insufficient") {
      const items = shortLines(result.error, cart)
        .map((line) => displayName(line, locale))
        .join(", ");
      setError(tr("pos.error.insufficient", { items }));
      void loadStock(cart);
    } else {
      setError(plain(locale, key));
    }
    if (key === "pos.error.shiftNotOpen") router.refresh();
  }

  if (receipt) {
    const paid = receipt.payments.reduce((sum, payment) => sum + payment.amountMinor, 0) + receipt.changeMinor;
    return (
      <section
        aria-labelledby="receipt-title"
        className="flex max-w-md flex-col gap-3 rounded-md border border-border p-4"
      >
        <h2 id="receipt-title" className="text-xl font-semibold">
          {tr("pos.receipt.title", { number: receipt.number })}
        </h2>
        <p className="text-muted">{new Date(receipt.createdAt).toLocaleString(locale)}</p>
        <ul className="flex flex-col gap-1">
          {receipt.lines.map((line) => (
            <li key={lineKey(line)} className="flex justify-between gap-4">
              <span>
                {displayName(line, locale)} × {line.qty}
              </span>
              <span dir="ltr">{money(line.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-2 gap-1 border-t border-border pt-2">
          <dt>{tr("pos.totals.subtotal")}</dt>
          <dd dir="ltr" className="text-end">
            {money(receipt.subtotalMinor)}
          </dd>
          <dt>{tr("pos.totals.vat")}</dt>
          <dd dir="ltr" className="text-end">
            {money(receipt.vatMinor)}
          </dd>
          <dt className="font-semibold">{tr("pos.totals.total")}</dt>
          <dd dir="ltr" className="text-end font-semibold">
            {money(receipt.totalMinor)}
          </dd>
          <dt>{tr("pos.receipt.paid")}</dt>
          <dd dir="ltr" className="text-end">
            {money(paid)}
          </dd>
          {receipt.payments.length > 1
            ? receipt.payments.map((payment) => (
                <Fragment key={payment.method}>
                  <dt className="ps-4 text-muted">
                    {tr(METHODS.find((option) => option.value === payment.method)?.label ?? "pos.pay.cash")}
                  </dt>
                  <dd dir="ltr" className="text-end text-muted">
                    {money(payment.amountMinor)}
                  </dd>
                </Fragment>
              ))
            : null}
          <dt>{tr("pos.receipt.change")}</dt>
          <dd dir="ltr" className="text-end" data-testid="receipt-change">
            {money(receipt.changeMinor)}
          </dd>
        </dl>
        <div className="flex gap-2 print:hidden">
          <PrintReceiptButton
            locale={locale}
            saleId={receipt.id}
            request={{ kind: "SALE", copy: false }}
            label="pos.receipt.print"
          />
          <button
            type="button"
            onClick={newSale}
            autoFocus
            className="rounded-md bg-foreground px-4 py-2 text-background"
          >
            {tr("pos.receipt.newSale")}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <section aria-labelledby="cart-title" className="flex flex-col gap-4">
        {lastSaleId && cart.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <PrintReceiptButton
              locale={locale}
              saleId={lastSaleId}
              request={{ kind: "SALE", copy: true }}
              label="receipt.reprintLast"
              className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-50"
            />
          </div>
        ) : null}
        <div className="flex gap-2">
          <input
            ref={searchRef}
            autoFocus
            aria-label={tr("pos.search.label")}
            placeholder={tr("pos.search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // A scanner sends Enter after the code.
              if (e.key === "Enter") {
                e.preventDefault();
                void find();
              }
            }}
            dir="ltr"
            className="flex-1 rounded-md border border-border bg-background px-3 py-2"
          />
          <button type="button" onClick={() => void find()} className="rounded-md border border-border px-4 py-2">
            {tr("pos.search.submit")}
          </button>
        </div>
        <p className="text-xs text-muted" data-testid="till-keys">
          {tr("pos.keys.hint")}
        </p>

        {results !== null ? (
          results.length === 0 ? (
            <p className="text-muted">{tr("pos.search.none")}</p>
          ) : (
            <ul aria-label={tr("pos.search.label")} className="flex flex-col gap-1">
              {results.map((item) => (
                <li key={lineKey(item)} className="flex items-center justify-between gap-2">
                  <span>
                    {displayName(item, locale)}{" "}
                    <span dir="ltr" className="text-muted">
                      {item.sku}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StockNote locale={locale} onHand={stock[lineKey(item)]} qty={0} />
                    <span dir="ltr">{money(item.unitPriceMinor)}</span>
                    <button
                      type="button"
                      onClick={() => add(item)}
                      aria-label={tr("pos.search.add", { name: displayName(item, locale) })}
                      className="rounded-md border border-border px-3 py-1"
                    >
                      +
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}

        <h2 id="cart-title" className="text-lg font-semibold">
          {tr("pos.cart.title")}
        </h2>
        {cart.length === 0 ? (
          <p className="text-muted">{tr("pos.cart.empty")}</p>
        ) : (
          <table className="w-full text-start">
            <thead>
              <tr className="text-muted">
                <th className="py-1 text-start font-normal">{tr("pos.cart.item")}</th>
                <th className="text-start font-normal">{tr("pos.cart.qty")}</th>
                <th className="text-end font-normal">{tr("pos.cart.price")}</th>
                <th className="text-end font-normal">{tr("pos.cart.lineTotal")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cart.map((line) => {
                const key = lineKey(line);
                const name = displayName(line, locale);
                return (
                  <tr
                    key={key}
                    data-selected={key === selected}
                    className="border-t border-border data-[selected=true]:bg-foreground/5"
                  >
                    <td className="py-2">
                      {name}{" "}
                      <span dir="ltr" className="text-muted">
                        {line.sku}
                      </span>
                      <StockNote locale={locale} onHand={stock[key]} qty={line.qty} block />
                    </td>
                    <td>
                      <input
                        dir="ltr"
                        inputMode="numeric"
                        aria-label={tr("pos.cart.qtyFor", { name })}
                        aria-invalid={line.qty < 1}
                        value={line.qty === 0 ? "" : line.qty}
                        onChange={(e) => setCart((current) => setLineQty(current, key, e.target.value))}
                        onFocus={() => setSelectedKey(key)}
                        className="w-20 rounded-md border border-border bg-background px-2 py-1"
                      />
                    </td>
                    <td dir="ltr" className="text-end">
                      {money(line.unitPriceMinor)}
                    </td>
                    <td dir="ltr" className="text-end">
                      {preview.ok ? money(preview.lineTotals[key] ?? 0) : "—"}
                    </td>
                    <td className="text-end">
                      <button
                        type="button"
                        onClick={() => setCart((current) => removeLine(current, key))}
                        aria-label={tr("pos.cart.remove", { name })}
                        className="rounded-md border border-border px-2 py-1"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {cart.length > 0 ? (
          <button type="button" onClick={newSale} className="self-start text-sm underline-offset-4 hover:underline">
            {tr("pos.cart.clear")}
          </button>
        ) : null}
      </section>

      <form onSubmit={charge} aria-label={tr("pos.pay.method")} className="flex flex-col gap-4">
        {preview.ok ? (
          <dl className="grid grid-cols-2 gap-1">
            <dt>{tr("pos.totals.subtotal")}</dt>
            <dd dir="ltr" className="text-end">
              {money(preview.subtotalMinor)}
            </dd>
            <dt>{tr("pos.totals.vat")}</dt>
            <dd dir="ltr" className="text-end">
              {money(preview.vatMinor)}
            </dd>
            <dt className="text-lg font-semibold">{tr("pos.totals.total")}</dt>
            <dd dir="ltr" className="text-end text-lg font-semibold" data-testid="till-total">
              {money(preview.totalMinor)}
            </dd>
            {settings.pricesIncludeVat ? (
              <dd className="col-span-2 text-sm text-muted">{tr("pos.totals.vatIncluded")}</dd>
            ) : null}
          </dl>
        ) : (
          <p role="alert" className="text-red-700">
            {tr("pos.totals.tooLarge")}
          </p>
        )}

        {totalMinor > 0 ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1">{tr("pos.pay.method")}</legend>
            <div className="flex gap-2">
              {METHODS.map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-1 rounded-md border border-border px-3 py-2 has-[:checked]:border-foreground"
                >
                  <input
                    type="radio"
                    name="method"
                    value={option.value}
                    checked={method === option.value}
                    onChange={() => setMethod(option.value)}
                  />
                  {tr(option.label)}
                </label>
              ))}
              <label className="flex items-center gap-1 rounded-md border border-border px-3 py-2 has-[:checked]:border-foreground">
                <input
                  type="radio"
                  name="method"
                  value="SPLIT"
                  checked={method === "SPLIT"}
                  onChange={() => setMethod("SPLIT")}
                />
                {tr("pos.pay.split")}
              </label>
            </div>
            {method === "SPLIT" ? (
              <>
                {METHODS.map((option) => {
                  const name = tr(option.label);
                  return (
                    <div key={option.value} className="flex flex-wrap gap-2">
                      <label className="flex flex-1 flex-col gap-1">
                        <span>
                          {tr("pos.pay.amount", { method: name })} ({settings.currency})
                        </span>
                        <input
                          ref={option.value === "CASH" ? cashRef : undefined}
                          dir="ltr"
                          inputMode="decimal"
                          value={splitRaw[option.value]}
                          onChange={(e) => setSplitRaw((current) => ({ ...current, [option.value]: e.target.value }))}
                          className="rounded-md border border-border bg-background px-3 py-2"
                        />
                      </label>
                      {option.value === "CASH" ? (
                        <ExactCashButton locale={locale} onClick={fillExactCash} />
                      ) : (
                        <label className="flex flex-1 flex-col gap-1">
                          <span>{tr("pos.pay.referenceFor", { method: name })}</span>
                          <input
                            value={splitRef[option.value]}
                            onChange={(e) => setSplitRef((current) => ({ ...current, [option.value]: e.target.value }))}
                            maxLength={64}
                            className="rounded-md border border-border bg-background px-3 py-2"
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
                {plan ? (
                  <p>
                    {tr("pos.pay.change")}:{" "}
                    <strong dir="ltr" data-testid="till-change">
                      {money(plan.changeMinor)}
                    </strong>
                  </p>
                ) : (
                  <>
                    <p>
                      {tr("pos.pay.remaining")}:{" "}
                      <strong dir="ltr" data-testid="till-remaining">
                        {money(Math.max(totalMinor - splitEnteredMinor, 0))}
                      </strong>
                    </p>
                    {splitEnteredMinor > 0 ? <p className="text-red-700">{tr("pos.pay.splitShort")}</p> : null}
                  </>
                )}
              </>
            ) : method === "CASH" ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <label className="flex flex-1 flex-col gap-1">
                    <span>
                      {tr("pos.pay.received")} ({settings.currency})
                    </span>
                    <input
                      ref={cashRef}
                      dir="ltr"
                      inputMode="decimal"
                      value={cashRaw}
                      onChange={(e) => setCashRaw(e.target.value)}
                      className="rounded-md border border-border bg-background px-3 py-2"
                    />
                  </label>
                  <ExactCashButton locale={locale} onClick={fillExactCash} />
                </div>
                {plan ? (
                  <p>
                    {tr("pos.pay.change")}:{" "}
                    <strong dir="ltr" data-testid="till-change">
                      {money(plan.changeMinor)}
                    </strong>
                  </p>
                ) : cashRaw.trim() !== "" ? (
                  <p className="text-red-700">{tr("pos.pay.short")}</p>
                ) : null}
              </>
            ) : (
              <label className="flex flex-col gap-1">
                <span>{tr("pos.pay.reference")}</span>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={64}
                  className="rounded-md border border-border bg-background px-3 py-2"
                />
              </label>
            )}
          </fieldset>
        ) : null}

        {error ? (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!ready}
          className="rounded-md bg-foreground px-4 py-3 text-lg text-background disabled:opacity-50"
        >
          {pending
            ? tr("pos.pay.charging")
            : cart.length > 0 && totalMinor === 0
              ? tr("pos.pay.free")
              : tr("pos.pay.charge", { total: money(totalMinor) })}
        </button>
      </form>
    </div>
  );
}

function ExactCashButton({ locale, onClick }: { locale: Locale; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="self-end rounded-md border border-border px-3 py-2">
      {translator(locale)("pos.pay.exact")}
    </button>
  );
}

/** On-hand at this branch; red when it is zero, negative or below the line's quantity. Nothing until loaded. */
function StockNote({ locale, onHand, qty, block }: { locale: Locale; onHand?: number; qty: number; block?: boolean }) {
  if (onHand === undefined) return null;
  return (
    <span
      data-testid="till-stock"
      className={`text-sm ${block ? "block " : ""}${stockShort(onHand, qty) ? "font-semibold text-red-700" : "text-muted"}`}
    >
      {translator(locale)("pos.stock.onHand", { qty: String(onHand) })}
    </span>
  );
}
