"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { formatMoney, toMajorString } from "@/lib/money";
import type { ReceiptDoc, SaleDetail } from "@/modules/sales";
import type { Discount, PayMethod } from "@/modules/sales/totals";
import { plain, safeAction } from "../../inventory/_lib/form";
import { PrintReceiptButton, ReceiptSlip } from "../../_components/receipt-print";
import { usePrinter } from "../../_components/printing";
import { createSaleAction, tillStockAction } from "../actions";
import { CustomerPicker } from "./customer-picker";
import {
  addToCart,
  bumpQty,
  canCharge,
  discountRaw,
  displayName,
  exactCashMinor,
  keepKeyAfter,
  lineKey,
  parseCash,
  parseDiscount,
  planPayment,
  planSplit,
  previewCart,
  removeLine,
  saleErrorKey,
  setLineDiscount,
  setLineQty,
  shortLines,
  stockShort,
  tillShortcut,
  type CartLine,
  type TillCustomer,
  type TillItem,
  type TillSettings,
  type TillOffline,
} from "../_lib/till";
import { reach, searchSnapshot, unreachable, type OfflineBlock } from "../_lib/offline";
import { useOfflineTill } from "../_lib/use-offline";
import { Icon } from "@/app/_ui/icons";

type Props = {
  locale: Locale;
  branchId: string;
  registerId: string;
  userId: string;
  settings: TillSettings;
  offline: TillOffline;
};

const METHODS: { value: PayMethod; label: "pos.pay.cash" | "pos.pay.card" | "pos.pay.wallet" }[] = [
  { value: "CASH", label: "pos.pay.cash" },
  { value: "CARD_MANUAL", label: "pos.pay.card" },
  { value: "WALLET", label: "pos.pay.wallet" },
];

const NO_SPLIT: Record<PayMethod, string> = { CASH: "", CARD_MANUAL: "", WALLET: "" };

/** The discount box: on one cart line (its key) or on the whole sale. */
type DiscountDraft = { target: string | "SALE"; kind: Discount["kind"]; raw: string; invalid: boolean };

/**
 * The till (checkout UX): scan or search, build the cart, take one payment, charge. Totals on
 * screen are a preview; the server prices the sale and the receipt shows its numbers.
 */
