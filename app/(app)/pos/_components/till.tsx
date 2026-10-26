"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { translator, type Locale } from "@/lib/i18n";
import { formatMoney, toMajorString } from "@/lib/money";
import { formatQty, qtyInputValue } from "@/lib/quantity";
import { parseScaleLabel, type ScaleLabel } from "@/lib/scale-label";
import type { LookupResult } from "@/modules/catalog/schemas";
import type { ReceiptDoc, SaleDetail, TicketView } from "@/modules/sales";
import type { ErrorBody } from "@/lib/errors";
import type { Discount, PayMethod, ScaleLabelLine } from "@/modules/sales/totals";
import { plain, safeAction } from "../../inventory/_lib/form";
import { PrintReceiptButton } from "../../_components/receipt-print";
import { usePrinter } from "../../_components/printing";
import { KitchenSlipView } from "../../_components/kitchen-print";
import {
  cancelTicketAction,
  moveTicketAction,
  openTicketAction,
  saveTicketAction,
  sendTicketAction,
} from "../ticket-actions";
import { canQueueOffline, cartFromTicket, mergeIntoTicket, ticketErrorKey, ticketLinesOf } from "../_lib/tickets";
import { TablesView } from "./tables-view";
import { TicketBar, type OrderType } from "./ticket-bar";
import { createSaleAction, tillStockAction } from "../actions";
import { CustomerPicker } from "./customer-picker";
import {
  addToCart,
  cartKey,
  fromScaleLabel,
  setLineNote,
  setLineStaff,
  type PickedOptions,
  type TillAppointment,
  type TillStaff,
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
  tillShortcut,
  type CartLine,
  type TillCustomer,
  type TillItem,
  type TillSettings,
  type TillOffline,
} from "../_lib/till";
import { reach, searchSnapshot, unreachable } from "../_lib/offline";
import { useOfflineTill } from "../_lib/use-offline";
import { Icon } from "@/app/_ui/icons";
import type { TillLayout } from "@/modules/presets";
import { TilePanel } from "./tile-panel";
import { OptionsPicker } from "./options-picker";
import {
  DiscountBox,
  ExactCashButton,
  OFFLINE_BLOCK,
  OfflineBar,
  OfflineReceipt,
  StockNote,
  WeightBox,
  type DiscountDraft,
} from "./till-parts";

