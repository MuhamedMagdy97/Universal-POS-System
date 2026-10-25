import type { MessageKey } from "@/lib/i18n";
import { divideRoundHalfUp } from "@/lib/money";
import type { ReportName } from "./schemas";

/**
 * Visible columns per report, shared by the screen and the CSV export. Pure, so client
 * components can import it. `kind` drives formatting and whether the column is totalled.
 */

export type ColumnKind =
  | "text"
  | "name" // localized: `name` / `nameAr`
  | "int"
  | "qty" // pieces, or grams on a row whose unitType is KG (shown in kg, weighed-selling-spec W9)
  | "money"
  | "day"
  | "datetime"
  | "method"
  | "rate"
  | "status"
  | "kind"
  | "margin"; // basis points, null when there is no revenue with cost

/** Column headers are `reports.col.*` keys, none of which take placeholders. */
export type ColumnLabel = Extract<MessageKey, `reports.col.${string}`>;

export type Column = { key: string; label: ColumnLabel; kind: ColumnKind };

const c = (key: string, label: ColumnLabel, kind: ColumnKind): Column => ({ key, label, kind });

const PROFIT_COLUMNS: readonly Column[] = [
  c("qtySold", "reports.col.qtySold", "qty"),
  c("qtyRefunded", "reports.col.qtyRefunded", "qty"),
  c("netRevenueMinor", "reports.col.netRevenueExVat", "money"),
  c("revenueNoCostMinor", "reports.col.revenueNoCost", "money"),
  c("costMinor", "reports.col.cost", "money"),
  c("grossProfitMinor", "reports.col.grossProfit", "money"),
  c("marginBp", "reports.col.margin", "margin"),
];

export const REPORT_COLUMNS: Record<ReportName, readonly Column[]> = {
  "sales-summary": [
    c("day", "reports.col.day", "day"),
    c("salesCount", "reports.col.salesCount", "int"),
    c("discountsMinor", "reports.col.discounts", "money"),
    c("grossMinor", "reports.col.gross", "money"),
    c("vatMinor", "reports.col.vat", "money"),
    c("netMinor", "reports.col.net", "money"),
    c("refundsCount", "reports.col.refundsCount", "int"),
    c("refundsMinor", "reports.col.refunds", "money"),
    c("voidsCount", "reports.col.voidsCount", "int"),
    c("voidsMinor", "reports.col.voids", "money"),
    c("netAfterRefundsMinor", "reports.col.netAfterRefunds", "money"),
  ],
  payments: [
    c("method", "reports.col.method", "method"),
    c("salesCount", "reports.col.salesCount", "int"),
    c("salesMinor", "reports.col.sales", "money"),
    c("refundsCount", "reports.col.refundsCount", "int"),
    c("refundsMinor", "reports.col.refunds", "money"),
    c("netMinor", "reports.col.netReceived", "money"),
  ],
  products: [
    c("sku", "reports.col.sku", "text"),
    c("name", "reports.col.product", "name"),
    c("qtySold", "reports.col.qtySold", "qty"),
    c("qtyRefunded", "reports.col.qtyRefunded", "qty"),
    c("grossMinor", "reports.col.sales", "money"),
    c("refundsMinor", "reports.col.refunds", "money"),
    c("netMinor", "reports.col.netRevenue", "money"),
  ],
  categories: [
    c("name", "reports.col.category", "name"),
    c("qtySold", "reports.col.qtySold", "int"),
    c("qtyRefunded", "reports.col.qtyRefunded", "int"),
    c("grossMinor", "reports.col.sales", "money"),
    c("refundsMinor", "reports.col.refunds", "money"),
    c("netMinor", "reports.col.netRevenue", "money"),
  ],
  cashiers: [
    c("name", "reports.col.cashier", "text"),
    c("salesCount", "reports.col.salesCount", "int"),
    c("grossMinor", "reports.col.sales", "money"),
    c("averageMinor", "reports.col.average", "money"),
    c("refundsCount", "reports.col.refundsCount", "int"),
    c("refundsMinor", "reports.col.refunds", "money"),
  ],
  // Sales by customer (customers-spec CU15): walk-in sales are not a row.
  customers: [
    c("name", "reports.col.customer", "text"),
    c("phone", "reports.col.phone", "text"),
    c("salesCount", "reports.col.salesCount", "int"),
    c("grossMinor", "reports.col.sales", "money"),
    c("refundsCount", "reports.col.refundsCount", "int"),
    c("refundsMinor", "reports.col.refunds", "money"),
    c("netMinor", "reports.col.netAfterRefunds", "money"),
  ],
  shifts: [
    c("registerName", "reports.col.register", "text"),
    c("status", "reports.col.status", "status"),
    c("openedAt", "reports.col.openedAt", "datetime"),
    c("openedBy", "reports.col.openedBy", "text"),
    c("closedAt", "reports.col.closedAt", "datetime"),
    c("closedBy", "reports.col.closedBy", "text"),
    c("openingFloatMinor", "reports.col.openingFloat", "money"),
    c("cashSalesMinor", "reports.col.cashSales", "money"),
    c("payInMinor", "reports.col.payIn", "money"),
    c("payOutMinor", "reports.col.payOut", "money"),
    c("dropMinor", "reports.col.drops", "money"),
    c("cashRefundsMinor", "reports.col.cashRefunds", "money"),
    c("expectedCashMinor", "reports.col.expectedCash", "money"),
    c("countedCashMinor", "reports.col.countedCash", "money"),
    c("discrepancyMinor", "reports.col.discrepancy", "money"),
    // Offline sales replayed after the close, beside the stored figures (offline-till-spec OF13).
    c("lateOfflineSales", "reports.col.lateOfflineSales", "int"),
    c("lateOfflineCashMinor", "reports.col.lateOfflineCash", "money"),
    c("correctedExpectedCashMinor", "reports.col.correctedExpectedCash", "money"),
    c("discrepancyNote", "reports.col.note", "text"),
  ],
  "refunds-voids": [
    c("kind", "reports.col.kind", "kind"),
    c("at", "reports.col.time", "datetime"),
    c("saleNumber", "reports.col.saleNumber", "text"),
    c("totalMinor", "reports.col.amount", "money"),
    c("vatMinor", "reports.col.vat", "money"),
    c("method", "reports.col.method", "method"),
    c("reference", "reports.col.reference", "text"),
    c("reason", "reports.col.reason", "text"),
    c("byName", "reports.col.by", "text"),
    c("registerName", "reports.col.register", "text"),
  ],
  vat: [
    c("rateBp", "reports.col.rate", "rate"),
    c("netSalesMinor", "reports.col.netSales", "money"),
    c("vatSalesMinor", "reports.col.vatSales", "money"),
    c("netRefundsMinor", "reports.col.netRefunds", "money"),
    c("vatRefundsMinor", "reports.col.vatRefunds", "money"),
    c("netVatMinor", "reports.col.netVat", "money"),
  ],
  // Purchases received (T5 P5): cost values, so purchases.manage is needed too.
  purchases: [
    c("day", "reports.col.day", "day"),
    c("supplierName", "reports.col.supplier", "text"),
    c("receiptsCount", "reports.col.receipts", "int"),
    c("units", "reports.col.units", "int"),
    c("valueMinor", "reports.col.purchaseValue", "money"),
    // Returns to the supplier on their own date (purchase-returns-spec R12).
    c("returnedUnits", "reports.col.returnedUnits", "int"),
    c("returnedValueMinor", "reports.col.returnedValue", "money"),
    c("netValueMinor", "reports.col.netPurchaseValue", "money"),
  ],
  // Supplier balances (supplier-payments-spec S14): cost values, so purchases.manage is needed too.
  "supplier-balances": [
    c("supplierName", "reports.col.supplier", "text"),
    c("openingMinor", "reports.col.openingBalance", "money"),
    c("receivedMinor", "reports.col.purchaseValue", "money"),
    c("returnedMinor", "reports.col.returnedValue", "money"),
    // Invoices and credit notes beyond the cost they replace (supplier-invoices-spec I7).
    c("adjustedMinor", "reports.col.invoiceAdjustments", "money"),
    c("paidMinor", "reports.col.paid", "money"),
    c("closingMinor", "reports.col.closingBalance", "money"),
    c("uninvoicedMinor", "reports.col.uninvoicedReceipts", "money"),
  ],
  // Input VAT (supplier-invoices-spec I14), next to the output VAT of the same months.
  "input-vat": [
    c("month", "reports.col.month", "day"),
    c("invoicesCount", "reports.col.invoices", "int"),
    c("invoiceNetMinor", "reports.col.invoiceNet", "money"),
    c("invoiceVatMinor", "reports.col.invoiceVat", "money"),
    c("creditNetMinor", "reports.col.creditNoteNet", "money"),
    c("creditVatMinor", "reports.col.creditNoteVat", "money"),
    c("inputVatMinor", "reports.col.inputVat", "money"),
    c("outputVatMinor", "reports.col.outputVat", "money"),
    c("netVatMinor", "reports.col.netVatPayable", "money"),
  ],
  // Profit (P12 M8): cost values, so products.update is needed too (M7).
  "profit-products": [c("sku", "reports.col.sku", "text"), c("name", "reports.col.product", "name"), ...PROFIT_COLUMNS],
  "profit-categories": [c("name", "reports.col.category", "name"), ...PROFIT_COLUMNS],
  "profit-days": [
    c("day", "reports.col.day", "day"),
    ...PROFIT_COLUMNS,
    c("linesNoCost", "reports.col.linesNoCost", "int"),
  ],
};

