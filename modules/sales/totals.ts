import { MAX_STORABLE_MINOR, multiply, percentOfBp, sum, vatInGross, vatOnNet } from "@/lib/money";
import { amountTooLarge, discountTooLarge, invalidPayment } from "./errors";

/**
 * Pure checkout rules (no DB): line pricing, sale totals and payment settlement.
 * See docs/planning/phase-8/checkout-data-model-and-api.md (§2–§3). Unit-tested in
 * tests/unit/sales-totals.test.ts.
 */

export type PayMethod = "CASH" | "CARD_MANUAL" | "WALLET";

export type PricedInput = {
  unitPriceMinor: number;
  qty: number;
  vatApplicable: boolean;
};

export type PricedLine = {
  netMinor: number;
  vatRateBp: number;
  vatMinor: number;
  lineTotalMinor: number;
};

/** Money columns are 32-bit; anything larger is refused with a 422 instead of failing at the DB. */
function storable(value: number, label: "line" | "sale"): number {
  if (value > MAX_STORABLE_MINOR) throw amountTooLarge(label);
  return value;
}

/**
 * One line's VAT and totals. Zero-rated and exempt items (`vatApplicable` false) carry no VAT.
 * `discountMinor` comes off the shelf amount first; VAT is on what is left (discounts-spec DC2, DC5).
 */
export function priceLine(item: PricedInput, rateBp: number, pricesIncludeVat: boolean, discountMinor = 0): PricedLine {
  const effectiveRate = item.vatApplicable ? rateBp : 0;
  if (pricesIncludeVat) {
    const gross = multiply(item.unitPriceMinor, item.qty) - discountMinor;
    const vat = vatInGross(gross, effectiveRate);
    return { netMinor: gross - vat, vatRateBp: effectiveRate, vatMinor: vat, lineTotalMinor: storable(gross, "line") };
  }
  const net = multiply(item.unitPriceMinor, item.qty) - discountMinor;
  const vat = vatOnNet(net, effectiveRate);
  return { netMinor: net, vatRateBp: effectiveRate, vatMinor: vat, lineTotalMinor: storable(net + vat, "line") };
}

export type SaleTotals = {
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
};

export function totalsOf(lines: readonly PricedLine[]): SaleTotals {
  const subtotalMinor = sum(lines.map((line) => line.netMinor));
  const vatMinor = sum(lines.map((line) => line.vatMinor));
  return { subtotalMinor, vatMinor, totalMinor: storable(subtotalMinor + vatMinor, "sale") };
}

// ---------- discounts (docs/planning/discounts/discounts-spec.md) ----------

export type Discount = { kind: "AMOUNT"; amountMinor: number } | { kind: "PERCENT"; percentBp: number };

export type SaleLineDraft = PricedInput & { discount?: Discount | null };

export type PricedSaleLine = PricedLine & {
  /** `unitPriceMinor × qty`, before any discount. */
  shelfMinor: number;
  /** The line's own discount (DC3). */
  lineDiscountMinor: number;
  /** Own discount + its share of the sale discount (DC4): what `SaleItem.discountMinor` stores. */
  discountMinor: number;
};

export type PricedSale = SaleTotals & { lines: PricedSaleLine[]; shelfMinor: number; discountMinor: number };

/** A discount's amount on `baseMinor`: percent rounded half-up, amount as given. Never more than the base (DC3). */
export function discountOf(discount: Discount | null | undefined, baseMinor: number): number {
  if (!discount) return 0;
  const amount = discount.kind === "AMOUNT" ? discount.amountMinor : percentOfBp(baseMinor, discount.percentBp);
  if (amount > baseMinor) throw discountTooLarge(amount, baseMinor);
  return amount;
}

/**
 * Splits `totalMinor` in proportion to `weights` by largest remainder: floor every share, then
 * one more minor unit to the largest remainders, ties to the earlier index (DC4). Sums exactly.
 */
