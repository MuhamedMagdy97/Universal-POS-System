import { describe, expect, it } from "vitest";
import { formatMarginBp, marginBp, REPORT_COLUMNS, totalledKeys } from "@/modules/reports/columns";

describe("marginBp (P12 M5)", () => {
  it("is profit over revenue with cost in basis points, rounded half up", () => {
    expect(marginBp(11_000, 30_000)).toBe(3_667);
    expect(marginBp(1, 3)).toBe(3_333);
    expect(marginBp(1, 8)).toBe(1_250);
    expect(marginBp(-500, 10_000)).toBe(-500);
    expect(marginBp(-1, 3)).toBe(-3_333);
  });

  it("is null when there is no positive revenue to divide by", () => {
    expect(marginBp(0, 0)).toBeNull();
    expect(marginBp(-4_000, -10_000)).toBeNull();
  });
});

describe("formatMarginBp", () => {
  it("shows one decimal, half away from zero", () => {
    expect(formatMarginBp(3_667)).toBe("36.7%");
    expect(formatMarginBp(3_676)).toBe("36.8%");
    expect(formatMarginBp(2_345)).toBe("23.5%");
    expect(formatMarginBp(0)).toBe("0.0%");
    expect(formatMarginBp(10_000)).toBe("100.0%");
    expect(formatMarginBp(-500)).toBe("-5.0%");
    expect(formatMarginBp(-4)).toBe("0.0%");
    expect(formatMarginBp(-5)).toBe("-0.1%");
  });
});

describe("profit columns", () => {
  it("totals money and counts but never the margin", () => {
    for (const report of ["profit-products", "profit-categories", "profit-days"] as const) {
      expect(REPORT_COLUMNS[report].some((c) => c.key === "marginBp")).toBe(true);
      expect(totalledKeys(report)).not.toContain("marginBp");
      expect(totalledKeys(report)).toEqual(
        expect.arrayContaining(["netRevenueMinor", "revenueNoCostMinor", "costMinor", "grossProfitMinor"]),
      );
    }
    expect(totalledKeys("profit-days")).toContain("linesNoCost");
  });
});
