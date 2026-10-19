/**
 * Pure helpers for the till screen (client-safe). Unit-tested in tests/unit/pos-till-helpers.test.ts.
 * No DB, no server imports. Totals here are a preview only: the server prices every sale (D1).
 */
import type { ErrorBody } from "@/lib/errors";
import type { Locale, MessageKey } from "@/lib/i18n";
import { MoneyError, parseMajor, type CurrencyCode } from "@/lib/money";
import { normalizeQty } from "@/modules/inventory/schemas";
import { priceLine, totalsOf, type PayMethod } from "@/modules/sales/totals";

export type TillSettings = { currency: CurrencyCode; vatRateBp: number; pricesIncludeVat: boolean };

/** A sellable item as the catalog search returns it (no cost). */
export type TillItem = {
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  nameAr: string | null;
  unitPriceMinor: number;
  vatApplicable: boolean;
};

export type CartLine = TillItem & { qty: number };

export const lineKey = (item: { productId: string; variantId: string | null }) =>
  `${item.productId}|${item.variantId ?? ""}`;

export function displayName(item: { name: string; nameAr: string | null }, locale: Locale): string {
  return locale === "ar" && item.nameAr ? item.nameAr : item.name;
}

/** Adds one unit; a second scan of the same item increments its line. */
export function addToCart(cart: readonly CartLine[], item: TillItem): CartLine[] {
  const key = lineKey(item);
  if (cart.some((line) => lineKey(line) === key)) {
    return cart.map((line) => (lineKey(line) === key ? { ...line, qty: line.qty + 1 } : line));
  }
  return [...cart, { ...item, qty: 1 }];
}

/** Typed quantity. Arabic-Indic digits are read; an empty or invalid box counts as 0 and blocks the charge. */
export function setLineQty(cart: readonly CartLine[], key: string, raw: string): CartLine[] {
  const qty = normalizeQty(raw) ?? 0;
  return cart.map((line) => (lineKey(line) === key ? { ...line, qty } : line));
}

export function removeLine(cart: readonly CartLine[], key: string): CartLine[] {
  return cart.filter((line) => lineKey(line) !== key);
}

export type CartPreview =
  | {
      ok: true;
      lineTotals: Record<string, number>;
      subtotalMinor: number;
      vatMinor: number;
      totalMinor: number;
    }
  | { ok: false; reason: "TOO_LARGE" };

/** Same arithmetic as the server; lines with an invalid qty count as 0 until fixed. */
export function previewCart(cart: readonly CartLine[], settings: TillSettings): CartPreview {
  try {
    const priced = cart.map((line) =>
      priceLine(
        { unitPriceMinor: line.unitPriceMinor, qty: Math.max(line.qty, 0), vatApplicable: line.vatApplicable },
        settings.vatRateBp,
        settings.pricesIncludeVat,
      ),
    );
    const totals = totalsOf(priced);
    const lineTotals: Record<string, number> = {};
    cart.forEach((line, index) => (lineTotals[lineKey(line)] = priced[index].lineTotalMinor));
    return { ok: true, lineTotals, ...totals };
  } catch {
    return { ok: false, reason: "TOO_LARGE" };
  }
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

/** The charge button is live only for a valid cart, a fitting total and a covered payment. */
export function canCharge(cart: readonly CartLine[], preview: CartPreview, plan: PaymentPlan | null): boolean {
  return cart.length > 0 && cart.every((line) => line.qty >= 1) && preview.ok && plan !== null;
}

/** Message for a failed sale, by error code and `details.reason`. */
export function saleErrorKey(error: ErrorBody): MessageKey {
  if (error.code === "IDEMPOTENCY_CONFLICT") return "pos.error.idempotency";
  if (error.code === "FORBIDDEN") return "pos.error.forbidden";
  if (error.code === "NOT_FOUND") return "pos.error.notFound";
  const reason = (error.details as { reason?: string } | null)?.reason;
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
    default:
      return "pos.error.generic";
  }
}

/**
 * Whether the next attempt must reuse this cart's Idempotency-Key. Only when the outcome is
 * unknown (a dropped connection or a 500) could the sale exist, and a retry must replay it. Any
 * other error means nothing was written, so a fresh key lets the cashier fix the cart and retry
 * without an IDEMPOTENCY_CONFLICT.
 */
export function keepKeyAfter(error: ErrorBody): boolean {
  return error.code === "INTERNAL" || error.code === "DB_UNAVAILABLE";
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

/** +/- on the selected line; the quantity never drops below 1 (use × to remove a line). */
export function bumpQty(cart: readonly CartLine[], key: string, delta: 1 | -1): CartLine[] {
  return cart.map((line) => (lineKey(line) === key ? { ...line, qty: Math.max(line.qty + delta, 1) } : line));
}

export type TillShortcut = "search" | "cash" | "exact" | "close" | "inc" | "dec";

/**
 * Till keys (docs/user/cashier.md): F2 search, F4 cash, F8 exact cash, Esc close, + and - change
 * the selected line. + and - are typed text inside a field, so they act only outside one.
 */
export function tillShortcut(key: string, inField: boolean): TillShortcut | null {
  switch (key) {
    case "F2":
      return "search";
    case "F4":
      return "cash";
    case "F8":
      return "exact";
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
