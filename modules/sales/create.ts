import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { hasPermission } from "@/lib/auth/permissions";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { QtyUnit } from "@/lib/quantity";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { getItemsForHistory, getSellableItems } from "@/modules/catalog";
import type { SellableItem } from "@/modules/catalog/schemas";
import { customerForSale, type CustomerSnapshot } from "@/modules/customers";
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
import { discountLimit, salesConflict } from "./errors";
import {
  archivedFlags,
  claimOfflineNumber,
  flagTimes,
  hashedBody,
  offlineCashierRole,
  offlineShift,
  priceOfflineSale,
  requireOfflineDevice,
  type OfflineFlags,
} from "./offline";
import { IdempotencyKey, SaleInput, type DiscountInput } from "./schemas";
import { overDiscountLimit, priceSale, settlePayments, type PricedSale, type ScaleLabelLine } from "./totals";
import { lineKeyOf, resolveOptions, type OptionSnapshot } from "./options";
import { NOTE_MAX } from "./schemas";

/**
 * Creates a sale (T6, checkout-data-model-and-api.md). One transaction: lock the org counter,
 * check the open shift, price every line on the server, settle payments, write the stock
 * movements through the inventory seam, then write the sale, its snapshots and the audit row.
 * A shop linked to the inventory system reserves in it before the transaction and fulfils after
 * commit instead of writing POS stock (integration spec I12; modules/integrations/inventory-sys/postings.ts).
 * A body with an `offline` block is a sale its device already made: recorded as sold, with review flags
 * (offline-till-spec OF11–OF13; ./offline.ts).
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
    discountMinor: number;
    vatRateBp: number;
    vatMinor: number;
    lineTotalMinor: number;
    /** Options as sold (restaurant-cafe-spec R7); `unitPriceMinor` includes them. */
    options: OptionSnapshot[];
    note: string | null;
  }[];
  payments: { method: string; amountMinor: number; reference: string | null }[];
  /** The customer as snapshotted on the sale; null for a walk-in (customers-spec CU8). */
  customer: { id: string; name: string; phone: string; taxNumber: string | null } | null;
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

type MergedLine = {
  ref: { productId: string; variantId: string | null };
  qty: number;
  discount: DiscountInput | null;
  /** Chosen option ids (restaurant-cafe-spec R7) and the line note (R8). */
  options: string[];
  note: string | null;
  /** Price labels (weighed-selling-spec W6); kept on a repeated item only when every copy has them. */
  labels?: ScaleLabelLine[];
};

/**
 * Groups repeated lines (a scanned twice) into one line, keeping first-seen order. Lines of one item with different
 * options or notes stay apart (restaurant-cafe-spec R9); a linked shop merges by item and joins the notes, since the
 * inventory system takes one line per item. A repeated item carrying a line discount is refused: which copy the
 * discount meant is unknown (discounts-spec DC12).
 */
function mergeLines(
  lines: {
    ref: { productId: string; variantId?: string | null };
    qty: number;
    discount?: DiscountInput;
    labels?: ScaleLabelLine[];
    options?: string[];
    note?: string;
  }[],
  byItemOnly = false,
): MergedLine[] {
  const merged = new Map<string, MergedLine>();
  for (const line of lines) {
    const ref = { productId: line.ref.productId, variantId: line.ref.variantId ?? null };
    const key = byItemOnly ? lineKeyOf(ref, [], null) : lineKeyOf(ref, line.options ?? [], line.note);
    const existing = merged.get(key);
    if (existing && (existing.discount || line.discount)) {
      throw new AppError("VALIDATION_FAILED", "An item with a line discount may appear only once", {
        reason: "DUPLICATE_DISCOUNTED_LINE",
        productId: line.ref.productId,
      });
    }
    if (existing) {
      existing.qty += line.qty;
      existing.labels = existing.labels && line.labels ? [...existing.labels, ...line.labels] : undefined;
      if (line.note && existing.note !== line.note) {
        existing.note = (existing.note ? `${existing.note}; ${line.note}` : line.note).slice(0, NOTE_MAX);
      }
    } else
      merged.set(key, {
        ref,
        qty: line.qty,
        discount: line.discount ?? null,
        options: line.options ?? [],
        note: line.note ?? null,
        ...(line.labels ? { labels: line.labels } : {}),
      });
  }
  return [...merged.values()];
}

type SaleSettings = { vatRateBp: number; pricesIncludeVat: boolean; maxCashierDiscountBp: number };

/**
 * Each item at its price with the line's options (restaurant-cafe-spec R7), and the options as the sale line keeps
 * them. 422 OPTIONS_INVALID when a line's options do not fit the item's groups.
 */
