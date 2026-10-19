import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { getSellableItems } from "@/modules/catalog";
import { recordMovements } from "@/modules/inventory";
import {
  postAfterCommit,
  recordSaleFulfils,
  releaseSale,
  reserveSale,
  type HeldSale,
} from "@/modules/integrations/inventory-sys/postings";
import { inventorySourceOf } from "@/modules/integrations/inventory-sys/source";
import { lockShift } from "@/modules/registers";
import { requireBranch, requirePermission, requireRegister, isUniqueViolation } from "./access";
import { salesConflict } from "./errors";
import { IdempotencyKey, SaleInput } from "./schemas";
import { priceLine, settlePayments, totalsOf, type PricedLine } from "./totals";

/**
 * Creates a sale (T6, checkout-data-model-and-api.md). One transaction: lock the org counter,
 * check the open shift, price every line on the server, settle payments, write the stock
 * movements through the inventory seam, then write the sale, its snapshots and the audit row.
 * A shop linked to the inventory system reserves in it before the transaction and fulfils after
 * commit instead of writing POS stock (integration spec I12; modules/integrations/inventory-sys/postings.ts).
 */

type Tx = Prisma.TransactionClient;

export type SaleDetail = {
  id: string;
  number: string;
  branchId: string;
  registerId: string;
  shiftId: string;
  status: "COMPLETED" | "VOIDED";
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  vatMinor: number;
  totalMinor: number;
  changeMinor: number;
  createdAt: string;
  lines: {
    productId: string;
    variantId: string | null;
    sku: string;
    name: string;
    nameAr: string | null;
    unitType: string;
    qty: number;
    unitPriceMinor: number;
    vatRateBp: number;
    vatMinor: number;
    lineTotalMinor: number;
  }[];
  payments: { method: string; amountMinor: number; reference: string | null }[];
};

export type CreateSaleResult = { sale: SaleDetail; created: boolean };

/** Hash of the canonical body: keys sorted, so the same sale always hashes the same. */
export function requestHashOf(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Groups repeated refs (a scanned twice) into one line, keeping first-seen order. */
function mergeLines(lines: { ref: { productId: string; variantId: string | null }; qty: number }[]) {
  const merged = new Map<string, { ref: { productId: string; variantId: string | null }; qty: number }>();
  for (const line of lines) {
    const key = `${line.ref.productId}|${line.ref.variantId ?? ""}`;
    const existing = merged.get(key);
    if (existing) existing.qty += line.qty;
    else
      merged.set(key, { ref: { productId: line.ref.productId, variantId: line.ref.variantId ?? null }, qty: line.qty });
  }
  return [...merged.values()];
}

export async function createSale(
  ctx: TenantContext,
  input: unknown,
  idempotencyKeyInput: unknown,
  meta?: AuditRequestMeta,
): Promise<CreateSaleResult> {
  await requirePermission(ctx, "sales.create", { operation: "sale.create", entityType: "Sale", meta });
  const parsed = SaleInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  await requireBranch(ctx, parsed.branchId);

  const requestHash = requestHashOf(parsed);
  const db = getDb();
  const linked = (await inventorySourceOf(ctx.orgId)) === "EXTERNAL";
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) {
    // A crash after commit may have left the fulfils unsent.
    if (linked) await postAfterCommit(ctx.orgId, [replayed.sale.id]);
    return replayed;
  }

  let held: HeldSale | null = null;
  if (linked) {
    // Refuse what the POS can refuse on its own before holding anything in the inventory system.
    await requireOpenShift(db, ctx, parsed.branchId, parsed.registerId);
    const lines = mergeLines(parsed.lines);
    await getSellableItems(
      db,
      ctx.orgId,
      lines.map((line) => line.ref),
    );
    held = await reserveSale(ctx.orgId, parsed.branchId, idempotencyKey, lines);
  }

  let result: CreateSaleResult;
  try {
    result = await db.$transaction((tx) => writeSale(tx, ctx, parsed, idempotencyKey, requestHash, held, meta));
  } catch (err) {
    // A concurrent request with the same key won the unique index. Our transaction rolled back.
    if (isUniqueViolation(err)) {
      const winner = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
      if (winner) return winner;
      throw err;
    }
    if (held) {
      // One that committed while we failed holds the same reservations: keep them.
      const winner = await replayIfKnown(db, ctx, idempotencyKey, requestHash).catch(() => null);
      if (winner) return winner;
      await releaseSale(held);
    }
    throw err;
  }
  if (held) await postAfterCommit(ctx.orgId, [result.sale.id]);
  return result;
}

