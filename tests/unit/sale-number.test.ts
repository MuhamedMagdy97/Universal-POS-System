import { describe, expect, it } from "vitest";
import { normalizeSaleNumber } from "@/modules/sales/returns-view";

/** Returns lookup by number: the org series and the offline per-register series (offline till slice 1). */

describe("normalizeSaleNumber", () => {
  it("pads the org series, Arabic-Indic digits and spaces included", () => {
    expect(normalizeSaleNumber("123")).toBe("000123");
    expect(normalizeSaleNumber(" 000123 ")).toBe("000123");
    expect(normalizeSaleNumber("١٢٣")).toBe("000123");
  });

  it("reads an offline number in any case, padded or not", () => {
    expect(normalizeSaleNumber("T1-000045")).toBe("T1-000045");
    expect(normalizeSaleNumber("t1-45")).toBe("T1-000045");
    expect(normalizeSaleNumber(" t12-٤٥ ")).toBe("T12-000045");
  });

  it("refuses anything else", () => {
    for (const raw of ["", "12a", "1234567", "T1-", "T1-1234567", "1T-45", "T1 45", "T1--45", "ABCDEFGHI-1"]) {
      expect(normalizeSaleNumber(raw)).toBeNull();
    }
  });
});
