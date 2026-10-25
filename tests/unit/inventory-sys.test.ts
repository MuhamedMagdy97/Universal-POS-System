import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classify } from "@/modules/integrations/inventory-sys/client";
import {
  mapImsCategories,
  mapImsProduct,
  toMinor,
  type ImsProduct,
} from "@/modules/integrations/inventory-sys/mapping";
import { open, seal } from "@/modules/integrations/inventory-sys/secret";
import { inventoryErrorKey } from "@/app/(app)/settings/_lib/inventory";

const variant = (over: Partial<ImsProduct["variants"][number]> = {}): ImsProduct["variants"][number] => ({
  id: "v1",
  sku: "COLA-330",
  barcode: "6221000000017",
  name: null,
  status: "active",
  sellPrice: "12.5000",
  costPrice: "8.2500",
  barcodeAliases: [],
  ...over,
});

const product = (over: Partial<ImsProduct> = {}): ImsProduct => ({
  id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  name: "Cola 330 ml",
  type: "simple",
  status: "active",
  isSerialized: false,
  baseUom: "each",
  variants: [variant()],
  ...over,
});

describe("secret (spec I3)", () => {
  const key = randomBytes(32);

  it("round-trips and never stores the plain key", () => {
    const sealed = seal("ims_live_abcdef123456", key);
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("ims_live_abcdef123456");
    expect(open(sealed, key)).toBe("ims_live_abcdef123456");
  });

  it("fails with the wrong key or a tampered value", () => {
    const sealed = seal("secret-key-1234", key);
    expect(() => open(sealed, randomBytes(32))).toThrow();
    const tampered = Uint8Array.from(sealed);
    tampered[14] ^= 1;
    expect(() => open(tampered, key)).toThrow();
  });
});

describe("toMinor", () => {
  it.each([
    ["12.5000", 1250, false],
    ["12", 1200, false],
    ["0.005", 1, true],
    ["1.0049", 100, true],
    ["1.0050", 101, true],
    [7.25, 725, false],
  ] as const)("%s → %i", (value, minor, rounded) => {
    expect(toMinor(value)).toEqual({ minor, rounded });
  });

  it("is null for missing or malformed prices", () => {
    expect(toMinor(null)).toBeNull();
    expect(toMinor("-1")).toBeNull();
    expect(toMinor("abc")).toBeNull();
  });
});

describe("mapImsProduct (spec I7–I9)", () => {
  it("maps a simple product onto a POS product without variants", () => {
    const { item, notes } = mapImsProduct(product({ variants: [variant({ barcodeAliases: [{ barcode: "OLD-1" }] })] }));
    expect(notes).toEqual([]);
    expect(item).toMatchObject({
      sku: "COLA-330",
      name: "Cola 330 ml",
      priceMinor: 1250,
      costMinor: 825,
      unitType: "EACH",
      isActive: true,
      notSellableReason: null,
      externalVariantId: "v1",
      barcodes: ["6221000000017", "OLD-1"],
      variants: null,
    });
  });

  it("maps a variant parent with one POS variant per IMS variant and a derived SKU", () => {
    const { item } = mapImsProduct(
      product({
        type: "variant_parent",
        name: "Shirt",
        variants: [
          variant({ id: "a", sku: "SHIRT-M", name: "M", sellPrice: "150" }),
          variant({ id: "b", sku: "SHIRT-L", name: "L", sellPrice: "160", barcode: null }),
          variant({ id: "c", sku: "SHIRT-XL", name: "XL", sellPrice: null, barcode: null }),
        ],
      }),
    );
    expect(item?.sku).toBe("P-0190A1B2C3D47E5F8A9B0C1D2E3F4A5B");
    expect(item?.priceMinor).toBe(15000);
    expect(item?.variants?.map((v) => [v.sku, v.priceMinor, v.isActive, v.notSellableReason])).toEqual([
      ["SHIRT-M", 15000, true, null],
      ["SHIRT-L", 16000, true, null],
      ["SHIRT-XL", 0, false, "NO_PRICE"],
    ]);
  });

  it.each([
    [{ status: "discontinued" }, "STATUS"],
    [{ isSerialized: true }, "SERIALIZED"],
    [{ baseUom: "box" }, "UNIT"],
    [{ variants: [variant({ sellPrice: null })] }, "NO_PRICE"],
    [{ variants: [variant({ status: "inactive" })] }, "STATUS"],
  ] as const)("%j is synced but not sellable (%s)", (over, reason) => {
    const { item } = mapImsProduct(product(over as Partial<ImsProduct>));
    expect(item).toMatchObject({ isActive: false, notSellableReason: reason });
  });

  it("maps kg as not sellable yet, flags rounded prices and drops unprintable barcodes", () => {
    const { item, notes } = mapImsProduct(
      product({ baseUom: "kg", variants: [variant({ sellPrice: "9.995", barcode: "bad code" })] }),
    );
    // The inventory system's quantities are not grams yet (weighed-selling-spec W11).
    expect(item).toMatchObject({
      unitType: "KG",
      priceMinor: 1000,
      barcodes: [],
      isActive: false,
      notSellableReason: "UNIT",
    });
    expect(notes).toEqual(["PRICE_ROUNDED:COLA-330", "BARCODE_INVALID:COLA-330"]);
  });

  it("skips a simple product without exactly one variant", () => {
    expect(mapImsProduct(product({ variants: [] })).item).toBeNull();
  });
});

