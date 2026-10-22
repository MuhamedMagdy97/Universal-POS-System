import { z } from "zod";
import { MAX_STORABLE_MINOR } from "@/lib/money";
import { ItemRefInput, MAX_QTY, Qty, Uuid } from "@/modules/inventory/schemas";
import { parseLocalDate } from "@/modules/reports/timezone";

/**
 * Purchasing input schemas (T5). Pure: client components import this file. Strict objects, so
 * org, status, numbers and received quantities never come from the client.
 * See docs/planning/phase-10/purchasing-data-model-and-api.md.
 */

export { IdempotencyKey } from "@/modules/sales/schemas";
export { Uuid, Qty };

export const MAX_PO_LINES = 200;
export const PO_PAGE_SIZE = 50;

const Note = z.string().trim().max(500);
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value));

export const UnitCost = z.number().int().min(0).max(MAX_STORABLE_MINOR);

// ---------- suppliers ----------

export const SupplierInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: OptionalText(40),
    email: z
      .union([z.literal(""), z.email().max(254)])
      .nullish()
      .transform((value) => (value ? value : null)),
    taxNumber: OptionalText(40),
  })
  .strict();
export type SupplierInput = z.infer<typeof SupplierInput>;

export const SupplierPatch = SupplierInput.partial().strict();
export type SupplierPatch = z.infer<typeof SupplierPatch>;

