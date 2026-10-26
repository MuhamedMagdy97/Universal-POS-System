/**
 * Pure helpers for the till screen (client-safe). Unit-tested in tests/unit/pos-till-helpers.test.ts.
 * No DB, no server imports. Totals here are a preview only: the server prices every sale (D1).
 */
import type { ErrorBody } from "@/lib/errors";
import type { Locale, MessageKey } from "@/lib/i18n";
import { AppError } from "@/lib/errors";
import { MoneyError, parseMajor, parsePercentBp, toMajorString, type CurrencyCode } from "@/lib/money";
import { KG_SCALE, MAX_QTY, parseQtyInput, type QtyUnit } from "@/lib/quantity";
import type { ScaleLabel, ScaleSettings } from "@/lib/scale-label";
import type { OptionGroupView } from "@/modules/catalog/schemas";
import { lineKeyOf, type OptionSnapshot } from "@/modules/sales/options";
import { NOTE_MAX } from "@/modules/sales/schemas";
import {
  overDiscountLimit,
  priceSale,
  type Discount,
  type PayMethod,
  type ScaleLabelLine,
} from "@/modules/sales/totals";

export type TillSettings = {
  currency: CurrencyCode;
  vatRateBp: number;
  pricesIncludeVat: boolean;
  /** Who may discount (discounts-spec DC7, DC8): not at all, up to `limitBp`, or without a limit (null). */
  discount: { allowed: boolean; limitBp: number | null };
  /** Pick a customer (read) and quick-add one (create) at the till (customers-spec CU12). */
  customers: { read: boolean; create: boolean };
  /** Scale labels read at this till (weighed-selling-spec W6). */
  scale: ScaleSettings;
  /** The shop's service charge on dine-in orders, in basis points; 0 = none (restaurant-cafe-spec R11). */
  serviceChargeBp?: number;
};

/** Offline selling at this till (offline-till-spec OF5, OF16): shop allows it, the user may enrol, a device exists. */
export type TillOffline = { allowed: boolean; canEnrol: boolean; registerHasDevice: boolean };

/** The customer on the sale; null = walk-in (customers-spec CU7). */
export type TillCustomer = { id: string; name: string; phone: string; taxNumber: string | null };

/** A sellable item as the catalog search returns it (no cost). */
export type TillItem = {
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  nameAr: string | null;
  /** Per kg for a KG item, whose cart quantity is grams (weighed-selling-spec W1, W2). */
  unitPriceMinor: number;
  vatApplicable: boolean;
  unitType: QtyUnit;
  /** Option groups to pick from (restaurant-cafe-spec R7); absent when the item has none. */
  optionGroups?: OptionGroupView[];
};

/** `qty` is pieces, or grams on a KG line; `qtyText` is the kg the cashier is typing on a KG line. */
export type CartLine = TillItem & {
  qty: number;
  qtyText?: string;
  discount?: Discount | null;
  /** Price scale labels (W6): the line is charged their printed totals. Gone once the weight is changed by hand. */
  labels?: ScaleLabelLine[];
  /** Chosen option ids and their labels (restaurant-cafe-spec R7); `unitPriceMinor` already includes them. */
  options?: string[];
  optionLabels?: OptionSnapshot[];
  /** The line note (R8), up to 140 characters. */
  note?: string;
  /** On a ticket: how much of the line went to the kitchen (R10). */
  sentQty?: number;
  /** Who does the line (salon-spec S4). */
  staffMemberId?: string;
  staffName?: string;
};

/** A staff member as the till picks one (salon-spec S4). */
export type TillStaff = { id: string; name: string };

/** An appointment checked out at the till (salon-spec S7): its services for its staff member, and its customer. */
export type TillAppointment = {
  id: string;
  items: TillItem[];
  staff: TillStaff | null;
  customer: TillCustomer | null;
  customerName: string;
};

/** The item's key: stock, tiles and search results. */
export const lineKey = (item: { productId: string; variantId: string | null }) =>
  `${item.productId}|${item.variantId ?? ""}`;

/** A cart line's key: the item, its options and its note (R9). Equal to `lineKey` for a plain line. */
export const cartKey = (line: {
  productId: string;
  variantId: string | null;
  options?: string[];
  note?: string;
  staffMemberId?: string;
}) => lineKeyOf(line, line.options ?? [], line.note, line.staffMemberId);

