import { describe, expect, it } from "vitest";
import { lockOrder } from "@/modules/inventory/locking";

const key = (branchId: string, productId: string, variantId: string | null = null) => ({
  branchId,
  productId,
  variantId,
});

describe("lockOrder (balance row lock order, inventory D7)", () => {
  it("sorts by branch, then product, then variant with NULL first", () => {
    const sorted = lockOrder([key("b2", "p1"), key("b1", "p2", "v1"), key("b1", "p1", "v1"), key("b1", "p1")]);
    expect(sorted).toEqual([key("b1", "p1"), key("b1", "p1", "v1"), key("b1", "p2", "v1"), key("b2", "p1")]);
  });

  it("removes duplicate keys so one row is locked once", () => {
    expect(lockOrder([key("b1", "p1"), key("b1", "p1")])).toEqual([key("b1", "p1")]);
  });

  it("gives the same order no matter how the caller lists the lines", () => {
    const a = [key("b1", "p2"), key("b2", "p1"), key("b1", "p1", "v9")];
    const b = [...a].reverse();
    expect(lockOrder(a)).toEqual(lockOrder(b));
  });
});
