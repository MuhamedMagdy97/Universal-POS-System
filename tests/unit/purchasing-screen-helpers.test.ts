import { describe, expect, it } from "vitest";
import {
  editorTotal,
  errorKey,
  linesToSubmit,
  parseCost,
  parseQty,
  receiptLines,
  returnLines,
  type EditorLine,
} from "@/app/(app)/purchasing/_lib/purchasing";

const line = (qty: string, cost: string): EditorLine => ({
  productId: "p",
  variantId: null,
  name: "Item",
  sku: "SKU",
  qty,
  cost,
});

describe("parseCost and parseQty", () => {
  it("reads major units, Arabic digits included, and refuses junk and negatives", () => {
    expect(parseCost("12.5", "EGP")).toBe(1250);
    expect(parseCost("١٢٫٥", "EGP") ?? parseCost("١٢.٥", "EGP")).toBe(1250);
    expect(parseCost("0", "EGP")).toBe(0);
    expect(parseCost("", "EGP")).toBeNull();
    expect(parseCost("-1", "EGP")).toBeNull();
    expect(parseCost("1.234", "EGP")).toBeNull();
    expect(parseCost("abc", "EGP")).toBeNull();
  });

  it("reads whole quantities including zero", () => {
    expect(parseQty("0")).toBe(0);
    expect(parseQty("٣")).toBe(3);
    expect(parseQty("1.5")).toBeNull();
    expect(parseQty("2000000")).toBeNull();
  });
});

describe("editor lines", () => {
  it("needs a quantity of at least 1 and a cost on every line", () => {
    expect(linesToSubmit([line("2", "1.50")], "EGP")).toEqual([
      { ref: { productId: "p", variantId: null }, qty: 2, unitCostMinor: 150 },
    ]);
    expect(linesToSubmit([line("0", "1")], "EGP")).toBeNull();
    expect(linesToSubmit([line("1", "")], "EGP")).toBeNull();
    expect(editorTotal([line("2", "1.50"), line("3", "10")], "EGP")).toBe(3300);
    expect(editorTotal([line("2", "")], "EGP")).toBeNull();
  });
});

describe("receiptLines", () => {
  const row = { poItemId: "a", outstanding: 4, qty: "2", cost: "1.00", poCostMinor: 100 };

  it("skips zero rows and sends a cost only when it differs from the PO", () => {
    expect(receiptLines([row, { ...row, poItemId: "b", qty: "0" }], "EGP")).toEqual([{ poItemId: "a", qty: 2 }]);
    expect(receiptLines([{ ...row, cost: "1.10" }], "EGP")).toEqual([{ poItemId: "a", qty: 2, unitCostMinor: 110 }]);
  });

  it("refuses more than outstanding or a bad cost", () => {
    expect(receiptLines([{ ...row, qty: "5" }], "EGP")).toBeNull();
    expect(receiptLines([{ ...row, cost: "x" }], "EGP")).toBeNull();
  });
});

describe("errorKey", () => {
  it("prefers the specific reason, then the status class", () => {
    expect(errorKey({ code: "CONFLICT", message: "", details: { reason: "QTY_EXCEEDS_OUTSTANDING" } })).toBe(
      "purchasing.error.QTY_EXCEEDS_OUTSTANDING",
    );
    expect(errorKey({ code: "IDEMPOTENCY_CONFLICT", message: "", details: { reason: "IDEMPOTENCY_CONFLICT" } })).toBe(
      "purchasing.error.IDEMPOTENCY_CONFLICT",
    );
    expect(errorKey({ code: "NOT_FOUND", message: "", details: null })).toBe("purchasing.error.notFound");
    expect(errorKey({ code: "INTERNAL", message: "", details: null })).toBe("purchasing.error.generic");
  });
});

describe("returnLines", () => {
  it("skips zeros and refuses a bad or too-large quantity", () => {
    const rows = [
      { poItemId: "a", returnable: 3, qty: "2" },
      { poItemId: "b", returnable: 1, qty: "0" },
    ];
    expect(returnLines(rows)).toEqual([{ poItemId: "a", qty: 2 }]);
    expect(returnLines([{ poItemId: "a", returnable: 3, qty: "4" }])).toBeNull();
    expect(returnLines([{ poItemId: "a", returnable: 3, qty: "x" }])).toBeNull();
    expect(returnLines([{ poItemId: "a", returnable: 3, qty: "٢" }])).toEqual([{ poItemId: "a", qty: 2 }]);
  });

  it("maps return errors to their messages", () => {
    expect(errorKey({ code: "CONFLICT", message: "", details: { reason: "QTY_EXCEEDS_RETURNABLE" } })).toBe(
      "purchasing.error.QTY_EXCEEDS_RETURNABLE",
    );
    expect(errorKey({ code: "CONFLICT", message: "", details: { reason: "INSUFFICIENT_STOCK" } })).toBe(
      "purchasing.error.INSUFFICIENT_STOCK",
    );
  });
});