/** Options picked at the till for one line (R7). */
export type PickedOptions = { options: string[]; labels: OptionSnapshot[]; unitPriceMinor: number };

export function displayName(item: { name: string; nameAr: string | null }, locale: Locale): string {
  return locale === "ar" && item.nameAr ? item.nameAr : item.name;
}

/**
 * Adds `qty` (one piece, or the weighed grams of a KG item); the same item again adds to its line (weighed-selling
 * W5). A line capped at `MAX_QTY` stays there. `label` is a price label for those grams: a line keeps its labels
 * only while everything on it came from labels.
 */
export function addToCart(
  cart: readonly CartLine[],
  item: TillItem,
  qty = 1,
  label?: ScaleLabelLine,
  picked?: PickedOptions,
  staff?: TillStaff | null,
): CartLine[] {
  const fresh: CartLine = {
    ...item,
    qty,
    ...(picked && { unitPriceMinor: picked.unitPriceMinor, options: picked.options, optionLabels: picked.labels }),
    ...(staff && { staffMemberId: staff.id, staffName: staff.name }),
  };
  const key = cartKey(fresh);
  if (cart.some((line) => cartKey(line) === key)) {
    return cart.map((line) => {
      if (cartKey(line) !== key) return line;
      const total = Math.min(line.qty + qty, MAX_QTY);
      const labels = line.labels && label && total === line.qty + qty ? [...line.labels, label] : undefined;
      return { ...line, qty: total, qtyText: undefined, labels };
    });
  }
  return [...cart, { ...fresh, ...(label ? { labels: [label] } : {}) }];
}

/** Sets or clears one line's note (R8); a line that now matches another one joins it. */
export function setLineNote(cart: readonly CartLine[], key: string, raw: string): CartLine[] {
  return moveLine(cart, key, { note: raw.trim().slice(0, NOTE_MAX) || undefined });
}

/** Sets or clears (null) who does one line (salon-spec S4); a line that now matches another one joins it. */
export function setLineStaff(cart: readonly CartLine[], key: string, staff: TillStaff | null): CartLine[] {
  return moveLine(cart, key, { staffMemberId: staff?.id, staffName: staff?.name });
}

function moveLine(
  cart: readonly CartLine[],
  key: string,
  patch: Pick<CartLine, "note"> | Pick<CartLine, "staffMemberId" | "staffName">,
): CartLine[] {
  const line = cart.find((current) => cartKey(current) === key);
  if (!line) return [...cart];
  const moved = { ...line, ...patch };
  const twin = cart.find((current) => current !== line && cartKey(current) === cartKey(moved));
  if (!twin) return cart.map((current) => (current === line ? moved : current));
  return cart.flatMap((current) =>
    current === line
      ? []
      : current === twin
        ? [{ ...twin, qty: Math.min(twin.qty + line.qty, MAX_QTY), qtyText: undefined }]
        : [current],
  );
}

/**
 * A scanned scale label for its item → the grams to add and, for a price label, the label (W6). Null when the item
 * is not weighed, or the weight a price works out to is out of range.
 */
export function fromScaleLabel(
  label: Extract<ScaleLabel, { kind: "label" }>,
  item: TillItem,
): { grams: number; label?: ScaleLabelLine } | null {
  if (item.unitType !== "KG") return null;
  if (label.valueKind === "WEIGHT") return label.value <= MAX_QTY ? { grams: label.value } : null;
  if (item.unitPriceMinor < 1) return null;
  const grams = Math.round((label.value * KG_SCALE) / item.unitPriceMinor);
  return grams >= 1 && grams <= MAX_QTY ? { grams, label: { grams, totalMinor: label.value } } : null;
}

/**
 * Typed quantity: whole pieces, or kg with up to 3 decimals for a KG line (stored as grams; the text is kept so
 * `0.` can be typed). Arabic-Indic digits are read; an empty or invalid box counts as 0 and blocks the charge.
 */
