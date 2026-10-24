import type { TillSnapshot } from "@/modules/sales";
import type { TillItem } from "./till";

/** Tiles per chip, online and offline (business-profiles-spec BP8). */
export const TILE_LIMIT = 60;

/**
 * Tiles from the offline snapshot: every item for "All" (`categoryId` null), else the category's items, by name.
 * Items from a snapshot saved before tiles existed have no category and show under "All" only.
 */
export function snapshotTiles(snapshot: TillSnapshot, categoryId: string | null): TillItem[] {
  return snapshot.items
    .filter((item) => categoryId === null || item.categoryId === categoryId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, TILE_LIMIT)
    .map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      sku: item.sku,
      name: item.name,
      nameAr: item.nameAr,
      unitPriceMinor: item.unitPriceMinor,
      vatApplicable: item.vatApplicable,
    }));
}
