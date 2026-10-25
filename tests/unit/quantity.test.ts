import { describe, expect, it } from "vitest";
import { formatQty, lineMinor, parseQtyInput, qtyInputValue } from "@/lib/quantity";

/** Weighed selling (weighed-selling-spec W1, W3, W7): grams for KG, one money rule, kg on screen. */

describe("lineMinor", () => {
  it("prices a weight per kg, half up", () => {
    expect(lineMinor(12_000, 750, "KG")).toBe(9_000);
    expect(lineMinor(1, 500, "KG")).toBe(1);
    expect(lineMinor(1, 499, "KG")).toBe(0);
    expect(lineMinor(12_000, 1, "KG")).toBe(12);
    expect(lineMinor(99_999_999, 1_000_000, "KG")).toBe(99_999_999_000);
  });

  it("multiplies pieces as before", () => {
    expect(lineMinor(150, 3, "EACH")).toBe(450);
  });
});

describe("parseQtyInput", () => {
  it("reads kg with up to 3 decimals into grams, in Latin or Arabic digits", () => {
    for (const raw of ["0.750", "0,750", "٠٫٧٥٠", ".75", " 0.75 "]) expect(parseQtyInput(raw, "KG"), raw).toBe(750);
    expect(parseQtyInput("12", "KG")).toBe(12_000);
    expect(parseQtyInput("1000", "KG")).toBe(1_000_000);
  });

  it("refuses more than 3 decimals, zero, over 1,000 kg and text", () => {
    for (const raw of ["0.7505", "0", "0.000", "1000.001", "abc", "", "-1", "1.2.3"]) {
      expect(parseQtyInput(raw, "KG"), raw).toBeNull();
    }
  });

  it("keeps whole pieces for EACH", () => {
    expect(parseQtyInput("3", "EACH")).toBe(3);
    expect(parseQtyInput("١٢", "EACH")).toBe(12);
    expect(parseQtyInput("1.5", "EACH")).toBeNull();
  });
});

describe("formatQty", () => {
  it("shows kg with 3 decimals and pieces as they are", () => {
    expect(formatQty(750, "KG", "en")).toBe("0.750 kg");
    expect(formatQty(1_500, "KG", "ar")).toBe("1.500 كجم");
    expect(formatQty(3, "EACH", "en")).toBe("3");
    expect(qtyInputValue(750, "KG")).toBe("0.750");
    expect(qtyInputValue(3, "EACH")).toBe("3");
  });
});
