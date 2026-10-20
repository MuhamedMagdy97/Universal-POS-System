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

export type ReturnQty = { qtyReceived: number; qtyReturned: number };

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

/** What can still go back to the supplier (purchase-returns-spec R1). */
export function returnable(line: ReturnQty): number {
  return line.qtyReceived - line.qtyReturned;
}

/** `PO-000123-R1`: the PO number and the return's place on it (R9). */
export function formatReturnNumber(poNumber: string, seq: number): string {
  return `${poNumber}-R${seq}`;
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

// ---------- supplier accounts (supplier-payments-spec S1, S13) ----------

export type AccountEntryKind = "RECEIPT" | "RETURN" | "PAYMENT" | "REVERSAL";

/** One movement on a supplier account. `amountMinor` is always positive; the kind gives the sign. */
export type AccountEntry = { kind: AccountEntryKind; day: string; amountMinor: number };

/** What the entry does to the balance owed (S1): receipts and reversals add, returns and payments subtract. */
export function balanceEffect(entry: Pick<AccountEntry, "kind" | "amountMinor">): number {
  return entry.kind === "RECEIPT" || entry.kind === "REVERSAL" ? entry.amountMinor : -entry.amountMinor;
}

export type Statement<T extends AccountEntry> = {
  openingMinor: number;
  entries: (T & { balanceMinor: number })[];
  closingMinor: number;
  /** Everything up to now, whatever the range. */
  balanceMinor: number;
};

/**
 * A statement for local days `from` … `to` from every entry of the account, already in order (S13):
 * entries before `from` make the opening balance, each entry in range carries the running balance.
 */
export function statementOf<T extends AccountEntry>(all: readonly T[], from: string, to: string): Statement<T> {
  let openingMinor = 0;
  let balanceMinor = 0;
  let closingMinor = 0;
  const entries: (T & { balanceMinor: number })[] = [];
  for (const entry of all) {
    balanceMinor += balanceEffect(entry);
    if (entry.day < from) openingMinor = balanceMinor;
    if (entry.day <= to) closingMinor = balanceMinor;
    if (entry.day >= from && entry.day <= to) entries.push({ ...entry, balanceMinor });
  }
  return { openingMinor, entries, closingMinor, balanceMinor };
}
