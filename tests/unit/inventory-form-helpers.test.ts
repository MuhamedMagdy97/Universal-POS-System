import { describe, expect, it } from "vitest";
import {
  directionOf,
  normalizeCount,
  needsNote,
  openingRowsToSave,
  overSourceLines,
  previewAfter,
  signedDelta,
} from "@/app/(app)/inventory/_lib/form";

const ref = (productId: string) => ({ productId, variantId: null });

describe("directionOf (D2)", () => {
  it.each([
    ["DAMAGED", "down"],
    ["EXPIRED", "down"],
    ["LOST_OR_STOLEN", "down"],
    ["FOUND", "up"],
    ["COUNT_CORRECTION", "either"],
    ["OTHER", "either"],
  ] as const)("%s goes %s", (reason, direction) => {
    expect(directionOf(reason)).toBe(direction);
  });
});

describe("signedDelta", () => {
  it("removes stock for a decrease reason and adds for an increase reason", () => {
    expect(signedDelta({ reason: "DAMAGED", qty: 2, sign: "+" })).toBe(-2);
    expect(signedDelta({ reason: "FOUND", qty: 3, sign: "-" })).toBe(3);
  });

  it("uses the chosen sign only for reasons that allow both directions", () => {
    expect(signedDelta({ reason: "OTHER", qty: 4, sign: "-" })).toBe(-4);
    expect(signedDelta({ reason: "COUNT_CORRECTION", qty: 4, sign: "+" })).toBe(4);
  });
});

describe("previewAfter", () => {
  it("shows the balance after the change, including a negative result", () => {
    expect(previewAfter(12, -3)).toBe(9);
    expect(previewAfter(1, -2)).toBe(-1);
  });
});

describe("needsNote", () => {
  it("requires a note only for OTHER", () => {
    expect(needsNote("OTHER")).toBe(true);
    expect(needsNote("DAMAGED")).toBe(false);
  });
});

describe("overSourceLines", () => {
  it("returns the lines that ask for more than the source has", () => {
    const lines = [
      { ref: ref("a"), qty: 5 },
      { ref: ref("b"), qty: 1 },
    ];
    const onHand = new Map([
      ["a", 3],
      ["b", 4],
    ]);
    expect(overSourceLines(lines, (r) => onHand.get(r.productId) ?? 0)).toEqual([{ ref: ref("a"), qty: 5, onHand: 3 }]);
  });
});

describe("normalizeCount (counted quantity, 0 allowed)", () => {
  it("reads zero and Arabic-Indic digits, and rejects blanks and non-integers", () => {
    expect(normalizeCount("0")).toBe(0);
    expect(normalizeCount("٤")).toBe(4);
    expect(normalizeCount("")).toBeNull();
    expect(normalizeCount("2.5")).toBeNull();
    expect(normalizeCount("-1")).toBeNull();
  });
});

describe("openingRowsToSave", () => {
  it("skips blank rows and reads Arabic-Indic quantities", () => {
    const rows = [
      { ref: ref("a"), raw: "٣٥" },
      { ref: ref("b"), raw: "" },
    ];
    expect(openingRowsToSave(rows)).toEqual({ lines: [{ ref: ref("a"), qty: 35 }], invalid: [] });
  });

  it("reports rows whose quantity is not a whole number from 1", () => {
    const rows = [
      { ref: ref("a"), raw: "1.5" },
      { ref: ref("b"), raw: "0" },
    ];
    expect(openingRowsToSave(rows)).toEqual({ lines: [], invalid: [ref("a"), ref("b")] });
  });
});
