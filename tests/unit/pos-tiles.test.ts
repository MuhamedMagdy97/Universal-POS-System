import { describe, expect, it } from "vitest";
import { snapshotTiles } from "@/app/(app)/pos/_lib/tiles";
import type { TillSnapshot } from "@/modules/sales/offline-snapshot";

/** Till tiles offline (business-profiles-spec BP8): from the snapshot, by name, 60 at most. */

const item = (sku: string, name: string, categoryId?: string | null) => ({
  productId: `p-${sku}`,
  variantId: null,
  sku,
  name,
  nameAr: null,
  unitType: "EACH" as const,
  unitPriceMinor: 100,
  vatCategory: "STANDARD" as const,
  vatApplicable: true,
  barcodes: [],
  ...(categoryId !== undefined && { categoryId }),
});

const snapshot = (items: ReturnType<typeof item>[]) => ({ items }) as unknown as TillSnapshot;

describe("snapshotTiles", () => {
  it("lists every item by name for All and only the category's items for a category", () => {
    const snap = snapshot([item("B", "Tea", "drinks"), item("A", "Croissant", "pastry"), item("C", "Latte", "drinks")]);
    expect(snapshotTiles(snap, null).map((i) => i.name)).toEqual(["Croissant", "Latte", "Tea"]);
    expect(snapshotTiles(snap, "drinks").map((i) => i.name)).toEqual(["Latte", "Tea"]);
  });

  it("keeps items from an older snapshot (no category) under All only", () => {
    const snap = snapshot([item("A", "Old item")]);
    expect(snapshotTiles(snap, null).map((i) => i.sku)).toEqual(["A"]);
    expect(snapshotTiles(snap, "drinks")).toEqual([]);
  });

  it("returns till items without barcodes, 60 at most", () => {
    const snap = snapshot(Array.from({ length: 70 }, (_, n) => item(`S${n}`, `Item ${String(n).padStart(2, "0")}`)));
    const tiles = snapshotTiles(snap, null);
    expect(tiles).toHaveLength(60);
    expect(tiles[0]).not.toHaveProperty("barcodes");
  });
});