type Props = {
  /** Scan-first or tap tiles under the scan box (business-profiles-spec BP6). */
  layout: TillLayout;
  /** Tables, open tickets and order types: a café (restaurant-cafe-spec R1). */
  tickets?: boolean;
  /** Who can do a line, for a salon (salon-spec S4); empty elsewhere. */
  staff?: TillStaff[];
  /** An appointment to check out (salon-spec S7). */
  appointment?: TillAppointment | null;
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

/**
 * The till (checkout UX): scan or search, build the cart, take one payment, charge. Totals on
 * screen are a preview; the server prices the sale and the receipt shows its numbers.
 */
export function Till({
  locale,
  branchId,
  registerId,
  userId,
  settings,
  offline,
  layout,
  tickets = false,
  staff = [],
  appointment = null,
}: Props) {
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
  const [cart, setCart] = useState<CartLine[]>(() =>
    (appointment?.items ?? []).reduce<CartLine[]>(
      (lines, item) => addToCart(lines, item, 1, undefined, undefined, appointment?.staff ?? null),
      [],
    ),
  );
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
  // A KG item waiting for its weight (weighed-selling-spec W5).
  const [weighing, setWeighing] = useState<TillItem | null>(null);
  // An item with option groups waiting for its options (restaurant-cafe-spec R7), and the line whose note is open.
  const [picking, setPicking] = useState<TillItem | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  // The café floor (restaurant-cafe-spec R2-R6, R10): the open ticket, the type of a new order, the Tables view.
  const [ticket, setTicket] = useState<TicketView | null>(null);
  const [orderType, setOrderType] = useState<OrderType>("TAKEAWAY");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [floor, setFloor] = useState<{ mode: "open" | "move"; n: number } | null>(
    tickets ? { mode: "open", n: 0 } : null,
  );
  const printer = usePrinter();
  // The staff member new lines are for (salon-spec S4).
  const [currentStaff, setCurrentStaff] = useState<TillStaff | null>(appointment?.staff ?? null);
  // The appointment being checked out (S7): its services start the cart; it is sold with the sale.
  const [checkingOut, setCheckingOut] = useState<TillAppointment | null>(appointment);
  const staffById = (id: string) => staff.find((member) => member.id === id) ?? null;
  // The service charge (R11): on a dine-in order unless taken off this one.
  const [serviceOff, setServiceOff] = useState(false);
  const weightRef = useRef<HTMLInputElement>(null);
  // The sale's customer; null = walk-in (customers-spec CU7, CU12).
  const [customer, setCustomer] = useState<TillCustomer | null>(appointment?.customer ?? null);
  // Offline till (offline-till-spec slice 2): the device's state, and the slip of a sale rung up offline.
  const off = useOfflineTill({ branchId, registerId, userId, allowed: offline.allowed });
  const [offlineReceipt, setOfflineReceipt] = useState<ReceiptDoc | null>(null);
  // Sell offline straight away while the server is known to be away and this device may (OF6).
  const sellingOffline = off.offline && off.block === null;
  const limitLabel = settings.discount.limitBp === null ? null : `${settings.discount.limitBp / 100}%`;

  const servicePossible = tickets && !sellingOffline && (settings.serviceChargeBp ?? 0) > 0 && orderType === "DINE_IN";
  const preview = previewCart(
    cart,
    settings,
    saleDiscount,
    servicePossible && !serviceOff ? (settings.serviceChargeBp ?? 0) : 0,
  );
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
    selectedKey && cart.some((line) => cartKey(line) === selectedKey)
      ? selectedKey
      : cart.length > 0
        ? cartKey(cart[cart.length - 1])
        : null;

  function focusSearch() {
    searchRef.current?.focus();
  }

  /** Loads on-hand for these items; a failure just leaves the stock out. */
  async function loadStock(all: readonly TillItem[]) {
    // A service holds no stock (salon-spec S2): no on-hand figure, so no stock note under it.
    const items = all.filter((item) => !item.isService);
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
    const current = target === "SALE" ? saleDiscount : cart.find((line) => cartKey(line) === target)?.discount;
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
        if (weighing) {
          setWeighing(null);
          focusSearch();
          return;
        }
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

  /**
   * `refocus` false: a touch tap on a tile, which must not pop up the on-screen keyboard. A KG item asks for its
   * weight first (weighed-selling-spec W5); `grams` is that weight.
   */
  function add(item: TillItem, refocus = true, grams?: number, label?: ScaleLabelLine, picked?: PickedOptions) {
    if ((item.unitType === "KG" && grams === undefined) || (item.optionGroups?.length && !picked)) {
      if (item.unitType === "KG") setWeighing(item);
      else setPicking(item);
      setResults(null);
      setQuery("");
      setError(null);
      return;
    }
    setWeighing(null);
    setPicking(null);
    setCart((current) => addToCart(current, item, grams ?? 1, label, picked, currentStaff));
    setSelectedKey(cartKey({ ...item, options: picked?.options, staffMemberId: currentStaff?.id }));
    setResults(null);
    setQuery("");
    setError(null);
    if (refocus) focusSearch();
  }

  async function find() {
    const q = query.trim();
    if (!q) return;
    const label = parseScaleLabel(q, settings.scale);
    // Not a weighed item's label: the code may be one of the shop's own barcodes in the same range.
    const labelMiss = label ? await addScaleLabel(label) : null;
    if (label && !labelMiss) return;
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
    if (items.length === 0 && labelMiss) {
      setError(tr(labelMiss));
      return;
    }
    // A scan that finds exactly one item goes straight into the cart.
    if (items.length === 1) add(items[0]);
    else setResults(items);
    void loadStock(items);
  }

  /** A scale label (weighed-selling-spec W6): prefix + item code is the barcode of a KG item. */
  /** Null once handled (added, or refused with a message); otherwise why it is not a weighed item's label. */
  async function addScaleLabel(label: ScaleLabel): Promise<"pos.label.unknown" | "pos.label.notWeighed" | null> {
    if (label.kind === "bad-check-digit") {
      setError(tr("pos.label.badCheck"));
      return null;
    }
    const fromSnapshot = (): TillItem | null => {
      const hit = off.snapshot?.items.find((item) => item.barcodes.includes(label.lookupCode));
      return hit ? (searchSnapshot([hit], label.lookupCode)[0] ?? null) : null;
    };
    let item: TillItem | null;
    if (sellingOffline && off.snapshot) item = fromSnapshot();
    else {
      try {
        const code = new URLSearchParams({ code: label.lookupCode });
        const response = await fetch(`/api/barcodes?${code}`, { headers: { accept: "application/json" } });
        if (response.status === 404) item = null;
        else if (!response.ok) throw new Error(`lookup failed: ${response.status}`);
        else {
          const found = (await response.json()) as LookupResult;
          if (!found.sellable) {
            setError(tr("pos.error.notSellable"));
            return null;
          }
          item = {
            productId: found.productId,
            variantId: found.variantId,
            sku: found.sku,
            name: found.name,
            nameAr: found.nameAr,
            unitPriceMinor: found.unitPriceMinor,
            vatApplicable: found.vatApplicable,
            unitType: found.unitType === "KG" ? "KG" : "EACH",
          };
        }
      } catch (err) {
        if (!(err instanceof TypeError) || !off.snapshot || off.block !== null) {
          setError(tr("pos.error.generic"));
          return null;
        }
        off.markUnreachable();
        item = fromSnapshot();
      }
    }
    if (!item) return "pos.label.unknown";
    const weighed = fromScaleLabel(label, item);
    if (!weighed) return "pos.label.notWeighed";
    add(item, true, weighed.grams, weighed.label);
    void loadStock([item]);
    return null;
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
    setTicket(null);
    setOrderType("TAKEAWAY");
    setDeliveryAddress("");
    setServiceOff(false);
    setCheckingOut(null);
    if (tickets) showFloor("open");
    focusSearch();
  }

  function showFloor(mode: "open" | "move") {
    // A new key each time: the floor reloads the tables and tickets when shown.
    setFloor((current) => ({ mode, n: (current?.n ?? 0) + 1 }));
  }

  function ticketError(err: ErrorBody) {
    setError(plain(locale, ticketErrorKey(err)));
  }

  /** A ticket picked on the floor: its lines in the cart. A new, empty one keeps what is already rung up. */
  function loadTicket(next: TicketView) {
    setTicket(next);
    setOrderType(next.orderType);
    // What was rung up before picking a busy table joins its ticket (saved with the next Hold, Send or Pay).
    if (!ticket && cart.length > 0 && next.lines.length > 0) setCart(mergeIntoTicket(cartFromTicket(next), cart));
    else if (next.lines.length > 0 || ticket) setCart(cartFromTicket(next));
    if (next.customer) setCustomer({ ...next.customer, taxNumber: null });
    setFloor(null);
    setSelectedKey(null);
    setError(null);
    setSaleKey(crypto.randomUUID());
    focusSearch();
  }

  /** Saves the cart to the ticket, opening one for a takeaway or delivery order. Null when it could not. */
  async function saveTicket(): Promise<TicketView | null> {
    let current = ticket;
    if (!current) {
      if (orderType === "DINE_IN") {
        showFloor("open");
        setError(tr("pos.ticket.pickTable"));
        return null;
      }
      const opened = await openTicketAction({
        branchId,
        orderType,
        ...(customer ? { customerId: customer.id } : {}),
        ...(deliveryAddress.trim() ? { deliveryAddress: deliveryAddress.trim() } : {}),
      });
      if (!opened.ok) {
        ticketError(opened.error);
        return null;
      }
      current = opened.data;
    }
    const saved = await saveTicketAction(current.id, { version: current.version, lines: ticketLinesOf(cart) });
    if (!saved.ok) {
      ticketError(saved.error);
      return null;
    }
    if (saved.data.cancelled) printer.print(<KitchenSlipView slip={saved.data.cancelled} locale={locale} />);
    setTicket(saved.data.ticket);
    setCart((current) => cartFromTicket(saved.data.ticket, current));
    return saved.data.ticket;
  }

  async function holdTicket() {
    setPending(true);
    setError(null);
    const saved = await saveTicket();
    setPending(false);
    if (saved) newSale();
  }

  async function sendTicket() {
    setPending(true);
    setError(null);
    const saved = await saveTicket();
    if (!saved) {
      setPending(false);
      return;
    }
    const sent = await sendTicketAction(saved.id, saved.version);
    setPending(false);
    if (!sent.ok) {
      ticketError(sent.error);
      return;
    }
    if (sent.data.slip) printer.print(<KitchenSlipView slip={sent.data.slip} locale={locale} />);
    setTicket(sent.data.ticket);
    setCart((current) => cartFromTicket(sent.data.ticket, current));
  }

  async function moveTicket(tableId: string) {
    if (!ticket) return;
    setPending(true);
    const moved = await moveTicketAction(ticket.id, { version: ticket.version, tableId });
    setPending(false);
    setFloor(null);
    if (moved.ok) setTicket(moved.data);
    else ticketError(moved.error);
  }

  async function cancelTicket(reason: string | undefined) {
    if (!ticket) return;
    setPending(true);
    const cancelled = await cancelTicketAction(ticket.id, { version: ticket.version, ...(reason ? { reason } : {}) });
    setPending(false);
    if (cancelled.ok) newSale();
    else ticketError(cancelled.error);
  }

  async function charge(event: FormEvent) {
    event.preventDefault();
    if (!ready || !plan) return;
    setPending(true);
    setError(null);
    // A ticket is saved first, so the sale is exactly its lines at its newest version (R5).
    const paying = ticket && !sellingOffline ? await saveTicket() : null;
    if (ticket && !sellingOffline && !paying) {
      setPending(false);
      return;
    }
    const body = {
      branchId,
      registerId,
      lines: cart.map((line) => ({
        ref: { productId: line.productId, variantId: line.variantId },
        qty: line.qty,
        ...(line.discount ? { discount: line.discount } : {}),
        ...(line.labels ? { labels: line.labels } : {}),
        ...(line.options?.length ? { options: line.options } : {}),
        ...(line.note ? { note: line.note } : {}),
        ...(line.staffMemberId ? { staffMemberId: line.staffMemberId } : {}),
      })),
      ...(saleDiscount ? { discount: saleDiscount } : {}),
      ...(customer ? { customerId: customer.id } : {}),
      ...(paying
        ? { ticket: { id: paying.id, version: paying.version } }
        : tickets
          ? { orderType: sellingOffline ? ("TAKEAWAY" as const) : orderType }
          : {}),
      ...(servicePossible && serviceOff ? { serviceCharge: false } : {}),
      ...(checkingOut ? { appointmentId: checkingOut.id } : {}),
      payments: plan.payments,
    };
    const sent = sellingOffline ? "UNREACHABLE" : await reach(() => createSaleAction(body, saleKey));
    // A ticket payment or a service charge needs the server (R5, R12): never queued offline, the key kept to retry.
    const queueable = canQueueOffline({
      paysTicket: paying !== null,
      serviceChargeMinor: preview.ok ? preview.serviceChargeMinor : 0,
      checksOutAppointment: checkingOut !== null,
    });
    if (unreachable(sent) && off.device && !queueable) {
      setPending(false);
      setError(tr("pos.ticket.error.offline"));
      return;
    }
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
    if ((result.error.details as { reason?: string } | null)?.reason === "APPOINTMENT_CLOSED") setCheckingOut(null);
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
          {receipt.lines.map((line, index) => (
            <li key={index} className="flex flex-wrap justify-between gap-x-4">
              <span>
                {displayName(line, locale)}
                {line.unitType === "KG" ? null : ` × ${line.qty}`}
                {line.options.length > 0 ? (
                  <span className="block text-sm text-muted">
                    {line.options.map((option) => (locale === "ar" && option.nameAr) || option.name).join(" · ")}
                  </span>
                ) : null}
                {line.note ? <span className="block text-sm text-muted">“{line.note}”</span> : null}
                {line.staff ? (
                  <span className="block text-sm text-muted">{tr("receipt.by", { name: line.staff.name })}</span>
                ) : null}
              </span>
              <span dir="ltr">{money(line.lineTotalMinor)}</span>
              {line.unitType === "KG" ? (
                // A weighed line: its weight and price per kg (W9).
                <bdi className="w-full ps-4 text-sm text-muted">
                  {formatQty(line.qty, "KG", locale)} × {money(line.unitPriceMinor)}
                </bdi>
              ) : null}
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
          {receipt.serviceChargeMinor > 0 ? (
            <>
              <dt>{tr("receipt.serviceCharge")}</dt>
              <dd dir="ltr" className="text-end" data-testid="receipt-service-charge">
                {money(receipt.serviceChargeMinor)}
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
    <div className="till grid gap-6 lg:grid-cols-[2fr_1fr] lg:items-start" data-testid="till">
      <OfflineBar
        locale={locale}
        off={off}
        canEnrol={offline.allowed && offline.canEnrol && !offline.registerHasDevice}
      />
      <section aria-labelledby="cart-title" className="card flex flex-col gap-4">
        {tickets && !sellingOffline ? (
          <TicketBar
            locale={locale}
            ticket={ticket}
            orderType={orderType}
            onOrderType={setOrderType}
            deliveryAddress={deliveryAddress}
            onDeliveryAddress={setDeliveryAddress}
            hasLines={cart.length > 0}
            pending={pending}
            onTables={() => (ticket ? void holdTicket() : showFloor("open"))}
            onHold={() => void holdTicket()}
            onSend={() => void sendTicket()}
            onMove={() => showFloor("move")}
            onCancel={(reason) => void cancelTicket(reason)}
          />
        ) : null}
        {tickets && !sellingOffline && floor ? (
          <TablesView
            key={floor.n}
            locale={locale}
            branchId={branchId}
            money={money}
            mode={floor.mode}
            onOpen={loadTicket}
            onMove={(tableId) => void moveTicket(tableId)}
            onError={setError}
          />
        ) : null}
        {printer.portal}
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
        {staff.length > 0 ? (
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{tr("pos.staff.label")}</span>
            <select
              className="input min-h-12"
              value={currentStaff?.id ?? ""}
              onChange={(e) => setCurrentStaff(staffById(e.target.value))}
              data-testid="till-staff"
            >
              <option value="">{tr("pos.staff.none")}</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
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
                    <StockNote locale={locale} onHand={stock[lineKey(item)]} qty={0} unitType={item.unitType} />
                    <span dir="ltr">
                      {money(item.unitPriceMinor)}
                      {item.unitType === "KG" ? <span className="text-muted">/{tr("pos.weight.kg")}</span> : null}
                    </span>
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

        {weighing ? (
          <WeightBox
            // A new box for each item, so the typed weight starts empty.
            key={lineKey(weighing)}
            locale={locale}
            name={displayName(weighing, locale)}
            priceLabel={`${money(weighing.unitPriceMinor)} / ${tr("pos.weight.kg")}`}
            inputRef={weightRef}
            onAdd={(grams) => add(weighing, true, grams)}
            onCancel={() => {
              setWeighing(null);
              focusSearch();
            }}
          />
        ) : null}

        {picking ? (
          <OptionsPicker
            key={lineKey(picking)}
            locale={locale}
            item={picking}
            money={money}
            onAdd={(picked) => add(picking, true, undefined, undefined, picked)}
            onCancel={() => {
              setPicking(null);
              focusSearch();
            }}
          />
        ) : null}

        {layout === "tiles" ? (
          <TilePanel
            locale={locale}
            money={money}
            onAdd={add}
            snapshot={sellingOffline && off.snapshot ? off.snapshot : null}
            fallback={off.block === null ? off.snapshot : null}
            onUnreachable={off.markUnreachable}
            stock={stock}
            onShown={(items) => void loadStock(items)}
          />
        ) : null}

        {checkingOut ? (
          <p className="notice" data-testid="till-appointment">
            {tr("pos.appointment.checkingOut", { name: checkingOut.customerName })}
          </p>
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
                  const key = cartKey(line);
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
                        <StockNote
                          locale={locale}
                          onHand={stock[lineKey(line)]}
                          qty={line.qty}
                          unitType={line.unitType}
                          block
                        />
                        {line.sentQty ? (
                          <span className="badge badge-success ms-1" data-testid="line-sent">
                            {tr("pos.ticket.sent", { qty: line.sentQty })}
                          </span>
                        ) : null}
                        {staff.length > 0 ? (
                          <select
                            className="input mt-1 min-h-10 w-full"
                            aria-label={tr("pos.staff.for", { name })}
                            value={line.staffMemberId ?? ""}
                            onChange={(e) =>
                              setCart((current) => setLineStaff(current, key, staffById(e.target.value)))
                            }
                          >
                            <option value="">{tr("pos.staff.none")}</option>
                            {staff.map((member) => (
                              <option key={member.id} value={member.id}>
                                {member.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {line.optionLabels?.length ? (
                          <span className="block text-sm text-muted">
                            {line.optionLabels
                              .map((option) => (locale === "ar" && option.nameAr) || option.name)
                              .join(" · ")}
                          </span>
                        ) : null}
                        {noteFor === key ? (
                          <input
                            autoFocus
                            className="input mt-1 min-h-10 w-full"
                            maxLength={140}
                            aria-label={tr("pos.note.for", { name })}
                            defaultValue={line.note ?? ""}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setNoteFor(null);
                              if (event.key === "Enter") {
                                event.preventDefault();
                                const value = event.currentTarget.value;
                                setCart((current) => setLineNote(current, key, value));
                                setNoteFor(null);
                                focusSearch();
                              }
                            }}
                            onBlur={(event) => {
                              const value = event.currentTarget.value;
                              setCart((current) => setLineNote(current, key, value));
                              setNoteFor(null);
                            }}
                          />
                        ) : line.note ? (
                          <span className="block text-sm" data-testid="line-note">
                            “{line.note}”
                          </span>
                        ) : null}
                        {preview.ok && (preview.lineDiscounts[key] ?? 0) > 0 ? (
                          <span className="block text-sm text-muted" data-testid="line-discount">
                            {tr("pos.discount.lineNote", { amount: money(preview.lineDiscounts[key]) })}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className="flex items-center gap-1">
                          <input
                            dir="ltr"
                            inputMode={line.unitType === "KG" ? "decimal" : "numeric"}
                            aria-label={tr("pos.cart.qtyFor", { name })}
                            aria-invalid={line.qty < 1}
                            value={
                              line.unitType === "KG"
                                ? (line.qtyText ?? qtyInputValue(line.qty, "KG"))
                                : line.qty === 0
                                  ? ""
                                  : line.qty
                            }
                            onChange={(e) => setCart((current) => setLineQty(current, key, e.target.value))}
                            onFocus={() => setSelectedKey(key)}
                            className={`input min-h-12 px-2 py-1 ${line.unitType === "KG" ? "w-24" : "w-20"}`}
                          />
                          {line.unitType === "KG" ? (
                            <span className="text-sm text-muted">{tr("pos.weight.kg")}</span>
                          ) : null}
                        </span>
                      </td>
                      <td dir="ltr" className="text-end">
                        {money(line.unitPriceMinor)}
                        {line.unitType === "KG" ? <span className="text-muted">/{tr("pos.weight.kg")}</span> : null}
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
                        {/* A sent line keeps its note: changing it would take the sent dish back (R10). */}
                        {line.sentQty ? null : (
                          <button
                            type="button"
                            onClick={() => setNoteFor(key)}
                            aria-label={tr("pos.note.add", { name })}
                            className="btn btn-sm me-1"
                          >
                            {tr("pos.note.button")}
                          </button>
                        )}
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
                    name: displayName(cart.find((line) => cartKey(line) === discountDraft.target) ?? cart[0], locale),
                  })
            }
            onChange={setDiscountDraft}
            onApply={applyDiscount}
            onCancel={closeDiscount}
          />
        ) : null}
        {cart.length > 0 ? (
          <button type="button" onClick={newSale} className="btn btn-ghost self-start">
            {tr("pos.cart.clear")}
          </button>
        ) : null}
      </section>

      <form
        onSubmit={charge}
        aria-label={tr("pos.pay.method")}
        className="card flex flex-col gap-4 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
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
            {servicePossible ? (
              <>
                <dt className="flex flex-wrap items-center gap-2">
                  {tr("pos.service.row", { rate: `${(settings.serviceChargeBp ?? 0) / 100}%` })}
                  <button type="button" className="btn btn-sm" onClick={() => setServiceOff((off) => !off)}>
                    {tr(serviceOff ? "pos.service.restore" : "pos.service.remove")}
                  </button>
                </dt>
                <dd dir="ltr" className="text-end" data-testid="till-service-charge">
                  {money(preview.serviceChargeMinor)}
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