function withOptions<T extends SellableItem>(
  items: readonly T[],
  lines: readonly MergedLine[],
): { items: T[]; options: OptionSnapshot[][] } {
  const resolved = items.map((item, index) => resolveOptions(item, lines[index].options));
  return {
    items: items.map((item, index) => ({ ...item, unitPriceMinor: resolved[index].unitPriceMinor })),
    options: resolved.map((result) => result.snapshot),
  };
}

/** Stock moves once per item (R9): the quantities of its lines added up, in first-seen order. */
function stockLines(lines: readonly MergedLine[]): { ref: MergedLine["ref"]; qty: number }[] {
  const byRef = new Map<string, { ref: MergedLine["ref"]; qty: number }>();
  for (const line of lines) {
    const key = lineKeyOf(line.ref, [], null);
    const current = byRef.get(key);
    if (current) current.qty += line.qty;
    else byRef.set(key, { ref: line.ref, qty: line.qty });
  }
  return [...byRef.values()];
}

/** Prices the merged lines with their discounts and the sale discount (discounts-spec DC3–DC5). */
function priceCart(
  items: { unitPriceMinor: number; vatApplicable: boolean; unitType: QtyUnit }[],
  lines: MergedLine[],
  saleDiscount: DiscountInput | undefined,
  org: SaleSettings,
): PricedSale {
  return priceSale(
    items.map((item, index) => ({
      unitPriceMinor: item.unitPriceMinor,
      qty: lines[index].qty,
      vatApplicable: item.vatApplicable,
      unitType: item.unitType,
      discount: lines[index].discount,
      labels: lines[index].labels,
    })),
    saleDiscount,
    org.vatRateBp,
    org.pricesIncludeVat,
  );
}

/** Override discounts freely; apply within the shop's limit; anyone else may not discount (DC7–DC9). */
function requireDiscountAllowed(ctx: TenantContext, sale: PricedSale, org: SaleSettings): void {
  if (sale.discountMinor === 0 || hasPermission(ctx.role, "discounts.override")) return;
  if (!hasPermission(ctx.role, "discounts.apply")) throw discountLimit(0);
  if (overDiscountLimit(sale, org.maxCashierDiscountBp)) throw discountLimit(org.maxCashierDiscountBp);
}

function isDiscountDenied(err: unknown): err is AppError {
  return err instanceof AppError && (err.details as { reason?: unknown } | null)?.reason === "DISCOUNT_LIMIT";
}

export async function createSale(
  ctx: TenantContext,
  input: unknown,
  idempotencyKeyInput: unknown,
  meta?: AuditRequestMeta,
): Promise<CreateSaleResult> {
  await requirePermission(ctx, "sales.create", { operation: "sale.create", entityType: "Sale", meta });
  try {
    return await sell(ctx, input, idempotencyKeyInput, meta);
  } catch (err) {
    // The sale transaction rolled back, so the refused discount is audited on its own (DC9).
    if (isDiscountDenied(err)) {
      await record(getDb(), {
        ctx,
        meta,
        action: "sales.discount.denied",
        entityType: "Sale",
        metadata: { ...(err.details as Record<string, unknown>), request: SaleInput.safeParse(input).data ?? null },
      }).catch(() => undefined);
    }
    throw err;
  }
}

