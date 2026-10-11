import { describe, expect, it } from "vitest";
import {
  MoneyError,
  assertStorable,
  divideRoundHalfUp,
  formatMoney,
  multiply,
  parseMajor,
  percentOfBp,
  sum,
  toMajorString,
  vatInGross,
  vatOnNet,
} from "@/lib/money";

describe("integer minor units", () => {
  it("rejects non-integer amounts instead of rounding them", () => {
    expect(() => sum([100, 0.5])).toThrow(MoneyError);
    expect(() => multiply(199.99, 2)).toThrow(MoneyError);
    expect(() => vatOnNet(Number.NaN, 1400)).toThrow(MoneyError);
  });

  it("sums without float drift", () => {
    // 0.1 + 0.2 style inputs expressed in minor units stay exact.
    expect(sum([10, 20])).toBe(30);
    expect(sum([])).toBe(0);
  });

  it("multiplies unit price by quantity exactly", () => {
    expect(multiply(1999, 3)).toBe(5997);
  });

  it("refuses values that do not fit the integer column", () => {
    expect(() => assertStorable(2_147_483_648)).toThrow(MoneyError);
    expect(() => assertStorable(2_147_483_647)).not.toThrow();
  });

  it("detects overflow beyond the safe integer range", () => {
    expect(() => multiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(MoneyError);
  });
});

describe("rounding", () => {
  it("rounds half away from zero", () => {
    expect(divideRoundHalfUp(BigInt(5), BigInt(10))).toBe(BigInt(1));
    expect(divideRoundHalfUp(BigInt(4), BigInt(10))).toBe(BigInt(0));
    expect(divideRoundHalfUp(BigInt(-5), BigInt(10))).toBe(BigInt(-1));
    expect(divideRoundHalfUp(BigInt(15), BigInt(10))).toBe(BigInt(2));
  });

  it("computes basis-point percentages", () => {
    expect(percentOfBp(10_000, 1400)).toBe(1400);
    expect(percentOfBp(1, 5000)).toBe(1); // 0.5 → 1
    expect(percentOfBp(1, 4999)).toBe(0); // 0.4999 → 0
  });

  it("rejects rates outside 0–100%", () => {
    expect(() => percentOfBp(100, -1)).toThrow(MoneyError);
    expect(() => percentOfBp(100, 10_001)).toThrow(MoneyError);
    expect(() => percentOfBp(100, 14.5)).toThrow(MoneyError);
  });
});

// Parameterised across both markets (risk 2: dual VAT/currency matrix).
describe.each([
  { currency: "EGP" as const, rateBp: 1400 },
  { currency: "SAR" as const, rateBp: 1500 },
])("VAT for $currency at $rateBp bp", ({ currency, rateBp }) => {
  it("adds VAT on a net line", () => {
    expect(vatOnNet(10_000, rateBp)).toBe(rateBp);
  });

  it("extracts VAT from a gross line so net + vat = gross", () => {
    for (const gross of [1, 99, 100, 1_150, 11_400, 123_456, 999_999]) {
      const vat = vatInGross(gross, rateBp);
      expect(Number.isInteger(vat)).toBe(true);
      expect(vat).toBeGreaterThanOrEqual(0);
      expect(gross - vat + vat).toBe(gross);
      // VAT recomputed on the net must land within one minor unit of the extracted VAT.
      expect(Math.abs(vatOnNet(gross - vat, rateBp) - vat)).toBeLessThanOrEqual(1);
    }
  });

  it("round-trips decimal strings", () => {
    expect(parseMajor("12.50", currency)).toBe(1250);
    expect(parseMajor("0.05", currency)).toBe(5);
    expect(parseMajor("7", currency)).toBe(700);
    expect(parseMajor("-3.1", currency)).toBe(-310);
    expect(toMajorString(1250, currency)).toBe("12.50");
    expect(toMajorString(5, currency)).toBe("0.05");
    expect(toMajorString(-310, currency)).toBe("-3.10");
  });

  it("rejects malformed or over-precise input", () => {
    expect(() => parseMajor("12.505", currency)).toThrow(MoneyError);
    expect(() => parseMajor("1e3", currency)).toThrow(MoneyError);
    expect(() => parseMajor("abc", currency)).toThrow(MoneyError);
    expect(() => parseMajor("", currency)).toThrow(MoneyError);
  });

  it("formats for display without float rounding", () => {
    expect(formatMoney(123_456_789, currency, "en")).toContain("1,234,567.89");
  });
});

describe("known sale example (EG, 14%)", () => {
  it("rounds VAT per line, then sums", () => {
    const lines = [
      { unit: 333, qty: 1 }, // 3.33 → VAT 0.4662 → 0.47
      { unit: 333, qty: 1 },
      { unit: 333, qty: 1 },
    ];
    const vatPerLine = lines.map((line) => vatOnNet(multiply(line.unit, line.qty), 1400));
    expect(vatPerLine).toEqual([47, 47, 47]);
    expect(sum(vatPerLine)).toBe(141); // per-line rounding, not 999 × 14% = 139.86 → 140
  });
});
