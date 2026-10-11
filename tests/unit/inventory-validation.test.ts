import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  AdjustInput,
  ItemRefInput,
  OpeningInput,
  Qty,
  StockQuery,
  TransferInput,
  assertNoDuplicateRefs,
  checkAdjustmentDirection,
  normalizeQty,
} from "@/modules/inventory/schemas";

const uuid = () => randomUUID();
const ref = () => ({ productId: uuid(), variantId: null });

describe("ItemRefInput", () => {
  it("defaults variantId to null when the product has no variant", () => {
    const productId = uuid();
    expect(ItemRefInput.parse({ productId })).toEqual({ productId, variantId: null });
  });

  it("rejects a non-uuid product id and unknown keys", () => {
    expect(() => ItemRefInput.parse({ productId: "abc" })).toThrow();
    expect(() => ItemRefInput.parse({ productId: uuid(), orgId: uuid() })).toThrow();
  });
});

describe("Qty", () => {
  it("accepts whole numbers from 1 to 1,000,000", () => {
    expect(Qty.parse(1)).toBe(1);
    expect(Qty.parse(1_000_000)).toBe(1_000_000);
  });

  it.each([0, -1, 1.5, 1_000_001, Number.NaN])("rejects %s", (value) => {
    expect(() => Qty.parse(value)).toThrow();
  });
});

describe("normalizeQty (UI input)", () => {
  it("reads Arabic-Indic digits as a quantity", () => {
    expect(normalizeQty("٣٥")).toBe(35);
    expect(normalizeQty(" 12 ")).toBe(12);
  });

  it("returns null for an empty box, decimals and out-of-range values", () => {
    expect(normalizeQty("")).toBeNull();
    expect(normalizeQty("1.5")).toBeNull();
    expect(normalizeQty("0")).toBeNull();
    expect(normalizeQty("1000001")).toBeNull();
  });
});

describe("checkAdjustmentDirection (D2)", () => {
  it.each([
    ["DAMAGED", -1],
    ["EXPIRED", -3],
    ["LOST_OR_STOLEN", -1],
    ["FOUND", 2],
    ["COUNT_CORRECTION", 4],
    ["COUNT_CORRECTION", -4],
    ["OTHER", 1],
    ["OTHER", -1],
  ] as const)("allows %s with delta %i", (reason, delta) => {
    expect(() => checkAdjustmentDirection(reason, delta)).not.toThrow();
  });

  it.each([
    ["DAMAGED", 1],
    ["EXPIRED", 1],
    ["LOST_OR_STOLEN", 1],
    ["FOUND", -1],
  ] as const)("rejects %s with the wrong sign (delta %i)", (reason, delta) => {
    expect(() => checkAdjustmentDirection(reason, delta)).toThrow(AppError);
    try {
      checkAdjustmentDirection(reason, delta);
    } catch (err) {
      expect((err as AppError).details).toEqual({ reason: "ADJUSTMENT_DIRECTION" });
    }
  });
});

describe("AdjustInput", () => {
  const base = { branchId: uuid(), ref: ref(), expectedOnHand: 10 };

  it("accepts a change by quantity", () => {
    expect(() => AdjustInput.parse({ ...base, adjustmentReason: "DAMAGED", qtyDelta: -1 })).not.toThrow();
  });

  it("accepts a counted quantity only for COUNT_CORRECTION", () => {
    expect(() => AdjustInput.parse({ ...base, adjustmentReason: "COUNT_CORRECTION", countedQty: 0 })).not.toThrow();
    expect(() => AdjustInput.parse({ ...base, adjustmentReason: "DAMAGED", countedQty: 4 })).toThrow();
  });

  it("requires exactly one of qtyDelta or countedQty", () => {
    expect(() => AdjustInput.parse({ ...base, adjustmentReason: "COUNT_CORRECTION" })).toThrow();
    expect(() =>
      AdjustInput.parse({ ...base, adjustmentReason: "COUNT_CORRECTION", qtyDelta: 1, countedQty: 1 }),
    ).toThrow();
  });

  it("rejects a zero change (NO_CHANGE is for counted quantities)", () => {
    expect(() => AdjustInput.parse({ ...base, adjustmentReason: "FOUND", qtyDelta: 0 })).toThrow();
  });

  it("requires a non-blank note for OTHER", () => {
    expect(() => AdjustInput.parse({ ...base, adjustmentReason: "OTHER", qtyDelta: 1 })).toThrow();
    expect(() => AdjustInput.parse({ ...base, adjustmentReason: "OTHER", qtyDelta: 1, note: "  " })).toThrow();
    expect(() =>
      AdjustInput.parse({ ...base, adjustmentReason: "OTHER", qtyDelta: 1, note: "Found in back room" }),
    ).not.toThrow();
  });

  it("rejects notes longer than 500 characters", () => {
    expect(() =>
      AdjustInput.parse({ ...base, adjustmentReason: "FOUND", qtyDelta: 1, note: "x".repeat(501) }),
    ).toThrow();
  });
});

describe("OpeningInput", () => {
  it("accepts 1 to 500 lines", () => {
    const line = { ref: ref(), qty: 3 };
    expect(() => OpeningInput.parse({ branchId: uuid(), lines: [line] })).not.toThrow();
    expect(() =>
      OpeningInput.parse({ branchId: uuid(), lines: Array.from({ length: 500 }, () => line) }),
    ).not.toThrow();
    expect(() => OpeningInput.parse({ branchId: uuid(), lines: [] })).toThrow();
    expect(() => OpeningInput.parse({ branchId: uuid(), lines: Array.from({ length: 501 }, () => line) })).toThrow();
  });
});

describe("TransferInput", () => {
  const line = { ref: ref(), qty: 2 };

  it("accepts a transfer with a client-generated transferId", () => {
    expect(() =>
      TransferInput.parse({ transferId: uuid(), fromBranchId: uuid(), toBranchId: uuid(), lines: [line] }),
    ).not.toThrow();
  });

  it("rejects a missing or non-uuid transferId and more than 200 lines", () => {
    expect(() =>
      TransferInput.parse({ transferId: "not-a-uuid", fromBranchId: uuid(), toBranchId: uuid(), lines: [line] }),
    ).toThrow();
    expect(() =>
      TransferInput.parse({
        transferId: uuid(),
        fromBranchId: uuid(),
        toBranchId: uuid(),
        lines: Array.from({ length: 201 }, () => line),
      }),
    ).toThrow();
  });
});

describe("StockQuery", () => {
  it("defaults the filter to all and the page size to 25", () => {
    expect(StockQuery.parse({ branchId: uuid() })).toMatchObject({ filter: "all", limit: 25 });
  });

  it("rejects an unknown filter and a page size above 100", () => {
    expect(() => StockQuery.parse({ branchId: uuid(), filter: "low" })).toThrow();
    expect(() => StockQuery.parse({ branchId: uuid(), limit: 101 })).toThrow();
  });
});

describe("assertNoDuplicateRefs", () => {
  it("passes distinct items", () => {
    const a = uuid();
    expect(() =>
      assertNoDuplicateRefs([
        { productId: a, variantId: null },
        { productId: a, variantId: uuid() },
      ]),
    ).not.toThrow();
  });

  it("rejects the same product and variant twice with DUPLICATE_LINE", () => {
    const a = uuid();
    try {
      assertNoDuplicateRefs([
        { productId: a, variantId: null },
        { productId: a, variantId: null },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(422);
      expect((err as AppError).details).toEqual({ reason: "DUPLICATE_LINE" });
    }
  });
});
