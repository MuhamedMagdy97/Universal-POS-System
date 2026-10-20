import { describe, expect, it } from "vitest";
import { sheetRows } from "@/app/(app)/inventory/counts/_lib/sheet";
import type { CountSheetItem } from "@/modules/inventory";

const item = (over: Partial<CountSheetItem>): CountSheetItem => ({
  name: "Item",
  nameAr: null,
  variantName: null,
  sku: "SKU",
  barcode: null,
  categoryName: null,
  categoryNameAr: null,
  expected: null,
  ...over,
});

describe("count sheet rows (C15)", () => {
  const items = [
    item({ name: "Tea", sku: "T1", categoryName: "Drinks", categoryNameAr: "مشروبات" }),
    item({ name: "Pen", sku: "P1" }),
    item({ name: "Apple", nameAr: "تفاح", sku: "A1", categoryName: "Fruit", categoryNameAr: "فواكه", barcode: "111" }),
    item({ name: "Coffee", sku: "C2", categoryName: "Drinks", variantName: "Large" }),
    item({ name: "Coffee", sku: "C1", categoryName: "Drinks", variantName: "Small", expected: 4 }),
  ];

  it("sorts by category, uncategorised last, then name and variant", () => {
    const rows = sheetRows(items, "en");
    expect(rows.map((row) => [row.category, row.name])).toEqual([
      ["Drinks", "Coffee — Large"],
      ["Drinks", "Coffee — Small"],
      ["Drinks", "Tea"],
      ["Fruit", "Apple"],
      [null, "Pen"],
    ]);
    expect(rows[1]).toMatchObject({ sku: "C1", expected: 4 });
    expect(rows[3].barcode).toBe("111");
  });

  it("uses Arabic names where present and falls back to English", () => {
    const rows = sheetRows(items, "ar");
    expect(rows.find((row) => row.sku === "A1")).toMatchObject({ name: "تفاح", category: "فواكه" });
    expect(rows.find((row) => row.sku === "T1")).toMatchObject({ name: "Tea", category: "مشروبات" });
    // Coffee has no Arabic category, so "Drinks" sorts with the Arabic names, uncategorised still last.
    expect(rows.at(-1)?.sku).toBe("P1");
  });
});
