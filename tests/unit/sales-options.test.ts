import { describe, expect, it } from "vitest";
import { lineKeyOf, resolveOptions } from "@/modules/sales/options";
import type { OptionGroupView } from "@/modules/catalog/schemas";

/** Options on a sale line (restaurant-cafe-spec R7, R9). Pure, no DB. */

const size: OptionGroupView = {
  id: "g-size",
  name: "Size",
  nameAr: "الحجم",
  minSelect: 1,
  maxSelect: 1,
  choices: [
    { id: "c-reg", name: "Regular", nameAr: null, priceDeltaMinor: 0 },
    { id: "c-lg", name: "Large", nameAr: "كبير", priceDeltaMinor: 500 },
  ],
};
const extras: OptionGroupView = {
  id: "g-extra",
  name: "Extras",
  nameAr: null,
  minSelect: 0,
  maxSelect: 2,
  choices: [
    { id: "c-shot", name: "Extra shot", nameAr: null, priceDeltaMinor: 300 },
    { id: "c-syrup", name: "Syrup", nameAr: null, priceDeltaMinor: 200 },
    { id: "c-cream", name: "Cream", nameAr: null, priceDeltaMinor: 100 },
  ],
};
const coffee = { unitPriceMinor: 3_000, optionGroups: [size, extras] };
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { details?: { reason?: string } }).details?.reason;
  }
  return null;
};

describe("resolveOptions", () => {
  it("adds the chosen prices to the base price and snapshots the choices in group order", () => {
    expect(resolveOptions(coffee, ["c-shot", "c-lg"])).toEqual({
      unitPriceMinor: 3_800,
      snapshot: [
        { group: "Size", groupAr: "الحجم", name: "Large", nameAr: "كبير", priceDeltaMinor: 500 },
        { group: "Extras", groupAr: null, name: "Extra shot", nameAr: null, priceDeltaMinor: 300 },
      ],
    });
  });

  it("keeps an item without options at its price with no snapshot", () => {
    expect(resolveOptions({ unitPriceMinor: 900 }, [])).toEqual({ unitPriceMinor: 900, snapshot: [] });
  });

  it("refuses a missing required group, too many picks, an unknown or repeated choice", () => {
    expect(reason(() => resolveOptions(coffee, []))).toBe("OPTIONS_INVALID");
    expect(reason(() => resolveOptions(coffee, ["c-reg", "c-shot", "c-syrup", "c-cream"]))).toBe("OPTIONS_INVALID");
    expect(reason(() => resolveOptions(coffee, ["c-reg", "c-lg"]))).toBe("OPTIONS_INVALID");
    expect(reason(() => resolveOptions(coffee, ["c-reg", "nope"]))).toBe("OPTIONS_INVALID");
    expect(reason(() => resolveOptions(coffee, ["c-reg", "c-shot", "c-shot"]))).toBe("OPTIONS_INVALID");
    expect(reason(() => resolveOptions({ unitPriceMinor: 900 }, ["c-reg"]))).toBe("OPTIONS_INVALID");
  });
});

describe("lineKeyOf", () => {
  const ref = { productId: "p", variantId: null };
  it("is the same for the same options in any order, and differs by options or note", () => {
    expect(lineKeyOf(ref, ["b", "a"], null)).toBe(lineKeyOf(ref, ["a", "b"], null));
    expect(lineKeyOf(ref, ["a"], null)).not.toBe(lineKeyOf(ref, [], null));
    expect(lineKeyOf(ref, [], "no onions")).not.toBe(lineKeyOf(ref, [], null));
    expect(lineKeyOf(ref, [], null)).toBe("p|");
  });
});

describe("lineKeyOf with staff (salon-spec S4)", () => {
  const ref = { productId: "p", variantId: null };
  it("keeps one item done by two staff members apart, and is unchanged without staff", () => {
    expect(lineKeyOf(ref, [], null, "sara")).not.toBe(lineKeyOf(ref, [], null, "omar"));
    expect(lineKeyOf(ref, [], null, null)).toBe("p|");
    expect(lineKeyOf(ref, ["a"], "x", "sara")).toBe("p||o:a|n:x|s:sara");
  });
});