export function setLineQty(cart: readonly CartLine[], key: string, raw: string): CartLine[] {
  return cart.map((line) =>
    cartKey(line) === key
      ? {
          ...line,
          qty: parseQtyInput(raw, line.unitType) ?? 0,
          qtyText: line.unitType === "KG" ? raw : undefined,
          labels: undefined,
        }
      : line,
  );
}

export function removeLine(cart: readonly CartLine[], key: string): CartLine[] {
  return cart.filter((line) => cartKey(line) !== key);
}

/** Sets or clears (null) one line's discount. */
export function setLineDiscount(cart: readonly CartLine[], key: string, discount: Discount | null): CartLine[] {
  return cart.map((line) => (cartKey(line) === key ? { ...line, discount } : line));
}

export type CartPreview =
  | {
      ok: true;
      lineTotals: Record<string, number>;
      /** Each line's own discount plus its share of the sale discount. */
      lineDiscounts: Record<string, number>;
      discountMinor: number;
      /** With its VAT (R11); 0 when none. */
      serviceChargeMinor: number;
      subtotalMinor: number;
      vatMinor: number;
      totalMinor: number;
      /** Past the cashier's limit: the server would refuse it (DC9). */
      overLimit: boolean;
    }
  | { ok: false; reason: "TOO_LARGE" | "DISCOUNT_TOO_LARGE" };

/** Same arithmetic as the server (`priceSale`); lines with an invalid qty count as 0 until fixed. */
export function previewCart(
  cart: readonly CartLine[],
  settings: TillSettings,
  saleDiscount: Discount | null = null,
  serviceChargeBp = 0,
): CartPreview {
  try {
    const sale = priceSale(
      cart.map((line) => ({
        unitPriceMinor: line.unitPriceMinor,
        qty: Math.max(line.qty, 0),
        vatApplicable: line.vatApplicable,
        unitType: line.unitType,
        discount: line.discount,
        labels: line.labels,
      })),
      saleDiscount,
      settings.vatRateBp,
      settings.pricesIncludeVat,
      serviceChargeBp,
    );
    const lineTotals: Record<string, number> = {};
    const lineDiscounts: Record<string, number> = {};
    cart.forEach((line, index) => {
      lineTotals[cartKey(line)] = sale.lines[index].lineTotalMinor;
      lineDiscounts[cartKey(line)] = sale.lines[index].discountMinor;
    });
    const { limitBp } = settings.discount;
    return {
      ok: true,
      lineTotals,
      lineDiscounts,
      discountMinor: sale.discountMinor,
      serviceChargeMinor: sale.serviceCharge?.lineTotalMinor ?? 0,
      subtotalMinor: sale.subtotalMinor,
      vatMinor: sale.vatMinor,
      totalMinor: sale.totalMinor,
      overLimit: sale.discountMinor > 0 && limitBp !== null && overDiscountLimit(sale, limitBp),
    };
  } catch (err) {
    const reason = err instanceof AppError ? (err.details as { reason?: string } | null)?.reason : undefined;
    return { ok: false, reason: reason === "DISCOUNT_TOO_LARGE" ? "DISCOUNT_TOO_LARGE" : "TOO_LARGE" };
  }
}

/**
 * A typed discount: a percent ("10", "12.5") or an amount in major units. Empty → null (no
 * discount); unreadable, zero or over 100% → "invalid". Arabic-Indic digits are read.
 */
export function parseDiscount(
  raw: string,
  kind: Discount["kind"],
  currency: CurrencyCode,
): Discount | null | "invalid" {
  if (raw.trim() === "") return null;
  if (kind === "PERCENT") {
    const percentBp = parsePercentBp(raw);
    return percentBp === null || percentBp === 0 ? "invalid" : { kind, percentBp };
  }
  const amountMinor = parseCash(raw, currency);
  return amountMinor === null || amountMinor === 0 ? "invalid" : { kind, amountMinor };
}

/** The value to show when a discount box opens on an existing discount. */
export function discountRaw(discount: Discount | null | undefined, currency: CurrencyCode): string {
  if (!discount) return "";
  return discount.kind === "PERCENT" ? String(discount.percentBp / 100) : toMajorString(discount.amountMinor, currency);
}

