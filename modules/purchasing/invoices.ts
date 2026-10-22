import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { multiply, sum, type CurrencyCode } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { reportSettings } from "@/modules/reports";
import { todayIn } from "@/modules/reports/timezone";
import { requestHashOf } from "@/modules/sales";
import { requireAccountAccess, type Tx } from "./access";
import { purchasingConflict, purchasingInvalid } from "./errors";
import { formatDirectReceiptNumber, formatReturnNumber, invoiceState, maxInputVat, type InvoiceStatus } from "./rules";
import {
  AllocationInput,
  IdempotencyKey,
  InvoiceInput,
  Uuid,
  VoidInput,
  type AllocationLines,
  type SupplierDocumentKind,
  type SupplierPaymentMethod,
} from "./schemas";
import type { SupplierRow } from "./suppliers";

/**
 * Supplier invoices, credit notes and payment allocation (supplier-invoices-spec.md). Documents are
 * append-only and voided once (I6); allocations are append-only and stop counting when their payment
 * is reversed or their invoice voided (I9). Everything derived (open amounts, statuses, what is
 * uninvoiced) is computed from the rows by `loadAccount`, never stored. Writes for one supplier are
 * serialised by an advisory lock so the "one live invoice per receipt" and "≤ open" checks cannot race (I12).
 */

type Client = Db | Tx;

/** `purchaseOrderId` is null on a direct receipt (direct-receipt-spec D1). */
export type AccountReceipt = {
  id: string;
  at: Date;
  purchaseOrderId: string | null;
  number: string;
  valueMinor: number;
};
export type AccountReturn = AccountReceipt & { purchaseOrderId: string };

export type AccountPayment = {
  id: string;
  amountMinor: number;
  method: SupplierPaymentMethod;
  paidOn: string;
  reference: string | null;
  note: string | null;
  purchaseOrderId: string | null;
  poNumber: string | null;
  reversalOfId: string | null;
  createdAt: Date;
  /** A payment that already has its reversal. */
  reversed: boolean;
  /** What is left to allocate: 0 for a reversal or a reversed payment. */
  unallocatedMinor: number;
};

export type InvoiceRow = {
  id: string;
  kind: SupplierDocumentKind;
  number: string;
  issuedOn: string;
  dueOn: string | null;
  netMinor: number;
  vatMinor: number;
  totalMinor: number;
  note: string | null;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  goodsReceiptIds: string[];
  purchaseReturnId: string | null;
  appliesToInvoiceId: string | null;
  /** At-cost value of the receipts (or return) this document replaces on the balance (I7). */
  coveredMinor: number;
  /** Live allocations from payments that are not reversed. */
  paidMinor: number;
  /** Live credit notes naming this invoice. */
  creditedMinor: number;
  openMinor: number;
  status: InvoiceStatus;
};

export type SupplierAccount = {
  receipts: AccountReceipt[];
  returns: AccountReturn[];
  payments: AccountPayment[];
  invoices: InvoiceRow[];
};

export type SupplierInvoices = {
  currency: CurrencyCode;
  vatRateBp: number;
  today: string;
  invoices: InvoiceRow[];
  /** Receipts on no live invoice (I8). */
  uninvoicedReceipts: AccountReceipt[];
  /** Returns on no live credit note (I4). */
  uncreditedReturns: AccountReturn[];
  /** Payments with something left to allocate (I9). */
  unallocatedPayments: AccountPayment[];
};

export type InvoiceResult = { invoiceId: string; created: boolean };
export type AllocationResult = { paymentId: string; created: boolean };

const SUPPLIER_SELECT = { id: true, name: true, phone: true, email: true, taxNumber: true, isActive: true } as const;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function requireSupplier(db: Client, ctx: TenantContext, supplierId: string): Promise<SupplierRow> {
  const parsed = Uuid.safeParse(supplierId);
  const supplier = parsed.success
    ? await db.supplier.findFirst({ where: { id: parsed.data, orgId: ctx.orgId }, select: SUPPLIER_SELECT })
    : null;
  if (!supplier) throw notFound("Supplier");
  return supplier;
}