export function allocate(totalMinor: number, weights: readonly number[]): number[] {
  const whole = weights.reduce((acc, weight) => acc + BigInt(weight), BigInt(0));
  if (whole === BigInt(0)) return weights.map(() => 0);
  const total = BigInt(totalMinor);
  const shares = weights.map((weight) => (total * BigInt(weight)) / whole);
  const order = weights
    .map((weight, index) => ({ index, rem: (total * BigInt(weight)) % whole }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.index - b.index));
  let left = total - shares.reduce((acc, share) => acc + share, BigInt(0));
  for (const { index } of order) {
    if (left === BigInt(0)) break;
    shares[index] += BigInt(1);
    left -= BigInt(1);
  }
  return shares.map(Number);
}

/** Prices a whole sale: line discounts, then the sale discount allocated across lines, then VAT per line (DC3–DC5). */
export function priceSale(
  lines: readonly SaleLineDraft[],
  saleDiscount: Discount | null | undefined,
  rateBp: number,
  pricesIncludeVat: boolean,
): PricedSale {
  const shelf = lines.map((line) => multiply(line.unitPriceMinor, line.qty));
  const own = lines.map((line, index) => discountOf(line.discount, shelf[index]));
  const after = shelf.map((amount, index) => amount - own[index]);
  const shares = allocate(discountOf(saleDiscount, sum(after)), after);
  const priced = lines.map((line, index) => {
    const discountMinor = own[index] + shares[index];
    return {
      ...priceLine(line, rateBp, pricesIncludeVat, discountMinor),
      shelfMinor: shelf[index],
      lineDiscountMinor: own[index],
      discountMinor,
    };
  });
  return {
    ...totalsOf(priced),
    lines: priced,
    shelfMinor: sum(shelf),
    discountMinor: sum(priced.map((line) => line.discountMinor)),
  };
}

/**
 * Whether a limited discounter (`discounts.apply` only) went past `limitBp` (DC8): a line's own
 * discount above its cap, or the sale's whole discount above the larger of the summed line caps
 * and the cap on the sale's shelf total. "N% off" a line or the sale always fits.
 */
export function overDiscountLimit(sale: PricedSale, limitBp: number): boolean {
  const caps = sale.lines.map((line) => percentOfBp(line.shelfMinor, limitBp));
  if (sale.lines.some((line, index) => line.lineDiscountMinor > caps[index])) return true;
  return sale.discountMinor > Math.max(sum(caps), percentOfBp(sale.shelfMinor, limitBp));
}

export type TenderInput = { method: PayMethod; amountMinor: number; reference?: string | null };

export type AppliedPayment = { method: PayMethod; amountMinor: number; reference: string | null };

export type Settlement = { payments: AppliedPayment[]; changeMinor: number };

/**
 * Turns the tender list into the stored payments (D6). Non-cash entries apply in full. Cash
 * applies the remainder of the total, and any tender above that comes back as change. With no
 * cash entry the non-cash entries must cover the total exactly.
 */
export function settlePayments(totalMinor: number, tenders: readonly TenderInput[]): Settlement {
  const nonCash = tenders.filter((tender) => tender.method !== "CASH");
  const cash = tenders.find((tender) => tender.method === "CASH");
  const nonCashTotal = sum(nonCash.map((tender) => tender.amountMinor));

  if (nonCashTotal > totalMinor) throw invalidPayment("Payments exceed the sale total", { nonCashTotal, totalMinor });

  const payments: AppliedPayment[] = nonCash.map((tender) => ({
    method: tender.method,
    amountMinor: tender.amountMinor,
    reference: tender.reference ?? null,
  }));

  const due = totalMinor - nonCashTotal;
  if (!cash) {
    if (due !== 0) throw invalidPayment("Payments do not cover the sale total", { due });
    return { payments, changeMinor: 0 };
  }
  if (due === 0) throw invalidPayment("No cash is due; remove the cash entry", { due });
  if (cash.amountMinor < due) throw invalidPayment("Cash tendered is less than the amount due", { due });
  payments.push({ method: "CASH", amountMinor: due, reference: null });
  return { payments, changeMinor: cash.amountMinor - due };
}
