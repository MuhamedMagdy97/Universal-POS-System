import "server-only";
import type { Db } from "@/lib/db";
import { lineMinor, type QtyUnit } from "@/lib/quantity";
import type { Tx } from "./access";

/**
 * Units of the products on purchase documents (weighed-selling-spec W2, W3). A KG line's quantity is grams and its
 * cost is per kg, so its value is `lineMinor`, never `cost × qty`. `unitType` is fixed after a product is created.
 */
export async function unitsOf(client: Db | Tx, orgId: string, productIds: Iterable<string>): Promise<UnitOf> {
  const ids = [...new Set(productIds)];
  const rows =
    ids.length === 0
      ? []
      : await client.product.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, unitType: true } });
  const units = new Map<string, QtyUnit>(rows.map((row) => [row.id, row.unitType]));
  return (productId: string) => units.get(productId) ?? "EACH";
}

export type UnitOf = (productId: string) => QtyUnit;

/** A purchase line's value: `cost × qty` for pieces, cost per kg × grams ÷ 1000 for KG. */
export function costValue(line: { productId: string; unitCostMinor: number; qty: number }, unitOf: UnitOf): number {
  return lineMinor(line.unitCostMinor, line.qty, unitOf(line.productId));
}
