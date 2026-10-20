import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { multiply, sum, type CurrencyCode } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { reportSettings } from "@/modules/reports";
import { resolveRange, todayIn } from "@/modules/reports/timezone";
import { requestHashOf } from "@/modules/sales";
import { requireAccountAccess } from "./access";
import { purchasingConflict, purchasingInvalid } from "./errors";
import { formatReturnNumber, statementOf, type AccountEntry } from "./rules";
import {
  IdempotencyKey,
  PaymentInput,
  ReversalInput,
  StatementQuery,
  Uuid,
  type SupplierPaymentMethod,
} from "./schemas";
import type { SupplierRow } from "./suppliers";

/**
 * Supplier payments and balances (supplier-payments-spec.md). Payments are append-only: a mistake
 * is undone by a reversal row (S9). The balance is always computed from receipts, returns and
 * payments (S1), never stored. Back-office only: nothing here touches till cash or shifts (S7).
 */

export type PaymentResult = { paymentId: string; created: boolean };

export type StatementEntry = AccountEntry & {
  id: string;
  /** When it was recorded: orders entries within one day. */
  at: Date;
  /** PO number for a receipt or a linked payment, `PO-…-R1` for a return. */
  number: string | null;
  purchaseOrderId: string | null;
  method: SupplierPaymentMethod | null;
  reference: string | null;
  note: string | null;
  reversalOfId: string | null;
  /** A payment that already has its reversal. */
  reversed: boolean;
  balanceMinor: number;
};

export type SupplierStatement = {
  supplier: SupplierRow;
  currency: CurrencyCode;
  timezone: string;
  from: string;
  to: string;
  openingMinor: number;
  closingMinor: number;
  balanceMinor: number;
  entries: StatementEntry[];
};

const SUPPLIER_SELECT = { id: true, name: true, phone: true, email: true, taxNumber: true, isActive: true } as const;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function requireSupplier(db: Db, ctx: TenantContext, supplierId: string): Promise<SupplierRow> {
  const parsed = Uuid.safeParse(supplierId);
  const supplier = parsed.success
    ? await db.supplier.findFirst({ where: { id: parsed.data, orgId: ctx.orgId }, select: SUPPLIER_SELECT })
    : null;
  if (!supplier) throw notFound("Supplier");
  return supplier;
}

/** The supplier's statement for a local date range (S13); defaults to the whole of this month. */
export async function getSupplierStatement(
  ctx: TenantContext,
  supplierId: string,
  rawQuery: unknown = {},
): Promise<SupplierStatement> {
  await requireAccountAccess(ctx, { operation: "supplier.statement", write: false });
  const query = StatementQuery.parse(rawQuery);
  const db = getDb();
  const supplier = await requireSupplier(db, ctx, supplierId);
  const { zone, currency } = await reportSettings(ctx.orgId);
  const today = todayIn(zone);
  const range = resolveRange({ from: query.from ?? `${today.slice(0, 8)}01`, to: query.to ?? today }, zone);

  const scope = { orgId: ctx.orgId, purchaseOrder: { supplierId: supplier.id } };
  // ponytail: reads the supplier's whole history to get the opening balance; aggregate in SQL if a supplier outgrows it.
  const [receipts, returns, payments] = await Promise.all([
    db.goodsReceipt.findMany({
      where: scope,
      select: {
        id: true,
        receivedAt: true,
        purchaseOrder: { select: { id: true, number: true } },
        items: { select: { qtyReceived: true, unitCostMinor: true } },
      },
    }),
    db.purchaseReturn.findMany({
      where: scope,
      select: {
        id: true,
        seq: true,
        returnedAt: true,
        purchaseOrder: { select: { id: true, number: true } },
        items: { select: { qty: true, unitCostMinor: true } },
      },
    }),
    db.supplierPayment.findMany({
      where: { orgId: ctx.orgId, supplierId: supplier.id },
      select: {
        id: true,
        amountMinor: true,
        method: true,
        paidOn: true,
        reference: true,
        note: true,
        reversalOfId: true,
        createdAt: true,
        purchaseOrder: { select: { id: true, number: true } },
        reversedBy: { select: { id: true } },
      },
    }),
  ]);

  const none = { method: null, reference: null, note: null, reversalOfId: null, reversed: false };
  const all: Omit<StatementEntry, "balanceMinor">[] = [
    ...receipts.map((r) => ({
      ...none,
      kind: "RECEIPT" as const,
      id: r.id,
      at: r.receivedAt,
      day: todayIn(zone, r.receivedAt),
      amountMinor: sum(r.items.map((i) => multiply(i.unitCostMinor, i.qtyReceived))),
      number: r.purchaseOrder.number,
      purchaseOrderId: r.purchaseOrder.id,
    })),
    ...returns.map((r) => ({
      ...none,
      kind: "RETURN" as const,
      id: r.id,
      at: r.returnedAt,
      day: todayIn(zone, r.returnedAt),
      amountMinor: sum(r.items.map((i) => multiply(i.unitCostMinor, i.qty))),
      number: formatReturnNumber(r.purchaseOrder.number, r.seq),
      purchaseOrderId: r.purchaseOrder.id,
    })),
    ...payments.map((p) => ({
      kind: p.reversalOfId ? ("REVERSAL" as const) : ("PAYMENT" as const),
      id: p.id,
      at: p.createdAt,
      day: dayOf(p.paidOn),
      amountMinor: p.amountMinor,
      number: p.purchaseOrder?.number ?? null,
      purchaseOrderId: p.purchaseOrder?.id ?? null,
      method: p.method,
      reference: p.reference,
      note: p.note,
      reversalOfId: p.reversalOfId,
      reversed: p.reversedBy !== null,
    })),
  ].sort((a, b) => a.day.localeCompare(b.day) || a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));

  const statement = statementOf(all, range.from, range.to);
  return { supplier, currency, timezone: zone, ...range, ...statement };
}

