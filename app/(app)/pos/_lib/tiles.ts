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
      unitType: item.unitType,
    }));
}

/**
 * Online tiles for a chip ("" = All) from the browse search. When the request cannot be sent (fetch throws a
 * TypeError) and a usable snapshot is on the device, the till is marked unreachable and the snapshot answers, as the
 * till's search does. Anything else is "failed".
 */
export async function loadTiles(
  key: string,
  fallback: TillSnapshot | null,
  onUnreachable: () => void,
): Promise<TillItem[] | "failed"> {
  const params = new URLSearchParams(key ? { categoryId: key } : { all: "1" });
  params.set("limit", String(TILE_LIMIT));
  try {
    const response = await fetch(`/api/catalog/search?${params}`, { headers: { accept: "application/json" } });
    if (!response.ok) return "failed";
    return (await response.json()) as TillItem[];
  } catch (err) {
    if (!(err instanceof TypeError) || !fallback) return "failed";
    onUnreachable();
    return snapshotTiles(fallback, key || null);
  }
}