/** Cash typed in major units ("50", "50.5", Arabic-Indic digits) → minor units; null when unreadable. */
export function parseCash(raw: string, currency: CurrencyCode): number | null {
  if (raw.trim() === "") return null;
  try {
    const minor = parseMajor(raw, currency);
    return minor >= 0 ? minor : null;
  } catch (err) {
    if (err instanceof MoneyError) return null;
    throw err;
  }
}

export type PaymentDraft = {
  method: PayMethod;
  totalMinor: number;
  /** Cash received, minor units; only read for CASH. */
  cashReceivedMinor: number | null;
  reference: string;
};

export type PaymentPlan = {
  payments: { method: PayMethod; amountMinor: number; reference?: string }[];
  changeMinor: number;
};

/**
 * The payment list the server expects (checkout-data-model-and-api.md §3), or null while the
 * cash received does not cover the total. A zero-total sale takes no payment.
 */
export function planPayment(draft: PaymentDraft): PaymentPlan | null {
  if (draft.totalMinor === 0) return { payments: [], changeMinor: 0 };
  if (draft.method === "CASH") {
    const received = draft.cashReceivedMinor;
    if (received === null || received < draft.totalMinor) return null;
    return { payments: [{ method: "CASH", amountMinor: received }], changeMinor: received - draft.totalMinor };
  }
  const reference = draft.reference.trim();
  return {
    payments: [{ method: draft.method, amountMinor: draft.totalMinor, ...(reference ? { reference } : {}) }],
    changeMinor: 0,
  };
}

/** One row of a split payment: amount in minor units, 0 when left empty, null when unreadable. */
export type SplitTender = { method: PayMethod; amountMinor: number | null; reference: string };

/**
 * A split payment (at most one entry per method). Card and wallet apply their full amount and
 * together may not exceed the total; cash must cover the rest and is the only tender that can
 * give change. Null while the tenders don't add up.
 */
export function planSplit(totalMinor: number, tenders: readonly SplitTender[]): PaymentPlan | null {
  if (totalMinor === 0) return { payments: [], changeMinor: 0 };
  if (tenders.some((tender) => tender.amountMinor === null)) return null;
  const payments = tenders
    .filter((tender) => (tender.amountMinor ?? 0) > 0)
    .map((tender) => {
      const reference = tender.method === "CASH" ? "" : tender.reference.trim();
      return { method: tender.method, amountMinor: tender.amountMinor ?? 0, ...(reference ? { reference } : {}) };
    });
  const nonCashMinor = payments.reduce((sum, p) => (p.method === "CASH" ? sum : sum + p.amountMinor), 0);
  const remainderMinor = totalMinor - nonCashMinor;
  const cashMinor = payments.find((p) => p.method === "CASH")?.amountMinor ?? 0;
  // Cash with nothing left to pay would be stored as a zero payment: refuse it.
  if (remainderMinor < 0 || cashMinor < remainderMinor || (remainderMinor === 0 && cashMinor > 0)) return null;
  return { payments, changeMinor: cashMinor - remainderMinor };
}

/** The charge button is live only for a valid cart, a fitting total, a discount within limit and a covered payment. */
export function canCharge(cart: readonly CartLine[], preview: CartPreview, plan: PaymentPlan | null): boolean {
  return cart.length > 0 && cart.every((line) => line.qty >= 1) && preview.ok && !preview.overLimit && plan !== null;
}

/** Message for a failed sale, by error code and `details.reason`. */
export function saleErrorKey(error: ErrorBody): MessageKey {
  if (error.code === "IDEMPOTENCY_CONFLICT") return "pos.error.idempotency";
  const reason = (error.details as { reason?: string } | null)?.reason;
  if (reason === "DISCOUNT_LIMIT") return "pos.error.discountLimit";
  if (error.code === "FORBIDDEN") return "pos.error.forbidden";
  if (reason === "CUSTOMER_INACTIVE") return "pos.error.customerInactive";
  if (error.code === "NOT_FOUND") return "pos.error.notFound";
  switch (reason) {
    case "INSUFFICIENT_STOCK":
      return "pos.error.insufficient";
    case "SHIFT_NOT_OPEN":
      return "pos.error.shiftNotOpen";
    case "PAYMENT_MISMATCH":
      return "pos.error.payment";
    case "ITEM_NOT_SELLABLE":
      return "pos.error.notSellable";
    case "AMOUNT_TOO_LARGE":
      return "pos.error.tooLarge";
    case "DISCOUNT_TOO_LARGE":
      return "pos.error.discountTooLarge";
    case "LABEL_MISMATCH":
      return "pos.label.mismatch";
    case "OPTIONS_INVALID":
      return "pos.options.invalid";
    // Paying a ticket (restaurant-cafe-spec R5).
    case "TICKET_CHANGED":
      return "pos.ticket.error.changed";
    case "TICKET_CLOSED":
      return "pos.ticket.error.closed";
    // A shop linked to the inventory system (integration spec I17).
    case "INVENTORY_UNAVAILABLE":
      return "pos.error.inventoryUnavailable";
    case "INVENTORY_LINK_BROKEN":
      return "pos.error.inventoryLinkBroken";
    case "INVENTORY_BRANCH_UNMAPPED":
      return "pos.error.inventoryBranchUnmapped";
    default:
      return "pos.error.generic";
  }
}