async function requireOpenShift(db: Db, ctx: TenantContext, branchId: string, registerId: string): Promise<void> {
  const open = await db.registerShift.findFirst({
    where: { orgId: ctx.orgId, branchId, registerId, status: "OPEN" },
    select: { id: true },
  });
  if (!open) throw salesConflict("SHIFT_NOT_OPEN", "Open a shift on this register before selling");
}

async function replayIfKnown(
  db: Db,
  ctx: TenantContext,
  idempotencyKey: string,
  requestHash: string,
): Promise<CreateSaleResult | null> {
  const existing = await db.sale.findUnique({
    where: { orgId_idempotencyKey: { orgId: ctx.orgId, idempotencyKey } },
    select: { id: true, requestHash: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw salesConflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was used for a different sale");
  }
  return { sale: await loadSale(db, ctx.orgId, existing.id), created: false };
}

async function writeSale(
  tx: Tx,
  ctx: TenantContext,
  input: ReturnType<typeof SaleInput.parse>,
  idempotencyKey: string,
  requestHash: string,
  held: HeldSale | null,
  meta: AuditRequestMeta | undefined,
): Promise<CreateSaleResult> {
  await requireRegister(tx, ctx.orgId, input.branchId, input.registerId);
  // Lock the shift, then re-read its status: a close that committed while we waited must refuse
  // this sale (T7 spec S4).
  const open = await tx.registerShift.findFirst({
    where: { orgId: ctx.orgId, branchId: input.branchId, registerId: input.registerId, status: "OPEN" },
    select: { id: true },
  });
  if (!open) throw salesConflict("SHIFT_NOT_OPEN", "Open a shift on this register before selling");
  await lockShift(tx, ctx.orgId, open.id);
  const shift = await tx.registerShift.findFirst({
    where: { id: open.id, orgId: ctx.orgId, status: "OPEN" },
    select: { id: true },
  });
  if (!shift) throw salesConflict("SHIFT_NOT_OPEN", "Open a shift on this register before selling");

  // Takes the org row lock, bumps the sale counter and reads the org's sale settings. A rollback
  // gives the number back, so numbers have no gaps.
  const [org] = await tx.$queryRaw<
    {
      lastSaleNo: number;
      currency: string;
      vatRateBp: number;
      pricesIncludeVat: boolean;
      blockNegativeStock: boolean;
      linked: boolean;
    }[]
  >`
    UPDATE "Organization" SET "lastSaleNo" = "lastSaleNo" + 1
    WHERE "id" = ${ctx.orgId}::uuid
    RETURNING "lastSaleNo", "currency"::text AS "currency", "vatRateBp", "pricesIncludeVat",
      "blockNegativeStock", "inventorySource" = 'EXTERNAL' AS "linked"`;
  // The source cannot change with a shift open (setInventorySource); refuse rather than post wrong.
  if (org.linked !== (held !== null)) {
    throw new AppError("CONFLICT", "The shop's inventory source changed; try again", {
      reason: "INVENTORY_SOURCE_CHANGED",
    });
  }

  const lines = mergeLines(input.lines);
  const items = await getSellableItems(
    tx,
    ctx.orgId,
    lines.map((line) => line.ref),
  );
  const priced: PricedLine[] = items.map((item, index) =>
    priceLine(
      { unitPriceMinor: item.unitPriceMinor, qty: lines[index].qty, vatApplicable: item.vatApplicable },
      org.vatRateBp,
      org.pricesIncludeVat,
    ),
  );
  const totals = totalsOf(priced);
  const settlement = settlePayments(totals.totalMinor, input.payments);

  const saleId = randomUUID();
  const saleItemIds = items.map(() => randomUUID());
  if (!held) {
    await recordMovements(tx, ctx, {
      branchId: input.branchId,
      reason: "SALE",
      refType: "Sale",
      refId: saleId,
      policy: org.blockNegativeStock ? "block" : "allow",
      lines: lines.map((line) => ({ ref: line.ref, qty: line.qty })),
    });
  }

  const number = String(org.lastSaleNo).padStart(6, "0");
  await tx.sale.create({
    data: {
      id: saleId,
      orgId: ctx.orgId,
      branchId: input.branchId,
      registerId: input.registerId,
      shiftId: shift.id,
      cashierId: ctx.userId,
      number,
      idempotencyKey,
      requestHash,
      status: "COMPLETED",
      currency: org.currency as "EGP" | "SAR",
      subtotalMinor: totals.subtotalMinor,
      discountMinor: 0,
      vatMinor: totals.vatMinor,
      totalMinor: totals.totalMinor,
      changeMinor: settlement.changeMinor,
    },
  });
  await tx.saleItem.createMany({
    data: items.map((item, index) => ({
      id: saleItemIds[index],
      orgId: ctx.orgId,
      saleId,
      productId: item.productId,
      variantId: item.variantId,
      skuSnapshot: item.sku,
      nameSnapshot: item.name,
      nameArSnapshot: item.nameAr,
      unitType: item.unitType,
      qty: lines[index].qty,
      unitPriceMinor: item.unitPriceMinor,
      discountMinor: 0,
      vatRateBp: priced[index].vatRateBp,
      vatMinor: priced[index].vatMinor,
      lineTotalMinor: priced[index].lineTotalMinor,
      // Cost snapshot for profit reports (P12 M1); 0 means "never entered", stored as unknown (M2).
      unitCostMinor: item.costMinor > 0 ? item.costMinor : null,
    })),
  });
  await tx.payment.createMany({
    data: settlement.payments.map((payment) => ({
      orgId: ctx.orgId,
      saleId,
      method: payment.method,
      amountMinor: payment.amountMinor,
      reference: payment.reference,
    })),
  });

  await record(tx, {
    ctx,
    meta,
    action: "sale.created",
    entityType: "Sale",
    entityId: saleId,
    metadata: {
      number,
      totalMinor: totals.totalMinor,
      changeMinor: settlement.changeMinor,
      lineCount: items.length,
      paymentMethods: settlement.payments.map((payment) => payment.method),
      ...(held && { inventoryReservationIds: held.lines.map((line) => line.reservationId) }),
    },
  });
  if (held) await recordSaleFulfils(tx, held, saleId, saleItemIds);

  return { sale: await loadSale(tx, ctx.orgId, saleId), created: true };
}

/** A sale as the API returns it: totals, snapshots and payments. No cost, no stock figures. */
export async function loadSale(client: Db | Tx, orgId: string, saleId: string): Promise<SaleDetail> {
  const sale = await client.sale.findFirstOrThrow({
    where: { id: saleId, orgId },
    include: { items: { orderBy: { id: "asc" } }, payments: { orderBy: { id: "asc" } } },
  });
  return {
    id: sale.id,
    number: sale.number,
    branchId: sale.branchId,
    registerId: sale.registerId,
    shiftId: sale.shiftId,
    status: sale.status,
    currency: sale.currency,
    subtotalMinor: sale.subtotalMinor,
    discountMinor: sale.discountMinor,
    vatMinor: sale.vatMinor,
    totalMinor: sale.totalMinor,
    changeMinor: sale.changeMinor,
    createdAt: sale.createdAt.toISOString(),
    lines: sale.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      sku: item.skuSnapshot,
      name: item.nameSnapshot,
      nameAr: item.nameArSnapshot,
      unitType: item.unitType,
      qty: item.qty,
      unitPriceMinor: item.unitPriceMinor,
      vatRateBp: item.vatRateBp,
      vatMinor: item.vatMinor,
      lineTotalMinor: item.lineTotalMinor,
    })),
    payments: sale.payments.map((payment) => ({
      method: payment.method,
      amountMinor: payment.amountMinor,
      reference: payment.reference,
    })),
  };
}
