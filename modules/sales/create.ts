import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { getSellableItems } from "@/modules/catalog";
import { recordMovements } from "@/modules/inventory";
import { requireBranch, requirePermission, requireRegister, isUniqueViolation } from "./access";
import { salesConflict } from "./errors";
import { IdempotencyKey, SaleInput } from "./schemas";
import { priceLine, settlePayments, totalsOf, type PricedLine } from "./totals";

/**
 * Creates a sale (T6, checkout-data-model-and-api.md). One transaction: lock the org counter,
 * check the open shift, price every line on the server, settle payments, write the stock
 * movements through the inventory seam, then write the sale, its snapshots and the audit row.
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
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) return replayed;

  try {
    return await db.$transaction((tx) => writeSale(tx, ctx, parsed, idempotencyKey, requestHash, meta));
  } catch (err) {
    // A concurrent request with the same key won the unique index. Our transaction rolled back.
    if (!isUniqueViolation(err)) throw err;
    const winner = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
    if (winner) return winner;
    throw err;
  }
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
  meta: AuditRequestMeta | undefined,
): Promise<CreateSaleResult> {
  await requireRegister(tx, ctx.orgId, input.branchId, input.registerId);
  const shift = await tx.registerShift.findFirst({
    where: { orgId: ctx.orgId, branchId: input.branchId, registerId: input.registerId, status: "OPEN" },
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
    }[]
  >`
    UPDATE "Organization" SET "lastSaleNo" = "lastSaleNo" + 1
    WHERE "id" = ${ctx.orgId}::uuid
    RETURNING "lastSaleNo", "currency"::text AS "currency", "vatRateBp", "pricesIncludeVat", "blockNegativeStock"`;

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
  await recordMovements(tx, ctx, {
    branchId: input.branchId,
    reason: "SALE",
    refType: "Sale",
    refId: saleId,
    policy: org.blockNegativeStock ? "block" : "allow",
    lines: lines.map((line) => ({ ref: line.ref, qty: line.qty })),
  });

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
    },
  });

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
