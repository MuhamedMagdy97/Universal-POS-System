import { describe, expect, it } from "vitest";
import { assertFresh, uniqueViolation } from "@/modules/catalog/errors";
import {
  categoryDepth,
  diffFields,
  escapeLike,
  exceedsMaxDepth,
  isBarcodeCandidate,
  nextUpdatedAt,
  priceWarnings,
  sortKeyOf,
  startCursorKey,
  subtreeHeight,
  wouldCreateCycle,
} from "@/modules/catalog/rules";
import { AppError } from "@/lib/errors";

describe("search helpers", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLike("50%_off\\x")).toBe("50\\%\\_off\\\\x");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("classifies barcode candidates (printable ASCII, no spaces, ≤ 64)", () => {
    expect(isBarcodeCandidate("6221234567890")).toBe(true);
    expect(isBarcodeCandidate("ABC-123")).toBe(true);
    expect(isBarcodeCandidate("red shirt")).toBe(false);
    expect(isBarcodeCandidate("قهوة")).toBe(false);
    expect(isBarcodeCandidate("9".repeat(65))).toBe(false);
  });

  it("derives cursor sort keys", () => {
    const row = { name: "Tea", updatedAt: new Date("2026-10-11T10:00:00.000Z") };
    expect(sortKeyOf(row, "name")).toBe("Tea");
    expect(sortKeyOf(row, "updatedAt")).toBe("2026-10-11T10:00:00.000Z");
  });

  it("start cursors sort before every real row", () => {
    expect(startCursorKey("name").sortKey).toBe("");
    expect(new Date(startCursorKey("updatedAt").sortKey).getUTCFullYear()).toBe(9999);
  });
});

describe("category tree rules", () => {
  // r1 ─ a ─ b ;  r2 ─ c
  const parents = new Map<string, string | null>([
    ["r1", null],
    ["a", "r1"],
    ["b", "a"],
    ["r2", null],
    ["c", "r2"],
  ]);

  it("computes depth and subtree height", () => {
    expect(categoryDepth(parents, "r1")).toBe(1);
    expect(categoryDepth(parents, "b")).toBe(3);
    expect(subtreeHeight(parents, "r1")).toBe(3);
    expect(subtreeHeight(parents, "b")).toBe(1);
    expect(subtreeHeight(parents, "r2")).toBe(2);
  });

  it("detects cycles (self and descendants)", () => {
    expect(wouldCreateCycle(parents, "r1", "r1")).toBe(true);
    expect(wouldCreateCycle(parents, "r1", "b")).toBe(true);
    expect(wouldCreateCycle(parents, "a", "c")).toBe(false);
    expect(wouldCreateCycle(parents, "a", null)).toBe(false);
  });

  it("enforces max depth 3 for new nodes and moved subtrees", () => {
    expect(exceedsMaxDepth(parents, null, "a")).toBe(false); // new node at depth 3
    expect(exceedsMaxDepth(parents, null, "b")).toBe(true); // depth 4
    expect(exceedsMaxDepth(parents, "r2", "r1")).toBe(false); // r2 (height 2) under depth 1 → 3
    expect(exceedsMaxDepth(parents, "r2", "a")).toBe(true); // under depth 2 → 4
    expect(exceedsMaxDepth(parents, "a", null)).toBe(false);
  });

  it("does not loop forever on corrupt data", () => {
    const loop = new Map<string, string | null>([
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(categoryDepth(loop, "x")).toBe(2);
    expect(wouldCreateCycle(loop, "z", "x")).toBe(false);
  });
});

describe("price and change helpers", () => {
  it("warns only when price is below cost", () => {
    expect(priceWarnings(100, 200)).toEqual(["PRICE_BELOW_COST"]);
    expect(priceWarnings(200, 200)).toEqual([]);
    expect(priceWarnings(0, 0)).toEqual([]);
  });

  it("diffs only provided, changed fields (null is a value, undefined is not)", () => {
    const current: Record<string, unknown> = { name: "A", nameAr: "ب", price: 1 };
    expect(diffFields(current, { name: "B", nameAr: null, price: undefined })).toEqual({
      name: ["A", "B"],
      nameAr: ["ب", null],
    });
    expect(diffFields({ name: "A" }, { name: "A" })).toEqual({});
  });

  it("always moves updatedAt forward", () => {
    const previous = new Date("2026-10-11T10:00:00.000Z");
    expect(nextUpdatedAt(previous, new Date("2026-10-11T09:00:00.000Z")).getTime()).toBe(previous.getTime() + 1);
    const later = new Date("2026-10-11T11:00:00.000Z");
    expect(nextUpdatedAt(previous, later)).toBe(later);
  });
});

describe("error helpers", () => {
  it("maps a stale timestamp to 409 STALE_WRITE", () => {
    const at = new Date("2026-10-11T10:00:00.000Z");
    expect(() => assertFresh(at, "2026-10-11T10:00:00.000Z")).not.toThrow();
    try {
      assertFresh(at, "2026-10-11T10:00:00.001Z");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).details).toMatchObject({ reason: "STALE_WRITE" });
    }
  });

  const p2002 = (index: string, message = "Unique constraint failed") => ({
    name: "PrismaClientKnownRequestError",
    code: "P2002",
    message,
    meta: { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index } } } },
  });

  it("recognises catalog unique constraints from driver-adapter P2002 errors", () => {
    expect(uniqueViolation(p2002("sku_namespace"))).toBe("sku_namespace");
    expect(uniqueViolation(p2002("Barcode_orgId_code_key"))).toBe("Barcode_orgId_code_key");
    expect(uniqueViolation(p2002("Category_sibling_name_key"))).toBe("Category_sibling_name_key");
  });

  it("ignores other errors and unknown constraints", () => {
    expect(uniqueViolation(p2002("Branch_orgId_code_key"))).toBeNull();
    expect(uniqueViolation({ name: "PrismaClientKnownRequestError", code: "P2003", message: "fk" })).toBeNull();
    expect(uniqueViolation(new Error("Product_orgId_sku_key"))).toBeNull();
  });
});
