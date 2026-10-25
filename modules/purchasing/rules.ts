import { sum, vatOnNet } from "@/lib/money";
import { lineMinor, type QtyUnit } from "@/lib/quantity";
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

/**
 * Totals from the lines (P13): value is Σ qtyOrdered × unit cost, exact in integers; a KG line is grams × cost per kg
 * ÷ 1000 (weighed-selling-spec W3). Units add pieces and grams as stored.
 */
export function poTotals(lines: readonly (LineQty & { unitCostMinor: number; unitType?: QtyUnit })[]): PoTotals {
  return {
    lineCount: lines.length,
    orderedUnits: sum(lines.map((line) => line.qtyOrdered)),
    receivedUnits: sum(lines.map((line) => line.qtyReceived)),
    totalMinor: sum(lines.map((line) => lineMinor(line.unitCostMinor, line.qtyOrdered, line.unitType ?? "EACH"))),
  };
}

// ---------- supplier accounts (supplier-payments-spec S1, S13) ----------

export type AccountEntryKind =
  "RECEIPT" | "RETURN" | "PAYMENT" | "REVERSAL" | "INVOICE" | "CREDIT_NOTE" | "INVOICE_VOID" | "CREDIT_NOTE_VOID";

/**
 * One movement on a supplier account. `amountMinor` is always positive; the kind gives the sign. For
 * invoices and credit notes (and their voids) `coveredMinor` is the at-cost value of the receipts or
 * return the document replaces (supplier-invoices-spec I7).
 */
export type AccountEntry = { kind: AccountEntryKind; day: string; amountMinor: number; coveredMinor?: number };

/**
 * What the entry does to the balance owed (S1, I7): receipts and reversals add, returns and payments
 * subtract; an invoice adds what it bills beyond the receipts it covers, a credit note the reverse,
 * and a void undoes its document on the void day.
 */
export function balanceEffect(entry: Pick<AccountEntry, "kind" | "amountMinor" | "coveredMinor">): number {
  const adjustment = entry.amountMinor - (entry.coveredMinor ?? 0);
  switch (entry.kind) {
    case "RECEIPT":
    case "REVERSAL":
      return entry.amountMinor;
    case "RETURN":
    case "PAYMENT":
      return -entry.amountMinor;
    case "INVOICE":
    case "CREDIT_NOTE_VOID":
      return adjustment;
    case "CREDIT_NOTE":
    case "INVOICE_VOID":
      return -adjustment;
  }
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

// ---------- supplier invoices (supplier-invoices-spec I5, I9, I10) ----------

/** Per-line VAT rounding on a real invoice can exceed the rate on the total by this much (I5). */
export const INPUT_VAT_TOLERANCE_MINOR = 100;

/** Default input VAT: the shop rate on the net, rounded like sales (I5). */
export function defaultInputVat(netMinor: number, rateBp: number): number {
  return vatOnNet(netMinor, rateBp);
}

/** The most input VAT a document may carry: the rate on the net plus the rounding tolerance (I5). */
export function maxInputVat(netMinor: number, rateBp: number): number {
  return defaultInputVat(netMinor, rateBp) + INPUT_VAT_TOLERANCE_MINOR;
}

export type InvoiceStatus = "OPEN" | "PAID" | "OVERDUE" | "VOID";

/** Open amount and status (I10). `today` and `dueOn` are shop-local `YYYY-MM-DD`. */
export function invoiceState(
  invoice: { voided: boolean; totalMinor: number; paidMinor: number; creditedMinor: number; dueOn: string | null },
  today: string,
): { openMinor: number; status: InvoiceStatus } {
  if (invoice.voided) return { openMinor: 0, status: "VOID" };
  const openMinor = Math.max(0, invoice.totalMinor - invoice.paidMinor - invoice.creditedMinor);
  if (openMinor === 0) return { openMinor, status: "PAID" };
  return { openMinor, status: invoice.dueOn !== null && invoice.dueOn < today ? "OVERDUE" : "OPEN" };
}

export type OpenInvoice = { id: string; number: string; issuedOn: string; dueOn: string | null; openMinor: number };

/** Oldest first: by due date (none last), then issue date, then number (I9). */
export function oldestFirst<T extends Omit<OpenInvoice, "openMinor">>(invoices: readonly T[]): T[] {
  return [...invoices].sort(
    (a, b) =>
      (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31") ||
      a.issuedOn.localeCompare(b.issuedOn) ||
      a.number.localeCompare(b.number),
  );
}

/** Spreads `amountMinor` over open invoices, oldest first, each up to its open amount (I9). */
export function allocateOldestFirst(
  amountMinor: number,
  invoices: readonly OpenInvoice[],
): { invoiceId: string; amountMinor: number }[] {
  let left = amountMinor;
  const out: { invoiceId: string; amountMinor: number }[] = [];
  for (const invoice of oldestFirst(invoices)) {
    if (left <= 0) break;
    const take = Math.min(left, invoice.openMinor);
    if (take > 0) out.push({ invoiceId: invoice.id, amountMinor: take });
    left -= take;
  }
  return out;
}

// ---------- direct receipts (direct-receipt-spec D5) ----------

/** `GR-1A2B3C4D`: a direct receipt has no PO number, so it shows the start of its id. */
export function formatDirectReceiptNumber(receiptId: string): string {
  return `GR-${receiptId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