export const SupplierQuery = z
  .object({
    q: z.string().trim().max(120).optional(),
    includeArchived: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .strict();
export type SupplierQuery = z.infer<typeof SupplierQuery>;

// ---------- purchase orders ----------

export const PoLineInput = z.object({ ref: ItemRefInput, qty: Qty, unitCostMinor: UnitCost }).strict();
export type PoLineInput = z.infer<typeof PoLineInput>;

const PoLines = z.array(PoLineInput).min(1).max(MAX_PO_LINES);

export const PoInput = z
  .object({
    branchId: Uuid,
    supplierId: Uuid,
    note: OptionalText(500),
    lines: PoLines,
  })
  .strict();
export type PoInput = z.infer<typeof PoInput>;

/** Receiving without a PO (direct-receipt-spec D2): the same shape as a new PO, received at once. */
export const DirectReceiptInput = PoInput;
export type DirectReceiptInput = PoInput;

/** Lines, when given, replace every line (allowed only before the first receipt, P4). */
export const PoPatch = z
  .object({
    supplierId: Uuid.optional(),
    note: OptionalText(500).optional(),
    lines: PoLines.optional(),
  })
  .strict();
export type PoPatch = z.infer<typeof PoPatch>;

export const PO_STATUS_VALUES = ["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"] as const;
export type PoStatus = (typeof PO_STATUS_VALUES)[number];

/** `open` = ORDERED or PARTIALLY_RECEIVED (the list default). */
export const PO_STATUS_FILTERS = ["open", "all", ...PO_STATUS_VALUES] as const;
export type PoStatusFilter = (typeof PO_STATUS_FILTERS)[number];

export const PoQuery = z
  .object({
    status: z.enum(PO_STATUS_FILTERS).optional(),
    branchId: Uuid.optional(),
    supplierId: Uuid.optional(),
    q: z.string().trim().max(40).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export type PoQuery = z.infer<typeof PoQuery>;

export const CancelInput = z.object({ reason: OptionalText(500) }).strict();
export type CancelInput = z.infer<typeof CancelInput>;

export const CloseInput = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export type CloseInput = z.infer<typeof CloseInput>;

// ---------- receipts ----------

/** `qty` 0 skips a line; at least one line must be above 0 (P3). */
export const ReceiptLineInput = z
  .object({
    poItemId: Uuid,
    qty: z.number().int().min(0).max(MAX_QTY),
    unitCostMinor: UnitCost.optional(),
  })
  .strict();
export type ReceiptLineInput = z.infer<typeof ReceiptLineInput>;

export const ReceiptInput = z
  .object({
    lines: z.array(ReceiptLineInput).min(1).max(MAX_PO_LINES),
    note: Note.optional().transform((value) => (value ? value : null)),
  })
  .strict();
export type ReceiptInput = z.infer<typeof ReceiptInput>;

// ---------- returns (purchase-returns-spec) ----------

export const PURCHASE_RETURN_REASONS = ["DAMAGED", "DEFECTIVE", "WRONG_ITEM", "EXPIRED", "OTHER"] as const;
export type PurchaseReturnReason = (typeof PURCHASE_RETURN_REASONS)[number];

/** `qty` 0 skips a line; at least one line must be above 0 (R1). Cost always comes from the PO line (R4). */
export const ReturnLineInput = z.object({ poItemId: Uuid, qty: z.number().int().min(0).max(MAX_QTY) }).strict();
export type ReturnLineInput = z.infer<typeof ReturnLineInput>;

export const ReturnInput = z
  .object({
    reason: z.enum(PURCHASE_RETURN_REASONS),
    lines: z.array(ReturnLineInput).min(1).max(MAX_PO_LINES),
    note: Note.optional().transform((value) => (value ? value : null)),
  })
  .strict();
export type ReturnInput = z.infer<typeof ReturnInput>;

/** A return against a direct receipt (direct-receipt-returns-spec DR1): the same rules by receipt line. */
export const DirectReturnInput = z
  .object({
    reason: z.enum(PURCHASE_RETURN_REASONS),
    lines: z
      .array(z.object({ goodsReceiptItemId: Uuid, qty: z.number().int().min(0).max(MAX_QTY) }).strict())
      .min(1)
      .max(MAX_PO_LINES),
    note: Note.optional().transform((value) => (value ? value : null)),
  })
  .strict();
export type DirectReturnInput = z.infer<typeof DirectReturnInput>;

// ---------- supplier payments (supplier-payments-spec) ----------

export const SUPPLIER_PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "CARD", "CHEQUE", "OTHER"] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];

/** A real calendar day as `YYYY-MM-DD` (Arabic-Indic digits allowed). */
const LocalDay = z
  .string()
  .max(20)
  .transform((value, ctx) => {
    const day = parseLocalDate(value);
    if (day === null) ctx.addIssue({ code: "custom", message: "Dates must be YYYY-MM-DD" });
    return day ?? "";
  });

/** I9: one line per invoice, each above 0. */
export const AllocationLines = z
  .array(z.object({ invoiceId: Uuid, amountMinor: z.number().int().min(1).max(MAX_STORABLE_MINOR) }).strict())
  .max(MAX_PO_LINES)
  .refine((lines) => new Set(lines.map((line) => line.invoiceId)).size === lines.length, {
    message: "One line per invoice",
  });
export type AllocationLines = z.infer<typeof AllocationLines>;

/** S4, S5: amount above 0, the shop-local day it was paid, an optional PO for reference only. */
export const PaymentInput = z
  .object({
    amountMinor: z.number().int().min(1).max(MAX_STORABLE_MINOR),
    method: z.enum(SUPPLIER_PAYMENT_METHODS),
    paidOn: LocalDay,
    reference: OptionalText(80),
    note: OptionalText(500),
    purchaseOrderId: Uuid.nullish().transform((value) => value ?? null),
    // supplier-invoices-spec I9: optional, checked against open amounts by the service.
    allocations: AllocationLines.optional(),
  })
  .strict();
export type PaymentInput = z.infer<typeof PaymentInput>;

/** S9: a reversal always says why. */
export const ReversalInput = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export type ReversalInput = z.infer<typeof ReversalInput>;

export const StatementQuery = z
  .object({ from: z.string().max(20).optional(), to: z.string().max(20).optional() })
  .strict();
export type StatementQuery = z.infer<typeof StatementQuery>;

// ---------- supplier invoices (supplier-invoices-spec) ----------

export const SUPPLIER_DOCUMENT_KINDS = ["INVOICE", "CREDIT_NOTE"] as const;
export type SupplierDocumentKind = (typeof SUPPLIER_DOCUMENT_KINDS)[number];

const Amount = z.number().int().min(0).max(MAX_STORABLE_MINOR);

export const AllocationInput = z.object({ allocations: AllocationLines.refine((l) => l.length > 0) }).strict();
export type AllocationInput = z.infer<typeof AllocationInput>;

/** I1, I3, I4: kind-specific links are checked by the service (and a DB CHECK). */
export const InvoiceInput = z
  .object({
    kind: z.enum(SUPPLIER_DOCUMENT_KINDS),
    number: z.string().trim().min(1).max(40),
    issuedOn: LocalDay,
    dueOn: LocalDay.nullish().transform((value) => value || null),
    netMinor: Amount,
    vatMinor: Amount,
    note: OptionalText(500),
    goodsReceiptIds: z.array(Uuid).max(MAX_PO_LINES).optional().default([]),
    purchaseReturnId: Uuid.nullish().transform((value) => value ?? null),
    appliesToInvoiceId: Uuid.nullish().transform((value) => value ?? null),
  })
  .strict();
export type InvoiceInput = z.infer<typeof InvoiceInput>;

export const VoidInput = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export type VoidInput = z.infer<typeof VoidInput>;
