import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { parsePercentBp } from "@/lib/money";
import { allocate, discountOf, overDiscountLimit, priceSale } from "@/modules/sales/totals";

/** Discount math (docs/planning/discounts/discounts-spec.md DC3–DC8). Pure, no DB. */

const line = (unitPriceMinor: number, qty = 1, vatApplicable = true) => ({ unitPriceMinor, qty, vatApplicable });

describe("discountOf", () => {
  it("rounds a percent half up and takes an amount as given", () => {
    expect(discountOf({ kind: "PERCENT", percentBp: 1000 }, 1005)).toBe(101); // 100.5 → 101
    expect(discountOf({ kind: "PERCENT", percentBp: 1250 }, 1000)).toBe(125);
    expect(discountOf({ kind: "AMOUNT", amountMinor: 300 }, 1000)).toBe(300);
    expect(discountOf(null, 1000)).toBe(0);
  });

  it("allows 100% but refuses more than the base", () => {
    expect(discountOf({ kind: "AMOUNT", amountMinor: 1000 }, 1000)).toBe(1000);
    expect(() => discountOf({ kind: "AMOUNT", amountMinor: 1001 }, 1000)).toThrow(AppError);
  });
});

describe("allocate (largest remainder)", () => {
  it("always sums to the total", () => {
    for (const [total, weights] of [
      [100, [1, 1, 1]],
      [7, [300, 200, 500]],
      [1, [5, 5]],
      [999, [1, 2, 3, 4, 5, 6, 7]],
    ] as const) {
      const shares = allocate(total, weights);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("gives leftovers to the largest remainders, ties to the earlier line", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    // 10 over 3:3:4 → 3, 3, 4 exactly.
    expect(allocate(10, [3, 3, 4])).toEqual([3, 3, 4]);
    // 5 over 1:1:2 → 1.25, 1.25, 2.5 → floors 1,1,2; one left to the .5 remainder.
    expect(allocate(5, [1, 1, 2])).toEqual([1, 1, 3]);
  });

  it("skips zero-weight lines and handles an all-zero sale", () => {
    expect(allocate(10, [0, 5, 5])).toEqual([0, 5, 5]);
    expect(allocate(0, [0, 0])).toEqual([0, 0]);
  });
});

describe("priceSale", () => {
  it("prices an undiscounted sale exactly as before", () => {
    const sale = priceSale([line(1000, 2), line(500)], null, 1400, true);
    expect(sale).toMatchObject({ discountMinor: 0, totalMinor: 2500, shelfMinor: 2500 });
    expect(sale.subtotalMinor + sale.vatMinor).toBe(2500);
  });

  it("takes VAT out of the discounted gross (prices include VAT)", () => {
    const sale = priceSale([{ ...line(1140), discount: { kind: "PERCENT", percentBp: 1000 } }], null, 1400, true);
    // 1140 − 114 = 1026 gross; net = round(1026 / 1.14) = 900, VAT 126.
    expect(sale.lines[0]).toMatchObject({ discountMinor: 114, lineTotalMinor: 1026, netMinor: 900, vatMinor: 126 });
    expect(sale).toMatchObject({ discountMinor: 114, subtotalMinor: 900, vatMinor: 126, totalMinor: 1026 });
  });

  it("adds VAT on the discounted net (prices exclude VAT)", () => {
    const sale = priceSale([{ ...line(1000), discount: { kind: "AMOUNT", amountMinor: 100 } }], null, 1500, false);
    // 900 net + 135 VAT.
    expect(sale.lines[0]).toMatchObject({ netMinor: 900, vatMinor: 135, lineTotalMinor: 1035 });
    expect(sale.totalMinor).toBe(1035);
  });

  it("applies line discounts first, then the sale discount on what is left, allocated by largest remainder", () => {
    const sale = priceSale(
      [{ ...line(1000, 2), discount: { kind: "PERCENT", percentBp: 1000 } }, line(1000), line(1000, 1, false)],
      { kind: "PERCENT", percentBp: 500 },
      1400,
      true,
    );
    // After lines: 1800, 1000, 1000 = 3800; 5% = 190 → 90, 50, 50.
    expect(sale.lines.map((l) => l.lineDiscountMinor)).toEqual([200, 0, 0]);
    expect(sale.lines.map((l) => l.discountMinor)).toEqual([290, 50, 50]);
    expect(sale.lines.map((l) => l.lineTotalMinor)).toEqual([1710, 950, 950]);
    expect(sale.lines[2].vatMinor).toBe(0); // zero-rated stays VAT-free
    expect(sale.discountMinor).toBe(390);
    expect(sale.totalMinor).toBe(3610);
    expect(sale.totalMinor).toBe(sale.subtotalMinor + sale.vatMinor);
    expect(sale.totalMinor + sale.discountMinor).toBe(sale.shelfMinor);
  });

  it("allows a free sale (100%) and refuses a sale discount over the total", () => {
    expect(priceSale([line(999, 3)], { kind: "PERCENT", percentBp: 10_000 }, 1400, true).totalMinor).toBe(0);
    expect(() => priceSale([line(1000)], { kind: "AMOUNT", amountMinor: 1001 }, 1400, true)).toThrow(AppError);
  });

  it("keeps every line's paid amount and VAT non-negative", () => {
    const sale = priceSale([line(1), line(1), line(1)], { kind: "AMOUNT", amountMinor: 2 }, 1400, true);
    expect(sale.lines.map((l) => l.lineTotalMinor)).toEqual([0, 0, 1]);
    expect(sale.lines.every((l) => l.vatMinor >= 0 && l.netMinor >= 0)).toBe(true);
  });
});

describe("overDiscountLimit (cashier cap, DC8)", () => {
  const percent = (percentBp: number) => ({ kind: "PERCENT" as const, percentBp });

  it("lets N% off any line or the whole sale through, even on tiny amounts", () => {
    expect(overDiscountLimit(priceSale([{ ...line(5), discount: percent(1000) }], null, 1400, true), 1000)).toBe(false);
    expect(overDiscountLimit(priceSale([line(4), line(4), line(4)], percent(1000), 1400, true), 1000)).toBe(false);
    expect(overDiscountLimit(priceSale([line(5), line(5), line(5)], percent(1000), 1400, true), 1000)).toBe(false);
  });

  it("refuses a bigger line discount, or line and sale discounts stacked past the limit", () => {
    expect(overDiscountLimit(priceSale([{ ...line(1000), discount: percent(1100) }], null, 1400, true), 1000)).toBe(
      true,
    );
    const stacked = priceSale([{ ...line(1000), discount: percent(1000) }, line(1000)], percent(1000), 1400, true);
    expect(overDiscountLimit(stacked, 1000)).toBe(true);
    // 100% off one cheap line is under 10% of the sale but far past 10% of that line: refused.
    const oneFree = priceSale([{ ...line(100), discount: percent(10_000) }, line(10_000)], null, 1400, true);
    expect(overDiscountLimit(oneFree, 1000)).toBe(true);
  });

  it("lets nothing through at a 0% limit", () => {
    expect(overDiscountLimit(priceSale([line(1000)], { kind: "AMOUNT", amountMinor: 1 }, 1400, true), 0)).toBe(true);
  });
});

describe("parsePercentBp", () => {
  it("reads up to two decimals and at most 100%", () => {
    expect(parsePercentBp("10")).toBe(1000);
    expect(parsePercentBp("12.5")).toBe(1250);
    expect(parsePercentBp("0.01")).toBe(1);
    expect(parsePercentBp("١٠٠")).toBe(10_000);
    expect(parsePercentBp("100.01")).toBeNull();
    expect(parsePercentBp("1.234")).toBeNull();
    expect(parsePercentBp("")).toBeNull();
  });
});