export const PROFIT_REPORTS = ["profit-products", "profit-categories", "profit-days"] as const satisfies ReportName[];

export function isProfitReport(report: ReportName): boolean {
  return (PROFIT_REPORTS as readonly string[]).includes(report);
}

/**
 * Margin in basis points (2345 = 23.45%) of gross profit over the net revenue that has a cost
 * (M5). null when that revenue is not positive (nothing to divide by).
 */
export function marginBp(grossProfitMinor: number, revenueWithCostMinor: number): number | null {
  if (revenueWithCostMinor <= 0) return null;
  return Number(divideRoundHalfUp(BigInt(grossProfitMinor) * BigInt(10_000), BigInt(revenueWithCostMinor)));
}

/** 2345 → "23.5%", -500 → "-5.0%": one decimal, half away from zero. Integer math only. */
export function formatMarginBp(bp: number): string {
  const tenths = Number(divideRoundHalfUp(BigInt(bp), BigInt(10)));
  const abs = Math.abs(tenths);
  return `${tenths < 0 ? "-" : ""}${Math.trunc(abs / 10)}.${abs % 10}%`;
}

/** 1400 → "14%", 1250 → "12.5%". Integer math only. */
export function formatRateBp(rateBp: number): string {
  const whole = Math.trunc(rateBp / 100);
  const fraction = String(rateBp % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}

/** Money and count columns are totalled. Averages and floats are not simple sums. */
const NOT_TOTALLED = new Set(["averageMinor", "openingFloatMinor", "expectedCashMinor", "countedCashMinor"]);

export function totalledKeys(report: ReportName): string[] {
  return REPORT_COLUMNS[report]
    .filter((col) => (col.kind === "money" || col.kind === "int" || col.kind === "qty") && !NOT_TOTALLED.has(col.key))
    .map((col) => col.key);
}