/**
 * Whether the next attempt must reuse this cart's Idempotency-Key. Only when the outcome is
 * unknown (a dropped connection or a 500) could the sale exist, and a retry must replay it. Any
 * other error means nothing was written, so a fresh key lets the cashier fix the cart and retry
 * without an IDEMPOTENCY_CONFLICT. An unreachable inventory system keeps it too (integration spec
 * I17): Retry then reuses the same inventory-system keys.
 */
export function keepKeyAfter(error: ErrorBody): boolean {
  return error.code === "INTERNAL" || error.code === "DB_UNAVAILABLE" || error.code === "INVENTORY_UNAVAILABLE";
}

/** Cart lines named in an INSUFFICIENT_STOCK error, for the message. */
export function shortLines(error: ErrorBody, cart: readonly CartLine[]): CartLine[] {
  const details = error.details as {
    reason?: string;
    lines?: { productId: string; variantId: string | null }[];
  } | null;
  if (details?.reason !== "INSUFFICIENT_STOCK" || !Array.isArray(details.lines)) return [];
  const keys = new Set(details.lines.map((line) => lineKey(line)));
  return cart.filter((line) => keys.has(lineKey(line)));
}

/** Cash that pays exactly: the total, or in a split what card and wallet leave unpaid (never below 0). */
export function exactCashMinor(totalMinor: number, tenders: readonly SplitTender[] = []): number {
  const nonCashMinor = tenders.reduce((sum, t) => (t.method === "CASH" ? sum : sum + (t.amountMinor ?? 0)), 0);
  return Math.max(totalMinor - nonCashMinor, 0);
}

/** Whether the branch holds less than this line needs (or nothing at all). Shown only; the server decides the sale. */
export function stockShort(onHand: number, qty: number): boolean {
  return onHand < Math.max(qty, 1);
}

/** `+` / `-`: one piece, or 0.1 kg (100 g) on a KG line; never below the smallest amount (W5). */
export function bumpQty(cart: readonly CartLine[], key: string, delta: 1 | -1): CartLine[] {
  return cart.map((line) => {
    if (cartKey(line) !== key) return line;
    const step = line.unitType === "KG" ? 100 : 1;
    return {
      ...line,
      qty: Math.min(Math.max(line.qty + delta * step, 1), MAX_QTY),
      qtyText: undefined,
      labels: undefined,
    };
  });
}

export type TillShortcut =
  "search" | "cash" | "exact" | "close" | "inc" | "dec" | "lineDiscount" | "saleDiscount" | "customer";

/**
 * Till keys (docs/user/cashier.md): F2 search, F4 cash, F6 discount on the selected line, F7
 * discount on the sale, F8 exact cash, F9 customer, Esc close, + and - change the selected line. + and - are
 * typed text inside a field, so they act only outside one.
 */
export function tillShortcut(key: string, inField: boolean): TillShortcut | null {
  switch (key) {
    case "F2":
      return "search";
    case "F4":
      return "cash";
    case "F6":
      return "lineDiscount";
    case "F7":
      return "saleDiscount";
    case "F8":
      return "exact";
    case "F9":
      return "customer";
    case "Escape":
      return "close";
    case "+":
      return inField ? null : "inc";
    case "-":
      return inField ? null : "dec";
    default:
      return null;
  }
}
