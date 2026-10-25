import { describe, expect, it } from "vitest";
import { priceLine, settlePayments, shelfOf, totalsOf } from "@/modules/sales/totals";

/** Checkout pricing and payment rules (checkout-data-model-and-api.md §2–§3). Pure, no DB. */

describe("priceLine (VAT-inclusive shelf prices, default)", () => {
  it("extracts VAT from the gross line at 14%", () => {
    // 1000 gross at 14%: net = round(1000 / 1.14) = 877, VAT = 123.
    expect(priceLine({ unitPriceMinor: 1000, qty: 1, vatApplicable: true }, 1400, true)).toEqual({
      netMinor: 877,
      vatRateBp: 1400,
      vatMinor: 123,
      lineTotalMinor: 1000,
    });
  });

  it("rounds half up per line, then the sale sums the lines", () => {
    const line = priceLine({ unitPriceMinor: 1000, qty: 3, vatApplicable: true }, 1400, true);
    expect(line.lineTotalMinor).toBe(3000);
    expect(line.netMinor + line.vatMinor).toBe(3000);
  });

  it("gives zero-rated items no VAT", () => {
    const line = priceLine({ unitPriceMinor: 1000, qty: 2, vatApplicable: false }, 1400, true);
    expect(line).toEqual({ netMinor: 2000, vatRateBp: 0, vatMinor: 0, lineTotalMinor: 2000 });
  });
});

describe("priceLine (VAT-exclusive prices)", () => {
  it("adds VAT on top of the net line", () => {
    expect(priceLine({ unitPriceMinor: 1000, qty: 1, vatApplicable: true }, 1500, false)).toEqual({
      netMinor: 1000,
      vatRateBp: 1500,
      vatMinor: 150,
      lineTotalMinor: 1150,
    });
  });
});

describe("totalsOf", () => {
  it("sums net, VAT and total across lines", () => {
    const lines = [
      priceLine({ unitPriceMinor: 1000, qty: 1, vatApplicable: true }, 1400, true),
      priceLine({ unitPriceMinor: 500, qty: 2, vatApplicable: false }, 1400, true),
    ];
    expect(totalsOf(lines)).toEqual({ subtotalMinor: 877 + 1000, vatMinor: 123, totalMinor: 2000 });
  });
});

describe("settlePayments", () => {
  it("accepts an exact single-method payment with no change", () => {
    expect(settlePayments(1000, [{ method: "CARD_MANUAL", amountMinor: 1000, reference: "SLIP-1" }])).toEqual({
      payments: [{ method: "CARD_MANUAL", amountMinor: 1000, reference: "SLIP-1" }],
      changeMinor: 0,
    });
  });

  it("applies cash up to the due amount and returns the change", () => {
    expect(settlePayments(1000, [{ method: "CASH", amountMinor: 1500 }])).toEqual({
      payments: [{ method: "CASH", amountMinor: 1000, reference: null }],
      changeMinor: 500,
    });
  });

  it("splits a sale between a card and cash", () => {
    expect(
      settlePayments(1000, [
        { method: "CARD_MANUAL", amountMinor: 400 },
        { method: "CASH", amountMinor: 700 },
      ]),
    ).toEqual({
      payments: [
        { method: "CARD_MANUAL", amountMinor: 400, reference: null },
        { method: "CASH", amountMinor: 600, reference: null },
      ],
      changeMinor: 100,
    });
  });

  it("rejects a non-cash payment that does not cover the total", () => {
    expect(() => settlePayments(1000, [{ method: "WALLET", amountMinor: 900 }])).toThrow(/do not cover/);
  });

  it("rejects cash that is less than the amount due", () => {
    expect(() => settlePayments(1000, [{ method: "CASH", amountMinor: 999 }])).toThrow(/less than the amount due/);
  });

  it("rejects non-cash payments above the total", () => {
    expect(() => settlePayments(1000, [{ method: "CARD_MANUAL", amountMinor: 1001 }])).toThrow(/exceed/);
  });

  it("rejects a cash entry when nothing is left to pay in cash", () => {
    expect(() =>
      settlePayments(1000, [
        { method: "CARD_MANUAL", amountMinor: 1000 },
        { method: "CASH", amountMinor: 50 },
      ]),
    ).toThrow(/No cash is due/);
  });
});

describe("edge amounts", () => {
  it("settles a zero-total sale with no payments", () => {
    expect(settlePayments(0, [])).toEqual({ payments: [], changeMinor: 0 });
  });

  it("refuses a zero-total sale with a payment entry", () => {
    expect(() => settlePayments(0, [{ method: "CARD_MANUAL", amountMinor: 1 }])).toThrow(/exceed/);
  });

  it("refuses a line whose total does not fit the money columns", () => {
    // 300 × 10,000,000 = 3,000,000,000 > 2,147,483,647.
    expect(() => priceLine({ unitPriceMinor: 10_000_000, qty: 300, vatApplicable: true }, 1400, true)).toThrow(
      /too large/,
    );
  });

  it("refuses a sale whose total does not fit, even when each line does", () => {
    const line = priceLine({ unitPriceMinor: 1_000_000_000, qty: 1, vatApplicable: false }, 1400, true);
    expect(() => totalsOf([line, line, line])).toThrow(/too large/);
  });
});

describe("shelfOf with price scale labels (weighed-selling-spec W6)", () => {
  // EGP 123.45 per kg: half a gram's worth rounds up to 7 minor units.
  const kg = { unitPriceMinor: 12_345, vatApplicable: true, unitType: "KG" as const };
  const reason = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as { details?: { reason?: string } }).details?.reason;
    }
    return null;
  };

  it("keeps each printed total when it is within half a gram's worth of price × grams", () => {
    // 812 g → 10,024.14; the scale printed 10,020 for its own weighing.
    const labels = [
      { grams: 812, totalMinor: 10_020 },
      { grams: 500, totalMinor: 6_173 },
    ];
    expect(shelfOf({ ...kg, qty: 1_312, labels })).toBe(16_193);
  });

  it("refuses a label off by more, one on a piece item, or grams that do not add up", () => {
    expect(reason(() => shelfOf({ ...kg, qty: 812, labels: [{ grams: 812, totalMinor: 10_016 }] }))).toBe(
      "LABEL_MISMATCH",
    );
    expect(
      reason(() => shelfOf({ ...kg, unitType: "EACH", qty: 812, labels: [{ grams: 812, totalMinor: 10_024 }] })),
    ).toBe("LABEL_MISMATCH");
    expect(reason(() => shelfOf({ ...kg, qty: 900, labels: [{ grams: 812, totalMinor: 10_024 }] }))).toBe(
      "LABEL_MISMATCH",
    );
  });
});