async function sell(
  ctx: TenantContext,
  input: unknown,
  idempotencyKeyInput: unknown,
  meta: AuditRequestMeta | undefined,
): Promise<CreateSaleResult> {
  const parsed = SaleInput.parse(input);
  const idempotencyKey = IdempotencyKey.parse(idempotencyKeyInput);
  await requireBranch(ctx, parsed.branchId);

  const requestHash = requestHashOf(hashedBody(parsed));
  const db = getDb();
  const linked = (await inventorySourceOf(ctx.orgId)) === "EXTERNAL";
  const replayed = await replayIfKnown(db, ctx, idempotencyKey, requestHash);
  if (replayed) {
    // A crash after commit may have left the fulfils unsent.
    if (linked) await postAfterCommit(ctx.orgId, [replayed.sale.id]);
    return replayed;
  }
  // A linked shop reserves every line in the inventory system first; it never sells offline (OF15).
  if (parsed.offline && linked) {
    throw new AppError("CONFLICT", "This shop cannot sell offline while linked to the inventory system", {
      reason: "OFFLINE_NOT_ALLOWED",
    });
  }

  // Checked before anything is held in the inventory system (customers-spec CU17).
  const customer = parsed.customerId ? await customerForSale(ctx, parsed.customerId, meta) : null;

  let held: HeldSale | null = null;
  if (linked) {
    // Refuse what the POS can refuse on its own before holding anything in the inventory system.
    await requireOpenShift(db, ctx, parsed.branchId, parsed.registerId);
    const lines = mergeLines(parsed.lines, true);
    const { items } = withOptions(
      await getSellableItems(
        db,
        ctx.orgId,
        lines.map((line) => line.ref),
      ),
      lines,
    );
    // The inventory system's quantities are not grams yet: a kg item synced before weighed selling is refused
    // here until the next sync marks it not sellable (weighed-selling-spec W11).
    const weighed = items.findIndex((item) => item.unitType === "KG");
    if (weighed >= 0) {
      throw new AppError("VALIDATION_FAILED", "This item cannot be sold", {
        reason: "ITEM_NOT_SELLABLE",
        index: weighed,
        cause: "UNIT",
        productId: items[weighed].productId,
      });
    }
    if (parsed.discount || lines.some((line) => line.discount)) {
      const org = await db.organization.findUniqueOrThrow({
        where: { id: ctx.orgId },
        select: { vatRateBp: true, pricesIncludeVat: true, maxCashierDiscountBp: true },
      });
      requireDiscountAllowed(ctx, priceCart(items, lines, parsed.discount, org), org);
    }
    held = await reserveSale(ctx.orgId, parsed.branchId, idempotencyKey, lines);
  }

  let result: CreateSaleResult;
  try {
    result = await db.$transaction((tx) =>
      writeSale(tx, ctx, parsed, idempotencyKey, requestHash, held, customer, meta),
    );
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
  customer: CustomerSnapshot | null,
  meta: AuditRequestMeta | undefined,
): Promise<CreateSaleResult> {
  await requireRegister(tx, ctx.orgId, input.branchId, input.registerId);
  const offline = input.offline ?? null;
  const receivedAt = new Date();
  const flags: OfflineFlags = new Map();
  let shiftId: string;
  if (offline) {
    // Device, series and the shift it was rung in (open or closed): offline-till-spec OF8, OF13, OF16.
    await requireOfflineDevice(tx, ctx.orgId, input.registerId, offline);
    await claimOfflineNumber(tx, ctx.orgId, input.registerId, offline.number);
    const shift = await offlineShift(tx, ctx.orgId, input.branchId, input.registerId, offline.shiftId);
    flagTimes(offline, shift, receivedAt, flags);
    shiftId = shift.id;
  } else {
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
    shiftId = shift.id;
  }

  // Takes the org row lock, bumps the sale counter and reads the org's sale settings. A rollback
  // gives the number back, so numbers have no gaps. An offline sale keeps its series number (OF8).
  const [org] = await tx.$queryRaw<
    {
      lastSaleNo: number;
      currency: string;
      vatRateBp: number;
      pricesIncludeVat: boolean;
      blockNegativeStock: boolean;
      maxCashierDiscountBp: number;
      linked: boolean;
    }[]
  >`
    UPDATE "Organization" SET "lastSaleNo" = "lastSaleNo" + ${offline ? 0 : 1}
    WHERE "id" = ${ctx.orgId}::uuid
    RETURNING "lastSaleNo", "currency"::text AS "currency", "vatRateBp", "pricesIncludeVat",
      "blockNegativeStock", "maxCashierDiscountBp", "inventorySource" = 'EXTERNAL' AS "linked"`;
  // The source cannot change with a shift open (setInventorySource); refuse rather than post wrong.
  if (org.linked !== (held !== null)) {
    throw new AppError("CONFLICT", "The shop's inventory source changed; try again", {
      reason: "INVENTORY_SOURCE_CHANGED",
    });
  }

  const lines = mergeLines(input.lines, org.linked);
  const refs = lines.map((line) => line.ref);
  let items: SellableItem[];
  let options: OptionSnapshot[][];
  let totals: PricedSale;
  if (offline) {
    // Archived items resolve too: they were sold before (or without knowing) the archive (OF13).
    const archived = await archivedFlags(tx, ctx.orgId, refs);
    let current: SellableItem[];
    ({ items: current, options } = withOptions(await getItemsForHistory(tx, ctx.orgId, refs), lines));
    if (archived.some(Boolean)) {
      flags.set("ITEM_ARCHIVED", { skus: current.filter((_, index) => archived[index]).map((item) => item.sku) });
    }
    const role = await offlineCashierRole(tx, ctx.orgId, offline.cashierId);
    ({ items, totals } = priceOfflineSale(current, lines, input, offline, org, role, flags));
  } else {
    ({ items, options } = withOptions(await getSellableItems(tx, ctx.orgId, refs), lines));
    totals = priceCart(items, lines, input.discount, org);
    requireDiscountAllowed(ctx, totals, org);
  }
  const priced = totals.lines;
  const settlement = settlePayments(totals.totalMinor, input.payments);

  const saleId = randomUUID();
  const saleItemIds = items.map(() => randomUUID());
  if (!held) {
    const after = await recordMovements(tx, ctx, {
      branchId: input.branchId,
      reason: "SALE",
      refType: "Sale",
      refId: saleId,
      // An offline sale already left the shop: it may take stock below zero (OF13).
      policy: org.blockNegativeStock && !offline ? "block" : "allow",
      allowArchived: offline !== null,
      lines: stockLines(lines),
    });
    const itemOf = (ref: MergedLine["ref"]) =>
      items[lines.findIndex((line) => lineKeyOf(line.ref, [], null) === lineKeyOf(ref, [], null))];
    const negative = after.flatMap((line) =>
      line.qty < 0 ? [{ sku: itemOf(line.ref).sku, qty: line.qty, unitType: itemOf(line.ref).unitType }] : [],
    );
    if (offline && negative.length > 0) flags.set("STOCK_NEGATIVE", { lines: negative });
  }

  const number = offline ? offline.number : String(org.lastSaleNo).padStart(6, "0");
  await tx.sale.create({
    data: {
      id: saleId,
      orgId: ctx.orgId,
      branchId: input.branchId,
      registerId: input.registerId,
      shiftId,
      cashierId: offline ? offline.cashierId : ctx.userId,
      ...(offline && { createdAt: new Date(offline.soldAt), receivedAt, offlineFlags: [...flags.keys()] }),
      number,
      idempotencyKey,
      requestHash,
      status: "COMPLETED",
      currency: org.currency as "EGP" | "SAR",
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      vatMinor: totals.vatMinor,
      totalMinor: totals.totalMinor,
      changeMinor: settlement.changeMinor,
      ...(customer && {
        customerId: customer.id,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerTaxNumber: customer.taxNumber,
      }),
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
      discountMinor: priced[index].discountMinor,
      vatRateBp: priced[index].vatRateBp,
      vatMinor: priced[index].vatMinor,
      lineTotalMinor: priced[index].lineTotalMinor,
      // Cost snapshot for profit reports (P12 M1); 0 means "never entered", stored as unknown (M2).
      unitCostMinor: item.costMinor > 0 ? item.costMinor : null,
      // Options as sold and the note (restaurant-cafe-spec R7, R8); `unitPriceMinor` includes the options.
      ...(options[index].length > 0 && { options: options[index] }),
      ...(lines[index].note && { note: lines[index].note }),
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
      ...(customer && { customerId: customer.id }),
      // What was asked for and what each line got (DC10).
      ...(totals.discountMinor > 0 && {
        discount: {
          totalMinor: totals.discountMinor,
          sale: input.discount ?? null,
          lines: items.flatMap((item, index) =>
            priced[index].discountMinor > 0
              ? [{ sku: item.sku, discount: lines[index].discount, discountMinor: priced[index].discountMinor }]
              : [],
          ),
        },
      }),
      ...(held && { inventoryReservationIds: held.lines.map((line) => line.reservationId) }),
      // The actor is whoever replayed it; the cashier is who rang it up (OF11).
      ...(offline && {
        offline: {
          deviceId: offline.deviceId,
          cashierId: offline.cashierId,
          soldAt: offline.soldAt,
          snapshotVersion: offline.snapshotVersion,
          flags: [...flags.keys()],
        },
      }),
    },
  });
  // One row per drift for the review list (OF12, OF13).
  for (const [flag, details] of flags) {
    await record(tx, {
      ctx,
      meta,
      action: "sale.offline.flagged",
      entityType: "Sale",
      entityId: saleId,
      metadata: { number, flag, ...details },
    });
  }
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
      discountMinor: item.discountMinor,
      vatRateBp: item.vatRateBp,
      vatMinor: item.vatMinor,
      lineTotalMinor: item.lineTotalMinor,
      options: (item.options as OptionSnapshot[] | null) ?? [],
      note: item.note,
    })),
    payments: sale.payments.map((payment) => ({
      method: payment.method,
      amountMinor: payment.amountMinor,
      reference: payment.reference,
    })),
    customer:
      sale.customerId && sale.customerName
        ? {
            id: sale.customerId,
            name: sale.customerName,
            phone: sale.customerPhone ?? "",
            taxNumber: sale.customerTaxNumber,
          }
        : null,
  };
}
