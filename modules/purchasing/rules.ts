import { multiply, sum } from "@/lib/money";
import type { PoLineInput, PoStatus } from "./schemas";

/**
 * Pure purchasing rules (T5): no DB access, unit-tested in tests/unit/purchasing-rules.test.ts.
 * See purchasing-spec.md P3, P4, P7, P8.
 */

export type PoState = {
  status: PoStatus;
  /** Units received over every line; > 0 once anything has been received. */
  receivedUnits: number;
};

export type LineQty = { qtyOrdered: number; qtyReceived: number };

/** `PO-000001`. Six digits, more when the counter outgrows them. */
export function formatPoNumber(n: number): string {
  return `PO-${String(n).padStart(6, "0")}`;
}

/**
 * One line per item (P8): repeated refs are merged, quantities added and the later cost kept,
 * in first-seen order.
 */
export function mergePoLines(lines: readonly PoLineInput[]): PoLineInput[] {
  const merged = new Map<string, PoLineInput>();
  for (const line of lines) {
    const key = `${line.ref.productId}|${line.ref.variantId ?? ""}`;
    const existing = merged.get(key);
    if (existing) merged.set(key, { ...existing, qty: existing.qty + line.qty, unitCostMinor: line.unitCostMinor });
    else
      merged.set(key, {
        ref: { productId: line.ref.productId, variantId: line.ref.variantId ?? null },
        qty: line.qty,
        unitCostMinor: line.unitCostMinor,
      });
  }
  return [...merged.values()];
}

export function outstanding(line: LineQty): number {
  return line.qtyOrdered - line.qtyReceived;
}

/** RECEIVED once every line is full, otherwise PARTIALLY_RECEIVED. */
export function statusAfterReceipt(lines: readonly LineQty[]): "PARTIALLY_RECEIVED" | "RECEIVED" {
  return lines.every((line) => line.qtyReceived >= line.qtyOrdered) ? "RECEIVED" : "PARTIALLY_RECEIVED";
}

/** Lines, supplier and note change while DRAFT, or ORDERED with nothing received (P4). */
export function canEdit(po: PoState): boolean {
  return po.status === "DRAFT" || (po.status === "ORDERED" && po.receivedUnits === 0);
}

export function canOrder(po: PoState): boolean {
  return po.status === "DRAFT";
}

export function canCancel(po: PoState): boolean {
  return canEdit(po);
}

/** Close short: something arrived, something is still missing (P3). */
export function canClose(po: PoState): boolean {
  return po.status === "PARTIALLY_RECEIVED";
}

export function canReceive(po: PoState): boolean {
  return po.status === "ORDERED" || po.status === "PARTIALLY_RECEIVED";
}

export type PoTotals = { lineCount: number; orderedUnits: number; receivedUnits: number; totalMinor: number };

/** Totals from the lines (P13): value is Σ qtyOrdered × unit cost, exact in integers. */
export function poTotals(lines: readonly (LineQty & { unitCostMinor: number })[]): PoTotals {
  return {
    lineCount: lines.length,
    orderedUnits: sum(lines.map((line) => line.qtyOrdered)),
    receivedUnits: sum(lines.map((line) => line.qtyReceived)),
    totalMinor: sum(lines.map((line) => multiply(line.unitCostMinor, line.qtyOrdered))),
  };
}