/** Serialises account writes for one supplier until the transaction ends (I12). */
async function lockSupplier(tx: Tx, supplierId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('supplier-account'), hashtext(${supplierId}))`;
}

function valueBy(items: readonly { parentId: string; qty: number; unitCostMinor: number }[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const item of items) {
    values.set(item.parentId, sum([values.get(item.parentId) ?? 0, multiply(item.unitCostMinor, item.qty)]));
  }
  return values;
}

/**
 * Every document of one supplier's account, with derived amounts. Flat queries one after another, so
 * it is safe on a transaction's single connection.
 * ponytail: reads the supplier's whole history; aggregate in SQL if a supplier outgrows it.
 */
export async function loadAccount(
  db: Client,
  orgId: string,
  supplierId: string,
  today: string,
): Promise<SupplierAccount> {
  const pos = await db.purchaseOrder.findMany({ where: { orgId, supplierId }, select: { id: true, number: true } });
  const poNumber = new Map(pos.map((po) => [po.id, po.number]));
  const poIds = pos.map((po) => po.id);

  // By supplier, not by PO: direct receipts count on the account too (direct-receipt-spec D6).
  const receiptRows = await db.goodsReceipt.findMany({
    where: { orgId, supplierId },
    select: { id: true, receivedAt: true, purchaseOrderId: true },
  });
  const receiptValue = valueBy(
    (
      await db.goodsReceiptItem.findMany({
        where: { orgId, goodsReceiptId: { in: receiptRows.map((r) => r.id) } },
        select: { goodsReceiptId: true, qtyReceived: true, unitCostMinor: true },
      })
    ).map((i) => ({ parentId: i.goodsReceiptId, qty: i.qtyReceived, unitCostMinor: i.unitCostMinor })),
  );
  const returnRows = await db.purchaseReturn.findMany({
    where: { orgId, purchaseOrderId: { in: poIds } },
    select: { id: true, seq: true, returnedAt: true, purchaseOrderId: true },
  });
  const returnValue = valueBy(
    (
      await db.purchaseReturnItem.findMany({
        where: { orgId, purchaseReturnId: { in: returnRows.map((r) => r.id) } },
        select: { purchaseReturnId: true, qty: true, unitCostMinor: true },
      })
    ).map((i) => ({ parentId: i.purchaseReturnId, qty: i.qty, unitCostMinor: i.unitCostMinor })),
  );
  const docs = await db.supplierInvoice.findMany({
    where: { orgId, supplierId },
    orderBy: [{ issuedOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const links = await db.supplierInvoiceReceipt.findMany({
    where: { orgId, invoiceId: { in: docs.map((d) => d.id) } },
    select: { invoiceId: true, goodsReceiptId: true },
  });
  const paymentRows = await db.supplierPayment.findMany({
    where: { orgId, supplierId },
    select: {
      id: true,
      amountMinor: true,
      method: true,
      paidOn: true,
      reference: true,
      note: true,
      purchaseOrderId: true,
      reversalOfId: true,
      createdAt: true,
    },
  });
  const allocations = await db.supplierPaymentAllocation.findMany({
    where: { orgId, paymentId: { in: paymentRows.map((p) => p.id) } },
    select: { paymentId: true, invoiceId: true, amountMinor: true },
  });

  const reversedIds = new Set(paymentRows.flatMap((p) => (p.reversalOfId ? [p.reversalOfId] : [])));
  const voidedIds = new Set(docs.filter((d) => d.voidedAt !== null).map((d) => d.id));
  const live = allocations.filter((a) => !reversedIds.has(a.paymentId) && !voidedIds.has(a.invoiceId));
  const total = (rows: readonly { amountMinor: number }[]) => sum(rows.map((row) => row.amountMinor));

  const invoices: InvoiceRow[] = docs.map((doc) => {
    const goodsReceiptIds = links.filter((l) => l.invoiceId === doc.id).map((l) => l.goodsReceiptId);
    const coveredMinor =
      doc.kind === "INVOICE"
        ? sum(goodsReceiptIds.map((id) => receiptValue.get(id) ?? 0))
        : doc.purchaseReturnId
          ? (returnValue.get(doc.purchaseReturnId) ?? 0)
          : 0;
    const paidMinor = total(live.filter((a) => a.invoiceId === doc.id));
    const creditedMinor = sum(
      docs.filter((c) => c.appliesToInvoiceId === doc.id && c.voidedAt === null).map((c) => c.totalMinor),
    );
    const dueOn = doc.dueOn ? dayOf(doc.dueOn) : null;
    const state =
      doc.kind === "INVOICE"
        ? invoiceState(
            { voided: doc.voidedAt !== null, totalMinor: doc.totalMinor, paidMinor, creditedMinor, dueOn },
            today,
          )
        : { openMinor: 0, status: doc.voidedAt ? ("VOID" as const) : ("PAID" as const) };
    return {
      id: doc.id,
      kind: doc.kind,
      number: doc.number,
      issuedOn: dayOf(doc.issuedOn),
      dueOn,
      netMinor: doc.netMinor,
      vatMinor: doc.vatMinor,
      totalMinor: doc.totalMinor,
      note: doc.note,
      createdAt: doc.createdAt,
      voidedAt: doc.voidedAt,
      voidReason: doc.voidReason,
      goodsReceiptIds,
      purchaseReturnId: doc.purchaseReturnId,
      appliesToInvoiceId: doc.appliesToInvoiceId,
      coveredMinor,
      paidMinor,
      creditedMinor,
      ...state,
    };
  });

  return {
    receipts: receiptRows.map((r) => ({
      id: r.id,
      at: r.receivedAt,
      purchaseOrderId: r.purchaseOrderId,
      number: r.purchaseOrderId ? (poNumber.get(r.purchaseOrderId) ?? "") : formatDirectReceiptNumber(r.id),
      valueMinor: receiptValue.get(r.id) ?? 0,
    })),
    returns: returnRows.map((r) => ({
      id: r.id,
      at: r.returnedAt,
      purchaseOrderId: r.purchaseOrderId,
      number: formatReturnNumber(poNumber.get(r.purchaseOrderId) ?? "", r.seq),
      valueMinor: returnValue.get(r.id) ?? 0,
    })),
    payments: paymentRows.map((p) => {
      const reversed = reversedIds.has(p.id);
      return {
        ...p,
        paidOn: dayOf(p.paidOn),
        poNumber: p.purchaseOrderId ? (poNumber.get(p.purchaseOrderId) ?? null) : null,
        reversed,
        unallocatedMinor:
          p.reversalOfId || reversed ? 0 : p.amountMinor - total(live.filter((a) => a.paymentId === p.id)),
      };
    }),
    invoices,
  };
}

function liveDocs(account: SupplierAccount) {
  return account.invoices.filter((doc) => doc.voidedAt === null);
}

function byTime<T extends { at: Date }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The supplier's documents with their state, and what is still open to invoice, credit or allocate. */
export async function listSupplierInvoices(ctx: TenantContext, supplierId: string): Promise<SupplierInvoices> {
  await requireAccountAccess(ctx, { operation: "supplier.invoice.list", write: false });
  const db = getDb();
  const supplier = await requireSupplier(db, ctx, supplierId);
  const { zone, currency } = await reportSettings(ctx.orgId);
  const today = todayIn(zone);
  const [account, org] = await Promise.all([
    loadAccount(db, ctx.orgId, supplier.id, today),
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { vatRateBp: true } }),
  ]);
  const invoiced = new Set(liveDocs(account).flatMap((doc) => doc.goodsReceiptIds));
  const credited = new Set(liveDocs(account).flatMap((doc) => (doc.purchaseReturnId ? [doc.purchaseReturnId] : [])));
  return {
    currency,
    vatRateBp: org.vatRateBp,
    today,
    invoices: [...account.invoices].reverse(),
    uninvoicedReceipts: byTime(account.receipts.filter((r) => !invoiced.has(r.id))),
    uncreditedReturns: byTime(account.returns.filter((r) => !credited.has(r.id))),
    unallocatedPayments: account.payments.filter((p) => p.unallocatedMinor > 0),
  };
}

/** Records an invoice or credit note (I1–I5). Idempotent on the key (I12). */
export async function recordSupplierInvoice(
  ctx: TenantContext,
  supplierId: string,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<InvoiceResult> {
  await requireAccountAccess(ctx, { operation: "supplier.invoice.record", write: true, meta });
  const parsed = InvoiceInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  const db = getDb();
  const supplier = await requireSupplier(db, ctx, supplierId);
  const goodsReceiptIds = [...new Set(parsed.goodsReceiptIds)].sort();
  const requestHash = requestHashOf({ supplierId: supplier.id, ...parsed, goodsReceiptIds });
  const replayed = await replayInvoice(db, ctx, idempotencyKey, requestHash);
  if (replayed) return replayed;

  const { zone } = await reportSettings(ctx.orgId);
  const today = todayIn(zone);
  if (parsed.issuedOn > today) {
    throw purchasingInvalid("INVOICE_DATE_IN_FUTURE", "A document cannot be dated in the future");
  }
  if (parsed.dueOn !== null && parsed.dueOn < parsed.issuedOn) {
    throw purchasingInvalid("DUE_BEFORE_ISSUE", "The due date is before the issue date");
  }
  const isInvoice = parsed.kind === "INVOICE";
  if (
    isInvoice
      ? parsed.purchaseReturnId !== null || parsed.appliesToInvoiceId !== null
      : parsed.dueOn !== null || goodsReceiptIds.length > 0
  ) {
    throw purchasingInvalid(
      "INVALID_DOCUMENT_LINK",
      "Invoices link receipts; credit notes link a return or an invoice",
    );
  }
  const totalMinor = parsed.netMinor + parsed.vatMinor;
  if (totalMinor <= 0) throw purchasingInvalid("TOTAL_NOT_POSITIVE", "The total must be above zero");
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { vatRateBp: true } });
  const maxVat = maxInputVat(parsed.netMinor, org.vatRateBp);
  if (parsed.vatMinor > maxVat) {
    throw purchasingInvalid("VAT_ABOVE_RATE", "VAT is above the shop rate on the net", { maxVatMinor: maxVat });
  }

  try {
    const invoiceId = await db.$transaction(async (tx) => {
      await lockSupplier(tx, supplier.id);
      const account = await loadAccount(tx, ctx.orgId, supplier.id, today);
      const live = liveDocs(account);
      const lower = parsed.number.toLowerCase();
      if (live.some((doc) => doc.kind === parsed.kind && doc.number.toLowerCase() === lower)) {
        throw purchasingConflict("INVOICE_NUMBER_TAKEN", "This supplier already has a document with this number");
      }
      const receiptIds = new Set(account.receipts.map((r) => r.id));
      const invoiced = new Set(live.flatMap((doc) => doc.goodsReceiptIds));
      for (const id of goodsReceiptIds) {
        if (!receiptIds.has(id)) throw notFound("Goods receipt");
        if (invoiced.has(id)) {
          throw purchasingConflict("RECEIPT_ALREADY_INVOICED", "A receipt is already on another invoice", {
            goodsReceiptId: id,
          });
        }
      }
      if (parsed.purchaseReturnId) {
        if (!account.returns.some((r) => r.id === parsed.purchaseReturnId)) throw notFound("Purchase return");
        if (live.some((doc) => doc.purchaseReturnId === parsed.purchaseReturnId)) {
          throw purchasingConflict("RETURN_ALREADY_CREDITED", "This return already has a credit note");
        }
      }
      if (parsed.appliesToInvoiceId) {
        const target = account.invoices.find((doc) => doc.id === parsed.appliesToInvoiceId && doc.kind === "INVOICE");
        if (!target) throw notFound("Supplier invoice");
        if (target.voidedAt) throw purchasingConflict("INVOICE_VOIDED", "This invoice is voided");
        if (totalMinor > target.openMinor) {
          throw purchasingConflict("AMOUNT_EXCEEDS_OPEN", "More than is open on the invoice", {
            openMinor: target.openMinor,
          });
        }
      }

      const doc = await tx.supplierInvoice.create({
        data: {
          orgId: ctx.orgId,
          supplierId: supplier.id,
          kind: parsed.kind,
          number: parsed.number,
          issuedOn: new Date(`${parsed.issuedOn}T00:00:00Z`),
          dueOn: parsed.dueOn ? new Date(`${parsed.dueOn}T00:00:00Z`) : null,
          netMinor: parsed.netMinor,
          vatMinor: parsed.vatMinor,
          totalMinor,
          note: parsed.note,
          purchaseReturnId: parsed.purchaseReturnId,
          appliesToInvoiceId: parsed.appliesToInvoiceId,
          idempotencyKey,
          requestHash,
          createdById: ctx.userId,
        },
        select: { id: true },
      });
      if (goodsReceiptIds.length > 0) {
        await tx.supplierInvoiceReceipt.createMany({
          data: goodsReceiptIds.map((goodsReceiptId) => ({ orgId: ctx.orgId, invoiceId: doc.id, goodsReceiptId })),
        });
      }
      await record(tx, {
        ctx,
        meta,
        action: "purchasing.supplier_invoice.recorded",
        entityType: "SupplierInvoice",
        entityId: doc.id,
        metadata: {
          supplierId: supplier.id,
          kind: parsed.kind,
          number: parsed.number,
          issuedOn: parsed.issuedOn,
          netMinor: parsed.netMinor,
          vatMinor: parsed.vatMinor,
          totalMinor,
          goodsReceiptIds,
          purchaseReturnId: parsed.purchaseReturnId,
          appliesToInvoiceId: parsed.appliesToInvoiceId,
        },
      });
      return doc.id;
    });
    return { invoiceId, created: true };
  } catch (err) {
    // A concurrent request with the same key won the unique index; our transaction rolled back.
    if (!isUniqueViolation(err)) throw err;
    const winner = await replayInvoice(db, ctx, idempotencyKey, requestHash);
    if (winner) return winner;
    throw purchasingConflict("INVOICE_NUMBER_TAKEN", "This supplier already has a document with this number");
  }
}

async function replayInvoice(
  db: Db,
  ctx: TenantContext,
  idempotencyKey: string,
  requestHash: string,
): Promise<InvoiceResult | null> {
  const existing = await db.supplierInvoice.findUnique({
    where: { orgId_idempotencyKey: { orgId: ctx.orgId, idempotencyKey } },
    select: { id: true, requestHash: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw purchasingConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different document");
  }
  return { invoiceId: existing.id, created: false };
}

/** Voids a document once (I6). Voiding it again changes nothing and answers the same. */
export async function voidSupplierInvoice(
  ctx: TenantContext,
  supplierId: string,
  invoiceId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<InvoiceResult> {
  await requireAccountAccess(ctx, { operation: "supplier.invoice.void", write: true, meta });
  const { reason } = VoidInput.parse(input);
  const db = getDb();
  const supplier = await requireSupplier(db, ctx, supplierId);
  const parsedId = Uuid.safeParse(invoiceId);
  const doc = parsedId.success
    ? await db.supplierInvoice.findFirst({
        where: { id: parsedId.data, orgId: ctx.orgId, supplierId: supplier.id },
        select: { id: true, kind: true, number: true, totalMinor: true, voidedAt: true },
      })
    : null;
  if (!doc) throw notFound("Supplier invoice");
  if (doc.voidedAt) return { invoiceId: doc.id, created: false };

  const voided = await db.$transaction(async (tx) => {
    const { count } = await tx.supplierInvoice.updateMany({
      where: { id: doc.id, orgId: ctx.orgId, voidedAt: null },
      data: { voidedAt: new Date(), voidedById: ctx.userId, voidReason: reason },
    });
    if (count === 0) return false;
    await record(tx, {
      ctx,
      meta,
      action: "purchasing.supplier_invoice.voided",
      entityType: "SupplierInvoice",
      entityId: doc.id,
      metadata: { supplierId: supplier.id, kind: doc.kind, number: doc.number, totalMinor: doc.totalMinor, reason },
    });
    return true;
  });
  return { invoiceId: doc.id, created: voided };
}

/**
 * Writes allocations of one payment inside the caller's transaction, after `lockSupplier` (I9):
 * each line ≤ its invoice's open amount, together ≤ `availableMinor`.
 */
async function writeAllocations(
  tx: Tx,
  ctx: TenantContext,
  account: SupplierAccount,
  paymentId: string,
  availableMinor: number,
  lines: AllocationLines,
  idempotencyKey: string,
  requestHash: string,
): Promise<void> {
  if (sum(lines.map((line) => line.amountMinor)) > availableMinor) {
    throw purchasingConflict("AMOUNT_EXCEEDS_UNALLOCATED", "More than is left on the payment", { availableMinor });
  }
  for (const line of lines) {
    const invoice = account.invoices.find((doc) => doc.id === line.invoiceId && doc.kind === "INVOICE");
    if (!invoice) throw notFound("Supplier invoice");
    if (invoice.voidedAt) throw purchasingConflict("INVOICE_VOIDED", "This invoice is voided");
    if (line.amountMinor > invoice.openMinor) {
      throw purchasingConflict("AMOUNT_EXCEEDS_OPEN", "More than is open on the invoice", {
        invoiceId: invoice.id,
        openMinor: invoice.openMinor,
      });
    }
  }
  await tx.supplierPaymentAllocation.createMany({
    data: lines.map((line) => ({
      orgId: ctx.orgId,
      paymentId,
      invoiceId: line.invoiceId,
      amountMinor: line.amountMinor,
      idempotencyKey,
      requestHash,
      createdById: ctx.userId,
    })),
  });
}

/** Locks the supplier and allocates a new payment's lines (used by recordSupplierPayment, I9). */
export async function allocateNewPayment(
  tx: Tx,
  ctx: TenantContext,
  supplierId: string,
  payment: { id: string; amountMinor: number },
  lines: AllocationLines,
  idempotencyKey: string,
  requestHash: string,
  today: string,
): Promise<void> {
  await lockSupplier(tx, supplierId);
  const account = await loadAccount(tx, ctx.orgId, supplierId, today);
  if (sum(lines.map((line) => line.amountMinor)) > payment.amountMinor) {
    throw purchasingInvalid("ALLOCATION_EXCEEDS_PAYMENT", "Allocations add up to more than the payment");
  }
  await writeAllocations(tx, ctx, account, payment.id, payment.amountMinor, lines, idempotencyKey, requestHash);
}

/** Allocates a payment's unallocated remainder to open invoices (I9). Idempotent on the key. */
export async function allocateSupplierPayment(
  ctx: TenantContext,
  supplierId: string,
  paymentId: string,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<AllocationResult> {
  await requireAccountAccess(ctx, { operation: "supplier.payment.allocate", write: true, meta });
  const { allocations } = AllocationInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  const db = getDb();
  const supplier = await requireSupplier(db, ctx, supplierId);
  const parsedId = Uuid.safeParse(paymentId);
  const payment = parsedId.success
    ? await db.supplierPayment.findFirst({
        where: { id: parsedId.data, orgId: ctx.orgId, supplierId: supplier.id },
        select: { id: true },
      })
    : null;
  if (!payment) throw notFound("Supplier payment");
  const requestHash = requestHashOf({ paymentId: payment.id, allocations });
  const replay = async () => {
    const existing = await db.supplierPaymentAllocation.findFirst({
      where: { orgId: ctx.orgId, idempotencyKey },
      select: { requestHash: true },
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw purchasingConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different allocation");
    }
    return { paymentId: payment.id, created: false };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  const { zone } = await reportSettings(ctx.orgId);
  try {
    await db.$transaction(async (tx) => {
      await lockSupplier(tx, supplier.id);
      const account = await loadAccount(tx, ctx.orgId, supplier.id, todayIn(zone));
      const current = account.payments.find((p) => p.id === payment.id);
      if (!current || current.reversalOfId) {
        throw purchasingConflict("PAYMENT_NOT_REVERSIBLE", "A reversal cannot be allocated");
      }
      if (current.reversed) throw purchasingConflict("PAYMENT_ALREADY_REVERSED", "This payment has been reversed");
      await writeAllocations(
        tx,
        ctx,
        account,
        payment.id,
        current.unallocatedMinor,
        allocations,
        idempotencyKey,
        requestHash,
      );
      await record(tx, {
        ctx,
        meta,
        action: "purchasing.supplier_payment.allocated",
        entityType: "SupplierPayment",
        entityId: payment.id,
        metadata: { supplierId: supplier.id, allocations },
      });
    });
    return { paymentId: payment.id, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await replay();
    if (winner) return winner;
    throw err;
  }
}
