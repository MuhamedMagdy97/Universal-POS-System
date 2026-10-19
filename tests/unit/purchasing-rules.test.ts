import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canCancel,
  canClose,
  canEdit,
  canOrder,
  canReceive,
  formatPoNumber,
  formatReturnNumber,
  mergePoLines,
  outstanding,
  poTotals,
  returnable,
  statusAfterReceipt,
} from "@/modules/purchasing/rules";
import { PoInput, ReceiptInput, ReturnInput, SupplierInput } from "@/modules/purchasing/schemas";

const P = randomUUID();
const V = randomUUID();

describe("formatPoNumber (P7)", () => {
  it("pads to six digits and grows past them", () => {
    expect(formatPoNumber(1)).toBe("PO-000001");
    expect(formatPoNumber(1234567)).toBe("PO-1234567");
  });
});

describe("mergePoLines (P8)", () => {
  it("merges the same item, adds quantities and keeps the later cost", () => {
    const merged = mergePoLines([
      { ref: { productId: P, variantId: null }, qty: 2, unitCostMinor: 100 },
      { ref: { productId: P, variantId: V }, qty: 1, unitCostMinor: 50 },
      { ref: { productId: P, variantId: null }, qty: 3, unitCostMinor: 120 },
    ]);
    expect(merged).toEqual([
      { ref: { productId: P, variantId: null }, qty: 5, unitCostMinor: 120 },
      { ref: { productId: P, variantId: V }, qty: 1, unitCostMinor: 50 },
    ]);
  });
});

describe("receipt status", () => {
  it("is RECEIVED only when every line is full", () => {
    expect(
      statusAfterReceipt([
        { qtyOrdered: 2, qtyReceived: 2 },
        { qtyOrdered: 3, qtyReceived: 1 },
      ]),
    ).toBe("PARTIALLY_RECEIVED");
    expect(statusAfterReceipt([{ qtyOrdered: 2, qtyReceived: 2 }])).toBe("RECEIVED");
    expect(outstanding({ qtyOrdered: 5, qtyReceived: 2 })).toBe(3);
  });
});

describe("transitions (P3, P4)", () => {
  const draft = { status: "DRAFT", receivedUnits: 0 } as const;
  const ordered = { status: "ORDERED", receivedUnits: 0 } as const;
  const partial = { status: "PARTIALLY_RECEIVED", receivedUnits: 1 } as const;
  const received = { status: "RECEIVED", receivedUnits: 4 } as const;
  const cancelled = { status: "CANCELLED", receivedUnits: 0 } as const;

  it("edits and cancels only before anything is received", () => {
    expect([draft, ordered, partial, received, cancelled].map(canEdit)).toEqual([true, true, false, false, false]);
    expect([draft, ordered, partial, received, cancelled].map(canCancel)).toEqual([true, true, false, false, false]);
  });

  it("orders drafts, receives ordered POs and closes partial ones", () => {
    expect([draft, ordered, partial].map(canOrder)).toEqual([true, false, false]);
    expect([draft, ordered, partial, received, cancelled].map(canReceive)).toEqual([false, true, true, false, false]);
    expect([ordered, partial, received].map(canClose)).toEqual([false, true, false]);
  });
});

describe("poTotals (P13)", () => {
  it("sums units and value in integers", () => {
    expect(
      poTotals([
        { qtyOrdered: 3, qtyReceived: 1, unitCostMinor: 1250 },
        { qtyOrdered: 2, qtyReceived: 2, unitCostMinor: 99 },
      ]),
    ).toEqual({ lineCount: 2, orderedUnits: 5, receivedUnits: 3, totalMinor: 3948 });
  });
});

describe("schemas", () => {
  const line = { ref: { productId: P }, qty: 1, unitCostMinor: 0 };

  it("needs 1 to 200 lines and refuses unknown keys", () => {
    const base = { branchId: randomUUID(), supplierId: randomUUID() };
    expect(PoInput.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(PoInput.safeParse({ ...base, lines: Array(201).fill(line) }).success).toBe(false);
    expect(PoInput.safeParse({ ...base, lines: [line] }).success).toBe(true);
    expect(PoInput.safeParse({ ...base, lines: [line], status: "RECEIVED" }).success).toBe(false);
  });

  it("refuses negative cost and fractional quantities", () => {
    const base = { branchId: randomUUID(), supplierId: randomUUID() };
    expect(PoInput.safeParse({ ...base, lines: [{ ...line, unitCostMinor: -1 }] }).success).toBe(false);
    expect(PoInput.safeParse({ ...base, lines: [{ ...line, qty: 1.5 }] }).success).toBe(false);
  });

  it("lets a receipt line be zero but not negative", () => {
    const poItemId = randomUUID();
    expect(ReceiptInput.safeParse({ lines: [{ poItemId, qty: 0 }] }).success).toBe(true);
    expect(ReceiptInput.safeParse({ lines: [{ poItemId, qty: -1 }] }).success).toBe(false);
  });

  it("trims supplier fields and turns blanks into null", () => {
    expect(SupplierInput.parse({ name: "  Nile Foods ", phone: "", email: "" })).toEqual({
      name: "Nile Foods",
      phone: null,
      email: null,
      taxNumber: null,
    });
    expect(SupplierInput.safeParse({ name: " " }).success).toBe(false);
  });
});

describe("purchase returns (purchase-returns-spec R1, R5, R9)", () => {
  it("returns what was received minus what went back, numbered per PO", () => {
    expect(returnable({ qtyReceived: 10, qtyReturned: 3 })).toBe(7);
    expect(returnable({ qtyReceived: 0, qtyReturned: 0 })).toBe(0);
    expect(formatReturnNumber("PO-000042", 2)).toBe("PO-000042-R2");
  });

  it("needs a known reason, strict lines and no cost from the client", () => {
    const poItemId = randomUUID();
    expect(ReturnInput.parse({ reason: "DAMAGED", lines: [{ poItemId, qty: 1 }], note: "" })).toEqual({
      reason: "DAMAGED",
      lines: [{ poItemId, qty: 1 }],
      note: null,
    });
    expect(ReturnInput.safeParse({ reason: "LOST", lines: [{ poItemId, qty: 1 }] }).success).toBe(false);
    expect(ReturnInput.safeParse({ reason: "OTHER", lines: [{ poItemId, qty: 1, unitCostMinor: 5 }] }).success).toBe(
      false,
    );
    expect(ReturnInput.safeParse({ reason: "OTHER", lines: [{ poItemId, qty: -1 }] }).success).toBe(false);
  });
});