describe("IMS answers (spec I17)", () => {
  const reason = (status: number, code?: string) =>
    (classify(status, code).details as { reason?: string } | null)?.reason;

  it("classifies outages, a broken link and refusals", () => {
    expect(reason(503)).toBe("INVENTORY_UNAVAILABLE");
    expect(reason(429)).toBe("INVENTORY_UNAVAILABLE");
    expect(reason(409, "conflict")).toBe("INVENTORY_UNAVAILABLE");
    expect(reason(403, "forbidden")).toBe("INVENTORY_LINK_BROKEN");
    expect(reason(409, "insufficient_stock")).toBe("INVENTORY_REJECTED");
    expect(classify(404).code).toBe("NOT_FOUND");
  });
});

describe("inventoryErrorKey", () => {
  it("maps known reasons and falls back by code", () => {
    expect(inventoryErrorKey({ code: "CONFLICT", message: "", details: { reason: "OPEN_SHIFTS" } })).toBe(
      "settings.inventory.error.OPEN_SHIFTS",
    );
    expect(inventoryErrorKey({ code: "FORBIDDEN", message: "", details: null })).toBe(
      "settings.inventory.error.forbidden",
    );
    expect(inventoryErrorKey({ code: "INTERNAL", message: "", details: { reason: "NOPE" } })).toBe(
      "settings.inventory.error.generic",
    );
  });
});

describe("mapImsCategories", () => {
  const row = (id: string, parentId: string | null, name = id, archived = false) => ({
    id,
    parentId,
    name,
    sort: 1,
    archived,
  });

  it("keeps three levels, folds deeper ones into the third, parents first", () => {
    // Children listed before parents still come out parents first.
    const { categories, folded, notes } = mapImsCategories([
      row("d4", "c3"),
      row("c3", "b2"),
      row("e5", "d4"),
      row("b2", "a1"),
      row("a1", null, "  Drinks  ", true),
    ]);
    expect(categories.map((c) => [c.externalCategoryId, c.externalParentId, c.depth])).toEqual([
      ["a1", null, 1],
      ["b2", "a1", 2],
      ["c3", "b2", 3],
    ]);
    expect(categories[0]).toMatchObject({ name: "Drinks", isActive: false, sortOrder: 1 });
    expect([...folded]).toEqual([
      ["d4", "c3"],
      ["e5", "c3"],
    ]);
    expect(notes).toEqual(["CATEGORY_FOLDED:d4", "CATEGORY_FOLDED:e5"]);
  });

  it("treats an unknown parent as a root", () => {
    expect(mapImsCategories([row("x", "missing")]).categories[0]).toMatchObject({ externalParentId: null, depth: 1 });
  });

  it("carries the product's category id", () => {
    expect(mapImsProduct(product({ categoryId: "c1" })).item?.externalCategoryId).toBe("c1");
    expect(mapImsProduct(product()).item?.externalCategoryId).toBeNull();
  });
});
