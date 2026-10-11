import { MAX_STORABLE_MINOR, multiply, sum, vatInGross, vatOnNet } from "@/lib/money";
import { amountTooLarge, invalidPayment } from "./errors";

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

/** One line's VAT and totals. Zero-rated and exempt items (`vatApplicable` false) carry no VAT. */
export function priceLine(item: PricedInput, rateBp: number, pricesIncludeVat: boolean): PricedLine {
  const effectiveRate = item.vatApplicable ? rateBp : 0;
  if (pricesIncludeVat) {
    const gross = multiply(item.unitPriceMinor, item.qty);
    const vat = vatInGross(gross, effectiveRate);
    return { netMinor: gross - vat, vatRateBp: effectiveRate, vatMinor: vat, lineTotalMinor: storable(gross, "line") };
  }
  const net = multiply(item.unitPriceMinor, item.qty);
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
