import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseReorderPoint } from "@/app/(app)/inventory/_lib/form";
import { LowStockQuery, ReorderPointInput, isLowStock } from "@/modules/inventory/schemas";

/** Reorder-point rules (docs/planning/low-stock/low-stock-spec.md L1–L3). */
const base = { branchId: randomUUID(), ref: { productId: randomUUID() } };

describe("ReorderPointInput", () => {
  it("accepts 0 … 1,000,000 and null, and defaults variantId to null", () => {
    expect(ReorderPointInput.parse({ ...base, reorderPoint: 0 }).ref.variantId).toBeNull();
    expect(ReorderPointInput.safeParse({ ...base, reorderPoint: 1_000_000 }).success).toBe(true);
    expect(ReorderPointInput.safeParse({ ...base, reorderPoint: null }).success).toBe(true);
  });

  it.each([-1, 1.5, 1_000_001, "3", undefined])("rejects %s", (reorderPoint) => {
    expect(ReorderPointInput.safeParse({ ...base, reorderPoint }).success).toBe(false);
  });

  it("is strict: no orgId from the client", () => {
    expect(ReorderPointInput.safeParse({ ...base, reorderPoint: 1, orgId: randomUUID() }).success).toBe(false);
    expect(LowStockQuery.safeParse({ branchId: randomUUID(), extra: "1" }).success).toBe(false);
  });
});

describe("isLowStock (L3)", () => {
  it.each([
    [5, null, false],
    [5, 4, false],
    [4, 4, true],
    [0, 0, true],
    [-2, 0, true],
    [1, 0, false],
  ])("qty %s, point %s → %s", (qty, point, expected) => {
    expect(isLowStock(qty, point)).toBe(expected);
  });
});

describe("parseReorderPoint", () => {
  it("reads empty as clear, digits (incl. Arabic-Indic) as a value, anything else as invalid", () => {
    expect(parseReorderPoint("  ")).toBeNull();
    expect(parseReorderPoint("0")).toBe(0);
    expect(parseReorderPoint("١٢")).toBe(12);
    expect(parseReorderPoint("-1")).toBeUndefined();
    expect(parseReorderPoint("2.5")).toBeUndefined();
    expect(parseReorderPoint("1000001")).toBeUndefined();
  });
});
