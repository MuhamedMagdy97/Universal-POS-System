import { describe, expect, it } from "vitest";
import { countErrorKey, pickScanned } from "@/app/(app)/inventory/_lib/form";
import { CountCreateInput, CountEntryInput, countDelta } from "@/modules/inventory/schemas";

/** Stock counts: input rules and the difference rule (stock-counts-spec C2, C4–C6). */
const uuid = "00000000-0000-4000-8000-000000000001";
const ref = { productId: uuid };

describe("count inputs", () => {
  it("requires a category exactly for a category count", () => {
    expect(CountCreateInput.safeParse({ branchId: uuid, scope: "FULL" }).success).toBe(true);
    expect(CountCreateInput.safeParse({ branchId: uuid, scope: "CATEGORY", categoryId: uuid }).success).toBe(true);
    expect(CountCreateInput.safeParse({ branchId: uuid, scope: "CATEGORY" }).success).toBe(false);
    expect(CountCreateInput.safeParse({ branchId: uuid, scope: "ITEMS", categoryId: uuid }).success).toBe(false);
    expect(CountCreateInput.safeParse({ branchId: uuid, scope: "FULL", orgId: uuid }).success).toBe(false);
  });

  it("takes exactly one of add (scan) or set (typed, null clears)", () => {
    expect(CountEntryInput.safeParse({ ref, add: 1 }).success).toBe(true);
    expect(CountEntryInput.safeParse({ ref, set: 0 }).success).toBe(true);
    expect(CountEntryInput.safeParse({ ref, set: null }).success).toBe(true);
    expect(CountEntryInput.safeParse({ ref }).success).toBe(false);
    expect(CountEntryInput.safeParse({ ref, add: 1, set: 2 }).success).toBe(false);
    expect(CountEntryInput.safeParse({ ref, add: 0 }).success).toBe(false);
    expect(CountEntryInput.safeParse({ ref, set: -1 }).success).toBe(false);
    expect(CountEntryInput.safeParse({ ref, set: 1_000_001 }).success).toBe(false);
  });
});

describe("countDelta", () => {
  it("is counted minus the expected snapshot, null when not counted", () => {
    expect(countDelta(8, 10)).toBe(-2);
    expect(countDelta(4, 3)).toBe(1);
    expect(countDelta(0, -2)).toBe(2);
    expect(countDelta(null, null)).toBeNull();
  });
});

describe("count screen helpers", () => {
  const rows = [
    { sku: "ABC-1", primaryBarcode: "111" },
    { sku: "ABC-12", primaryBarcode: "222" },
  ];

  it("picks the only result, or the exact barcode or SKU among several", () => {
    expect(pickScanned("x", [rows[0]])).toBe(rows[0]);
    expect(pickScanned("222", rows)).toBe(rows[1]);
    expect(pickScanned("abc-1", rows)).toBe(rows[0]);
    expect(pickScanned("ABC", rows)).toBeNull();
    expect(pickScanned("ABC", [])).toBeNull();
  });

  it("maps count error reasons to their messages", () => {
    const error = (reason: string) => ({ code: "CONFLICT" as const, message: "", details: { reason } });
    expect(countErrorKey(error("INSUFFICIENT_STOCK"))).toBe("inventory.error.countInsufficient");
    expect(countErrorKey(error("COUNT_OPEN"))).toBe("inventory.error.countOpen");
    expect(countErrorKey(error("ITEM_NOT_IN_COUNT"))).toBe("inventory.error.notInCount");
    expect(countErrorKey(error("COUNT_STATE"))).toBe("inventory.error.countState");
    expect(countErrorKey(error("COUNT_EMPTY"))).toBe("inventory.error.countEmpty");
    expect(countErrorKey(error("SOMETHING"))).toBe("inventory.error.generic");
  });
});
