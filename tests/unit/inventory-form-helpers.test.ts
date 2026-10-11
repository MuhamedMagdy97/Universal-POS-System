import { describe, expect, it } from "vitest";
import {
  adjustReasonsFor,
  directionOf,
  normalizeCount,
  needsNote,
  openingRowsToSave,
  overSourceLines,
  previewAfter,
  safeAction,
  signedDelta,
  transferErrorKey,
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

describe("adjustReasonsFor (archived change)", () => {
  it("offers every reason for an active item", () => {
    expect(adjustReasonsFor(false)).toEqual([
      "DAMAGED",
      "EXPIRED",
      "LOST_OR_STOLEN",
      "COUNT_CORRECTION",
      "FOUND",
      "OTHER",
    ]);
  });

  it("offers only reasons that can remove stock for an archived item", () => {
    expect(adjustReasonsFor(true)).not.toContain("FOUND");
    expect(adjustReasonsFor(true)).toContain("COUNT_CORRECTION");
  });
});

describe("transferErrorKey", () => {
  const error = (reason: string) => ({ code: "CONFLICT" as const, message: "x", details: { reason } });

  it("explains a shortfall at the source", () => {
    expect(transferErrorKey(error("INSUFFICIENT_STOCK"))).toBe("inventory.transfer.overSource");
  });

  it("uses the specific message for other known reasons", () => {
    expect(transferErrorKey(error("SAME_BRANCH"))).toBe("inventory.error.sameBranch");
    expect(transferErrorKey(error("IDEMPOTENCY_CONFLICT"))).toBe("inventory.error.idempotency");
    expect(transferErrorKey(error("ITEM_NOT_SELLABLE"))).toBe("inventory.error.itemNotSellable");
  });
});

describe("safeAction", () => {
  it("passes a result through", async () => {
    await expect(safeAction(async () => ({ ok: true as const, data: 1 }))).resolves.toEqual({ ok: true, data: 1 });
  });

  it("turns a thrown request (network failure) into an error result instead of rejecting", async () => {
    const result = await safeAction<number>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Request failed", details: null } });
  });
});