export function Till({ locale, branchId, registerId, userId, settings, offline }: Props) {
  const tr = translator(locale);
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  // The cash box on screen: "Cash received", or the cash row of a split.
  const cashRef = useRef<HTMLInputElement>(null);
  const discountRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
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
  const [stock, setStock] = useState<Record<string, number | null>>({});
  // The line + and - act on: the one last added or focused, else the last line.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Discounts (discounts-spec §4): the sale's, and the box being edited.
  const [saleDiscount, setSaleDiscount] = useState<Discount | null>(null);
  const [discountDraft, setDiscountDraft] = useState<DiscountDraft | null>(null);
  // The sale's customer; null = walk-in (customers-spec CU7, CU12).
  const [customer, setCustomer] = useState<TillCustomer | null>(null);
  // Offline till (offline-till-spec slice 2): the device's state, and the slip of a sale rung up offline.
  const off = useOfflineTill({ branchId, registerId, userId, allowed: offline.allowed });
  const [offlineReceipt, setOfflineReceipt] = useState<ReceiptDoc | null>(null);
  // Sell offline straight away while the server is known to be away and this device may (OF6).
  const sellingOffline = off.offline && off.block === null;
  const limitLabel = settings.discount.limitBp === null ? null : `${settings.discount.limitBp / 100}%`;

  const preview = previewCart(cart, settings, saleDiscount);
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
    if (items.length === 0 || off.offline) return;
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

  /** Opens the discount box (F6 line, F7 sale) on what is set now. */
  function openDiscount(target: string | "SALE") {
    if (!settings.discount.allowed || cart.length === 0) return;
    const current = target === "SALE" ? saleDiscount : cart.find((line) => lineKey(line) === target)?.discount;
    setDiscountDraft({
      target,
      kind: current?.kind ?? "PERCENT",
      raw: discountRaw(current, settings.currency),
      invalid: false,
    });
    requestAnimationFrame(() => discountRef.current?.focus());
  }

  function closeDiscount() {
    setDiscountDraft(null);
    focusSearch();
  }

  /** Applies the box; an empty box removes the discount. */
  function applyDiscount(draft: DiscountDraft, clear = false) {
    const discount = clear ? null : parseDiscount(draft.raw, draft.kind, settings.currency);
    if (discount === "invalid") {
      setDiscountDraft({ ...draft, invalid: true });
      return;
    }
    if (draft.target === "SALE") setSaleDiscount(discount);
    else setCart((current) => setLineDiscount(current, draft.target, discount));
    setError(null);
    closeDiscount();
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
        if (discountDraft) {
          closeDiscount();
          return;
        }
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
      else if (action === "customer") {
        if (settings.customers.read) customerRef.current?.focus();
      } else if (action === "lineDiscount") {
        if (selected) openDiscount(selected);
      } else if (action === "saleDiscount") openDiscount("SALE");
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
    if (sellingOffline && off.snapshot) {
      // Offline: the snapshot's items and prices (OF7).
      items = searchSnapshot(off.snapshot.items, q);
    } else {
      try {
        const response = await fetch(`/api/catalog/search?${params}`, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`search failed: ${response.status}`);
        items = (await response.json()) as TillItem[];
      } catch (err) {
        // A network failure (fetch throws TypeError) with a usable snapshot: search it instead.
        if (!(err instanceof TypeError) || !off.snapshot || off.block !== null) {
          setError(tr("pos.error.generic"));
          return;
        }
        off.markUnreachable();
        items = searchSnapshot(off.snapshot.items, q);
      }
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
    setSaleDiscount(null);
    setDiscountDraft(null);
    setCustomer(null);
    if (receipt) setLastSaleId(receipt.id);
    setReceipt(null);
    setOfflineReceipt(null);
    setError(null);
    setSaleKey(crypto.randomUUID());
    focusSearch();
  }

  async function charge(event: FormEvent) {
    event.preventDefault();
    if (!ready || !plan) return;
    setPending(true);
    setError(null);
    const body = {
      branchId,
      registerId,
      lines: cart.map((line) => ({
        ref: { productId: line.productId, variantId: line.variantId },
        qty: line.qty,
        ...(line.discount ? { discount: line.discount } : {}),
      })),
      ...(saleDiscount ? { discount: saleDiscount } : {}),
      ...(customer ? { customerId: customer.id } : {}),
      payments: plan.payments,
    };
    const sent = sellingOffline ? "UNREACHABLE" : await reach(() => createSaleAction(body, saleKey));
    if (unreachable(sent) && off.device) {
      // OF6: no server. The sale goes to the queue under the same key, so if the online attempt did land, its
      // replay is refused as a conflict (listed for a manager) instead of selling twice.
      try {
        const sold = await off.sellOffline({ key: saleKey, body, cart, saleDiscount, plan });
        setPending(false);
        if (sold.ok) setOfflineReceipt(sold.receipt);
        else setError(plain(locale, OFFLINE_BLOCK[sold.block]));
      } catch {
        setPending(false);
        setError(tr("pos.error.generic"));
      }
      return;
    }
    const result =
      sent === "UNREACHABLE"
        ? { ok: false as const, error: { code: "INTERNAL" as const, message: "", details: null } }
        : sent;
    setPending(false);
    if (result.ok) {
      void off.contact();
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

  if (offlineReceipt) {
    return <OfflineReceipt locale={locale} doc={offlineReceipt} queued={off.queue.length} onNewSale={newSale} />;
  }

  if (receipt) {
    const paid = receipt.payments.reduce((sum, payment) => sum + payment.amountMinor, 0) + receipt.changeMinor;
    return (
      <section aria-labelledby="receipt-title" className="card flex max-w-md flex-col gap-3 p-4">
        <h2 id="receipt-title" className="text-xl font-semibold">
          {tr("pos.receipt.title", { number: receipt.number })}
        </h2>
        <p className="text-muted">{new Date(receipt.createdAt).toLocaleString(locale)}</p>
        {receipt.customer ? (
          <p data-testid="receipt-customer">
            {tr("pos.customer.label")}: {receipt.customer.name}
          </p>
        ) : null}
        <ul className="flex flex-col gap-1">
          {receipt.lines.map((line) => (
            <li key={lineKey(line)} className="flex flex-wrap justify-between gap-x-4">
              <span>
                {displayName(line, locale)} × {line.qty}
              </span>
              <span dir="ltr">{money(line.lineTotalMinor)}</span>
              {line.discountMinor > 0 ? (
                <span className="w-full ps-4 text-sm text-muted">
                  {tr("pos.discount.lineNote", { amount: money(line.discountMinor) })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-2 gap-1 border-t border-border pt-2">
          {receipt.discountMinor > 0 ? (
            <>
              <dt>{tr("pos.totals.discount")}</dt>
              <dd dir="ltr" className="text-end" data-testid="receipt-discount">
                −{money(receipt.discountMinor)}
              </dd>
            </>
          ) : null}
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
          <button type="button" onClick={newSale} autoFocus className="btn btn-primary">
            {tr("pos.receipt.newSale")}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr] lg:items-start">
      <OfflineBar
        locale={locale}
        off={off}
        canEnrol={offline.allowed && offline.canEnrol && !offline.registerHasDevice}
      />
      <section aria-labelledby="cart-title" className="card flex flex-col gap-4">
        {lastSaleId && cart.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <PrintReceiptButton
              locale={locale}
              saleId={lastSaleId}
              request={{ kind: "SALE", copy: true }}
              label="receipt.reprintLast"
              className="btn btn-sm"
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
            className="input min-h-12 flex-1 text-base"
          />
          <button type="button" onClick={() => void find()} className="btn min-h-12">
            <Icon name="search" className="size-4" />
            {tr("pos.search.submit")}
          </button>
        </div>
        {settings.customers.read ? (
          <CustomerPicker
            locale={locale}
            customer={customer}
            onChange={setCustomer}
            canCreate={settings.customers.create}
            inputRef={customerRef}
            onDone={focusSearch}
          />
        ) : null}
        <p className="text-xs text-muted" data-testid="till-keys">
          {tr("pos.keys.hint")}
        </p>

        {results !== null ? (
          results.length === 0 ? (
            <p className="text-muted">{tr("pos.search.none")}</p>
          ) : (
            <ul
              aria-label={tr("pos.search.label")}
              className="flex flex-col divide-y divide-border rounded-lg border border-border"
            >
              {results.map((item) => (
                <li key={lineKey(item)} className="flex min-h-14 items-center justify-between gap-2 px-3 py-1.5">
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
                      className="btn btn-primary min-h-12 min-w-12"
                    >
                      <Icon name="plus" />
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
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr className="text-muted">
                  <th className="py-1 text-start font-normal">{tr("pos.cart.item")}</th>
                  <th className="text-start font-normal">{tr("pos.cart.qty")}</th>
                  <th className="text-end">{tr("pos.cart.price")}</th>
                  <th className="text-end">{tr("pos.cart.lineTotal")}</th>
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
                      className="border-t border-border data-[selected=true]:bg-accent-soft"
                    >
                      <td>
                        {name}{" "}
                        <span dir="ltr" className="text-muted">
                          {line.sku}
                        </span>
                        <StockNote locale={locale} onHand={stock[key]} qty={line.qty} block />
                        {preview.ok && (preview.lineDiscounts[key] ?? 0) > 0 ? (
                          <span className="block text-sm text-muted" data-testid="line-discount">
                            {tr("pos.discount.lineNote", { amount: money(preview.lineDiscounts[key]) })}
                          </span>
                        ) : null}
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
                          className="input min-h-12 w-20 px-2 py-1"
                        />
                      </td>
                      <td dir="ltr" className="text-end">
                        {money(line.unitPriceMinor)}
                      </td>
                      <td dir="ltr" className="text-end">
                        {preview.ok ? money(preview.lineTotals[key] ?? 0) : "—"}
                      </td>
                      <td className="whitespace-nowrap text-end">
                        {settings.discount.allowed ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedKey(key);
                              openDiscount(key);
                            }}
                            aria-label={tr("pos.discount.lineFor", { name })}
                            className="btn btn-sm me-1"
                          >
                            {tr("pos.discount.line")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setCart((current) => removeLine(current, key))}
                          aria-label={tr("pos.cart.remove", { name })}
                          className="btn btn-sm"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {discountDraft ? (
          <DiscountBox
            locale={locale}
            draft={discountDraft}
            inputRef={discountRef}
            currency={settings.currency}
            limitLabel={limitLabel}
            title={
              discountDraft.target === "SALE"
                ? tr("pos.discount.titleSale")
                : tr("pos.discount.titleLine", {
                    name: displayName(cart.find((line) => lineKey(line) === discountDraft.target) ?? cart[0], locale),
                  })
            }
            onChange={setDiscountDraft}
            onApply={applyDiscount}
            onCancel={closeDiscount}
          />
        ) : null}
        {cart.length > 0 ? (
          <button type="button" onClick={newSale} className="self-start text-sm underline-offset-4 hover:underline">
            {tr("pos.cart.clear")}
          </button>
        ) : null}
      </section>

      <form
        onSubmit={charge}
        aria-label={tr("pos.pay.method")}
        className="card flex flex-col gap-4 lg:sticky lg:top-20"
      >
        {preview.ok ? (
          <dl className="grid grid-cols-2 gap-1">
            {preview.discountMinor > 0 ? (
              <>
                <dt>{tr("pos.totals.discount")}</dt>
                <dd dir="ltr" className="text-end" data-testid="till-discount">
                  −{money(preview.discountMinor)}
                </dd>
              </>
            ) : null}
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
          <p role="alert" className="notice notice-error">
            {tr(preview.reason === "DISCOUNT_TOO_LARGE" ? "pos.totals.discountTooLarge" : "pos.totals.tooLarge")}
          </p>
        )}
        {settings.discount.allowed && cart.length > 0 ? (
          <button type="button" onClick={() => openDiscount("SALE")} className="btn btn-sm self-start">
            {tr("pos.discount.sale")}
          </button>
        ) : null}
        {preview.ok && preview.overLimit && limitLabel ? (
          <p role="alert" className="notice notice-error">
            {tr("pos.discount.overLimit", { limit: limitLabel })}
          </p>
        ) : null}

        {totalMinor > 0 ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1">{tr("pos.pay.method")}</legend>
            <div className="flex gap-2">
              {METHODS.map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-1 min-h-12 cursor-pointer rounded-lg border border-border-strong px-4 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
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
              <label className="flex items-center gap-1 min-h-12 cursor-pointer rounded-lg border border-border-strong px-4 py-2 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
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
                          className="input"
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
                            className="input"
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
                    {splitEnteredMinor > 0 ? <p className="text-danger">{tr("pos.pay.splitShort")}</p> : null}
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
                      className="input"
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
                  <p className="text-danger">{tr("pos.pay.short")}</p>
                ) : null}
              </>
            ) : (
              <label className="field">
                <span>{tr("pos.pay.reference")}</span>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={64}
                  className="input"
                />
              </label>
            )}
          </fieldset>
        ) : null}

        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={!ready} className="btn btn-primary min-h-14 text-lg">
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

/**
 * The discount box (F6 / F7): a number and a percent-or-amount switch. Enter applies, Esc cancels
 * (handled by the till's key listener), an empty box removes the discount. Not a form: the sale
 * discount opens from inside the charge form.
 */
function DiscountBox({
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

function ExactCashButton({ locale, onClick }: { locale: Locale; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="btn self-end">
      {translator(locale)("pos.pay.exact")}
    </button>
  );
}

/** On-hand at this branch; red when it is zero, negative or below the line's quantity. Nothing until loaded or when unknown. */
function StockNote({
  locale,
  onHand,
  qty,
  block,
}: {
  locale: Locale;
  onHand?: number | null;
  qty: number;
  block?: boolean;
}) {
  if (onHand === undefined || onHand === null) return null;
  return (
    <span
      data-testid="till-stock"
      className={`text-sm ${block ? "block " : ""}${stockShort(onHand, qty) ? "font-semibold text-danger" : "text-muted"}`}
    >
      {translator(locale)("pos.stock.onHand", { qty: String(onHand) })}
    </span>
  );
}

const OFFLINE_BLOCK: Record<OfflineBlock, MessageKey> = {
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
function OfflineBar({
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
        <p role="status" className="rounded-lg bg-danger px-3 py-2 font-semibold text-white">
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
function OfflineReceipt({
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