/** Records a payment to the supplier (S4–S6, S8). Idempotent on the key. */
export async function recordSupplierPayment(
  ctx: TenantContext,
  supplierId: string,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<PaymentResult> {
  await requireAccountAccess(ctx, { operation: "supplier.payment.record", write: true, meta });
  const parsed = PaymentInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  const db = getDb();
  const supplier = await requireSupplier(db, ctx, supplierId);
  const requestHash = requestHashOf({ supplierId: supplier.id, ...parsed });
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) return replayed;

  const { zone } = await reportSettings(ctx.orgId);
  if (parsed.paidOn > todayIn(zone)) {
    throw purchasingInvalid("PAYMENT_DATE_IN_FUTURE", "A payment cannot be dated in the future");
  }
  if (parsed.purchaseOrderId) {
    const po = await db.purchaseOrder.findFirst({
      where: { id: parsed.purchaseOrderId, orgId: ctx.orgId, supplierId: supplier.id },
      select: { id: true },
    });
    if (!po) throw notFound("Purchase order");
  }

  try {
    const paymentId = await db.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.create({
        data: {
          orgId: ctx.orgId,
          supplierId: supplier.id,
          amountMinor: parsed.amountMinor,
          method: parsed.method,
          paidOn: new Date(`${parsed.paidOn}T00:00:00Z`),
          reference: parsed.reference,
          note: parsed.note,
          purchaseOrderId: parsed.purchaseOrderId,
          idempotencyKey,
          requestHash,
          createdById: ctx.userId,
        },
        select: { id: true },
      });
      await record(tx, {
        ctx,
        meta,
        action: "purchasing.supplier_payment.recorded",
        entityType: "SupplierPayment",
        entityId: payment.id,
        metadata: {
          supplierId: supplier.id,
          amountMinor: parsed.amountMinor,
          method: parsed.method,
          paidOn: parsed.paidOn,
          purchaseOrderId: parsed.purchaseOrderId,
        },
      });
      return payment.id;
    });
    return { paymentId, created: true };
  } catch (err) {
    // A concurrent request with the same key won the unique index; our transaction rolled back.
    if (!isUniqueViolation(err)) throw err;
    const winner = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
    if (winner) return winner;
    throw err;
  }
}

/** Cancels a payment with a reversal row dated today (S9). At most once; never a reversal of a reversal. */
export async function reverseSupplierPayment(
  ctx: TenantContext,
  supplierId: string,
  paymentId: string,
  idempotencyKeyInput: unknown,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<PaymentResult> {
  await requireAccountAccess(ctx, { operation: "supplier.payment.reverse", write: true, meta });
  const { reason } = ReversalInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  const db = getDb();
  const supplier = await requireSupplier(db, ctx, supplierId);
  const parsedId = Uuid.safeParse(paymentId);
  const original = parsedId.success
    ? await db.supplierPayment.findFirst({
        where: { id: parsedId.data, orgId: ctx.orgId, supplierId: supplier.id },
        select: {
          id: true,
          amountMinor: true,
          method: true,
          reference: true,
          purchaseOrderId: true,
          reversalOfId: true,
        },
      })
    : null;
  if (!original) throw notFound("Supplier payment");
  const requestHash = requestHashOf({ reversalOfId: original.id, reason });
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) return replayed;
  if (original.reversalOfId) {
    throw purchasingConflict("PAYMENT_NOT_REVERSIBLE", "A reversal cannot be reversed; record a new payment instead");
  }
  const alreadyReversed = () =>
    purchasingConflict("PAYMENT_ALREADY_REVERSED", "This payment has already been reversed");
  const existing = await db.supplierPayment.findUnique({
    where: { orgId_reversalOfId: { orgId: ctx.orgId, reversalOfId: original.id } },
    select: { id: true },
  });
  if (existing) throw alreadyReversed();

  const { zone } = await reportSettings(ctx.orgId);
  try {
    const reversalId = await db.$transaction(async (tx) => {
      const reversal = await tx.supplierPayment.create({
        data: {
          orgId: ctx.orgId,
          supplierId: supplier.id,
          amountMinor: original.amountMinor,
          method: original.method,
          paidOn: new Date(`${todayIn(zone)}T00:00:00Z`),
          reference: original.reference,
          note: reason,
          purchaseOrderId: original.purchaseOrderId,
          reversalOfId: original.id,
          idempotencyKey,
          requestHash,
          createdById: ctx.userId,
        },
        select: { id: true },
      });
      await record(tx, {
        ctx,
        meta,
        action: "purchasing.supplier_payment.reversed",
        entityType: "SupplierPayment",
        entityId: reversal.id,
        metadata: { supplierId: supplier.id, reversalOfId: original.id, amountMinor: original.amountMinor, reason },
      });
      return reversal.id;
    });
    return { paymentId: reversalId, created: true };
  } catch (err) {
    // Same key raced us (replay), or another key reversed it first (unique reversalOfId).
    if (!isUniqueViolation(err)) throw err;
    const winner = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
    if (winner) return winner;
    throw alreadyReversed();
  }
}

async function replayIfKnown(
  db: Db,
  ctx: TenantContext,
  idempotencyKey: string,
  requestHash: string,
): Promise<PaymentResult | null> {
  const existing = await db.supplierPayment.findUnique({
    where: { orgId_idempotencyKey: { orgId: ctx.orgId, idempotencyKey } },
    select: { id: true, requestHash: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw purchasingConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different payment");
  }
  return { paymentId: existing.id, created: false };
}
