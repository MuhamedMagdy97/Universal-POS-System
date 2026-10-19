import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { MoneyError, multiply, type CurrencyCode } from "@/lib/money";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { getSellableItems, itemNames } from "@/modules/catalog";
import { branchIdsInScope, requirePermission, VIEW, type Tx } from "./access";
import { purchasingConflict, purchasingInvalid } from "./errors";
import {
  canCancel,
  canClose,
  canEdit,
  canOrder,
  formatPoNumber,
  mergePoLines,
  formatReturnNumber,
  outstanding,
  poTotals,
  returnable,
  type PoTotals,
} from "./rules";
import {
  CancelInput,
  CloseInput,
  PO_PAGE_SIZE,
  PoInput,
  PoPatch,
  PoQuery,
  Uuid,
  type PoLineInput,
  type PoStatus,
  type PurchaseReturnReason,
} from "./schemas";

/**
 * Purchase orders (T5): create, edit, order, cancel, close short, list, read. Every write locks the
 * PO row and re-reads it under the lock (P11). See purchasing-data-model-and-api.md §3.
 */

export type PoLine = {
  id: string;
  productId: string;
  variantId: string | null;
  sku: string;
  name: string;
  nameAr: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  outstanding: number;
  qtyReturned: number;
  returnable: number;
  unitCostMinor: number;
  lineTotalMinor: number;
};

export type PoReceipt = {
  id: string;
  receivedAt: string;
  receivedByName: string;
  note: string | null;
  units: number;
  valueMinor: number;
};

export type PoReturn = {
  id: string;
  number: string;
  returnedAt: string;
  returnedByName: string;
  reason: PurchaseReturnReason;
  note: string | null;
  units: number;
  valueMinor: number;
};

export type PoDetail = {
  id: string;
  number: string;
  status: PoStatus;
  currency: CurrencyCode;
  branch: { id: string; name: string };
  supplier: { id: string; name: string; isActive: boolean; phone: string | null; taxNumber: string | null };
  note: string | null;
  closeReason: string | null;
  createdAt: string;
  updatedAt: string;
  orderedAt: string | null;
  closedAt: string | null;
  lines: PoLine[];
  receipts: PoReceipt[];
  returns: PoReturn[];
  totals: PoTotals;
};

export type PoSummary = {
  id: string;
  number: string;
  status: PoStatus;
  branch: { id: string; name: string };
  supplier: { id: string; name: string };
  createdAt: string;
  orderedAt: string | null;
  totals: PoTotals;
};

export type PoPage = { rows: PoSummary[]; nextCursor: string | null; currency: CurrencyCode };

function parseId(id: string): string {
  const parsed = Uuid.safeParse(id);
  if (!parsed.success) throw notFound("Purchase order");
  return parsed.data;
}

/** Locks the PO row and returns its state, or 404 when it is not this org's or not in the caller's scope. */
export async function lockPo(tx: Tx, ctx: TenantContext, poId: string) {
  await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "orgId" = ${ctx.orgId}::uuid AND "id" = ${poId}::uuid FOR UPDATE`;
  const po = await tx.purchaseOrder.findFirst({
    where: { id: poId, orgId: ctx.orgId },
    select: {
      id: true,
      number: true,
      status: true,
      branchId: true,
      supplierId: true,
      items: {
        select: {
          id: true,
          productId: true,
          variantId: true,
          qtyOrdered: true,
          qtyReceived: true,
          qtyReturned: true,
          unitCostMinor: true,
        },
      },
    },
  });
  if (!po || !(await branchIdsInScope(ctx)).includes(po.branchId)) throw notFound("Purchase order");
  const receivedUnits = po.items.reduce((total, item) => total + item.qtyReceived, 0);
  return { ...po, receivedUnits };
}

async function requireActiveSupplier(tx: Tx, orgId: string, supplierId: string): Promise<void> {
  const supplier = await tx.supplier.findFirst({ where: { id: supplierId, orgId }, select: { isActive: true } });
  if (!supplier) throw notFound("Supplier");
  if (!supplier.isActive) throw purchasingConflict("SUPPLIER_INACTIVE", "This supplier is archived");
}

/** Merges the lines, checks every item is stockable now (P8) and the PO value fits (2^53). */
async function prepareLines(tx: Tx, orgId: string, input: readonly PoLineInput[]): Promise<PoLineInput[]> {
  const lines = mergePoLines(input);
  await getSellableItems(
    tx,
    orgId,
    lines.map((line) => line.ref),
  );
  try {
    poTotals(lines.map((line) => ({ qtyOrdered: line.qty, qtyReceived: 0, unitCostMinor: line.unitCostMinor })));
  } catch (err) {
    if (err instanceof MoneyError) throw purchasingInvalid("AMOUNT_TOO_LARGE", "The purchase order total is too large");
    throw err;
  }
  return lines;
}

function lineRows(orgId: string, purchaseOrderId: string, lines: readonly PoLineInput[]) {
  return lines.map((line) => ({
    orgId,
    purchaseOrderId,
    productId: line.ref.productId,
    variantId: line.ref.variantId,
    qtyOrdered: line.qty,
    unitCostMinor: line.unitCostMinor,
  }));
}

// ---------- create / edit ----------

export async function createPurchaseOrder(
  ctx: TenantContext,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<PoDetail> {
  await requirePermission(ctx, "purchases.manage", { operation: "po.create", entityType: "PurchaseOrder", meta });
  const parsed = PoInput.parse(input);
  if (!(await branchIdsInScope(ctx)).includes(parsed.branchId)) throw notFound("Branch");

  const savedId = await getDb().$transaction(async (tx) => {
    await requireActiveSupplier(tx, ctx.orgId, parsed.supplierId);
    const lines = await prepareLines(tx, ctx.orgId, parsed.lines);
    // Org row lock + counter bump: numbers are gap-free because a rollback gives the number back (P7).
    const [org] = await tx.$queryRaw<{ lastPoNo: number }[]>`
      UPDATE "Organization" SET "lastPoNo" = "lastPoNo" + 1 WHERE "id" = ${ctx.orgId}::uuid RETURNING "lastPoNo"`;
    const po = await tx.purchaseOrder.create({
      data: {
        orgId: ctx.orgId,
        branchId: parsed.branchId,
        supplierId: parsed.supplierId,
        number: formatPoNumber(org.lastPoNo),
        status: "DRAFT",
        createdById: ctx.userId,
        note: parsed.note,
      },
      select: { id: true, number: true },
    });
    await tx.pOItem.createMany({ data: lineRows(ctx.orgId, po.id, lines) });
    await record(tx, {
      ctx,
      meta,
      action: "purchasing.po.created",
      entityType: "PurchaseOrder",
      entityId: po.id,
      metadata: {
        number: po.number,
        branchId: parsed.branchId,
        supplierId: parsed.supplierId,
        lineCount: lines.length,
      },
    });
    return po.id;
  });
  // Read after commit: nested includes inside a transaction run concurrently on its one connection.
  return loadPurchaseOrder(getDb(), ctx.orgId, savedId);
}

export async function updatePurchaseOrder(
  ctx: TenantContext,
  poId: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<PoDetail> {
  await requirePermission(ctx, "purchases.manage", { operation: "po.update", entityType: "PurchaseOrder", meta });
  const id = parseId(poId);
  const patch = PoPatch.parse(input);

  const savedId = await getDb().$transaction(async (tx) => {
    const po = await lockPo(tx, ctx, id);
    if (!canEdit(po)) {
      throw purchasingConflict("PO_NOT_EDITABLE", "This purchase order can no longer be edited", { status: po.status });
    }
    const fields: string[] = [];
    const data: Prisma.PurchaseOrderUncheckedUpdateInput = {};
    if (patch.supplierId !== undefined && patch.supplierId !== po.supplierId) {
      await requireActiveSupplier(tx, ctx.orgId, patch.supplierId);
      data.supplierId = patch.supplierId;
      fields.push("supplierId");
    }
    if (patch.note !== undefined) {
      data.note = patch.note;
      fields.push("note");
    }
    if (patch.lines !== undefined) {
      const lines = await prepareLines(tx, ctx.orgId, patch.lines);
      // Nothing has been received (canEdit), so no receipt line points at these rows.
      await tx.pOItem.deleteMany({ where: { orgId: ctx.orgId, purchaseOrderId: id } });
      await tx.pOItem.createMany({ data: lineRows(ctx.orgId, id, lines) });
      fields.push("lines");
    }
    if (fields.length > 0) {
      await tx.purchaseOrder.update({ where: { id }, data: { ...data, updatedAt: new Date() } });
      await record(tx, {
        ctx,
        meta,
        action: "purchasing.po.updated",
        entityType: "PurchaseOrder",
        entityId: id,
        metadata: { number: po.number, fields },
      });
    }
    return id;
  });
  return loadPurchaseOrder(getDb(), ctx.orgId, savedId);
}

// ---------- transitions ----------

type Transition = "order" | "cancel" | "close";

async function transition(
  ctx: TenantContext,
  poId: string,
  kind: Transition,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<PoDetail> {
  await requirePermission(ctx, "purchases.manage", { operation: `po.${kind}`, entityType: "PurchaseOrder", meta });
  const id = parseId(poId);
  const reason =
    kind === "close"
      ? CloseInput.parse(input).reason
      : kind === "cancel"
        ? CancelInput.parse(input ?? {}).reason
        : null;

  const savedId = await getDb().$transaction(async (tx) => {
    const po = await lockPo(tx, ctx, id);
    const allowed = kind === "order" ? canOrder(po) : kind === "cancel" ? canCancel(po) : canClose(po);
    if (!allowed) {
      throw purchasingConflict(
        "PO_BAD_TRANSITION",
        `This purchase order cannot be ${kind === "order" ? "ordered" : kind === "cancel" ? "cancelled" : "closed"} now`,
        {
          status: po.status,
        },
      );
    }
    const now = new Date();
    const data: Prisma.PurchaseOrderUncheckedUpdateInput =
      kind === "order"
        ? { status: "ORDERED", orderedAt: now }
        : kind === "cancel"
          ? { status: "CANCELLED", closedAt: now, closeReason: reason }
          : { status: "RECEIVED", closedAt: now, closeReason: reason };
    await tx.purchaseOrder.update({ where: { id }, data });
    await record(tx, {
      ctx,
      meta,
      action:
        kind === "order"
          ? "purchasing.po.ordered"
          : kind === "cancel"
            ? "purchasing.po.cancelled"
            : "purchasing.po.closed",
      entityType: "PurchaseOrder",
      entityId: id,
      metadata: {
        number: po.number,
        from: po.status,
        ...(reason ? { reason } : {}),
        ...(kind === "close" ? { unitsDropped: po.items.reduce((total, item) => total + outstanding(item), 0) } : {}),
      },
    });
    return id;
  });
  return loadPurchaseOrder(getDb(), ctx.orgId, savedId);
}

export function orderPurchaseOrder(ctx: TenantContext, poId: string, meta?: AuditRequestMeta) {
  return transition(ctx, poId, "order", {}, meta);
}

export function cancelPurchaseOrder(ctx: TenantContext, poId: string, input: unknown, meta?: AuditRequestMeta) {
  return transition(ctx, poId, "cancel", input, meta);
}

/** Close short (P3): the outstanding quantity is dropped and the PO counts as RECEIVED. */
export function closePurchaseOrder(ctx: TenantContext, poId: string, input: unknown, meta?: AuditRequestMeta) {
  return transition(ctx, poId, "close", input, meta);
}

// ---------- reads ----------

export async function getPurchaseOrder(ctx: TenantContext, poId: string): Promise<PoDetail> {
  await requirePermission(ctx, VIEW, { operation: "po.read", entityType: "PurchaseOrder" });
  const id = parseId(poId);
  const db = getDb();
  const po = await db.purchaseOrder.findFirst({ where: { id, orgId: ctx.orgId }, select: { branchId: true } });
  if (!po || !(await branchIdsInScope(ctx)).includes(po.branchId)) throw notFound("Purchase order");
  return loadPurchaseOrder(db, ctx.orgId, id);
}

/** A PO as the API returns it. Callers have checked access already. */
export async function loadPurchaseOrder(client: Db | Tx, orgId: string, id: string): Promise<PoDetail> {
  const po = await client.purchaseOrder.findFirstOrThrow({
    where: { id, orgId },
    include: {
      org: { select: { currency: true } },
      branch: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true, isActive: true, phone: true, taxNumber: true } },
      items: {
        orderBy: { id: "asc" },
        include: {
          product: { select: { sku: true, name: true, nameAr: true } },
          variant: { select: { sku: true, name: true, nameAr: true } },
        },
      },
      receipts: { orderBy: [{ receivedAt: "asc" }, { id: "asc" }], include: { items: true } },
      returns: { orderBy: { seq: "asc" }, include: { items: true } },
    },
  });
  const receivers = await client.user.findMany({
    where: {
      id: { in: [...new Set([...po.receipts.map((r) => r.receivedById), ...po.returns.map((r) => r.returnedById)])] },
    },
    select: { id: true, name: true },
  });
  const nameOf = new Map(receivers.map((user) => [user.id, user.name]));
  const lines: PoLine[] = po.items
    .map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      sku: item.variant?.sku ?? item.product.sku,
      ...itemNames(item.product, item.variant),
      qtyOrdered: item.qtyOrdered,
      qtyReceived: item.qtyReceived,
      outstanding: outstanding(item),
      qtyReturned: item.qtyReturned,
      returnable: returnable(item),
      unitCostMinor: item.unitCostMinor,
      lineTotalMinor: multiply(item.unitCostMinor, item.qtyOrdered),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  return {
    id: po.id,
    number: po.number,
    status: po.status,
    currency: po.org.currency,
    branch: po.branch,
    supplier: po.supplier,
    note: po.note,
    closeReason: po.closeReason,
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
    orderedAt: po.orderedAt?.toISOString() ?? null,
    closedAt: po.closedAt?.toISOString() ?? null,
    lines,
    receipts: po.receipts.map((receipt) => ({
      id: receipt.id,
      receivedAt: receipt.receivedAt.toISOString(),
      receivedByName: nameOf.get(receipt.receivedById) ?? "",
      note: receipt.note,
      units: receipt.items.reduce((total, item) => total + item.qtyReceived, 0),
      valueMinor: receipt.items.reduce((total, item) => total + multiply(item.unitCostMinor, item.qtyReceived), 0),
    })),
    returns: po.returns.map((ret) => ({
      id: ret.id,
      number: formatReturnNumber(po.number, ret.seq),
      returnedAt: ret.returnedAt.toISOString(),
      returnedByName: nameOf.get(ret.returnedById) ?? "",
      reason: ret.reason,
      note: ret.note,
      units: ret.items.reduce((total, item) => total + item.qty, 0),
      valueMinor: ret.items.reduce((total, item) => total + multiply(item.unitCostMinor, item.qty), 0),
    })),
    totals: poTotals(po.items),
  };
}

/** Paging position: the last row's `createdAt` and id, base64url. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): { at: Date; id: string } | null {
  const [at, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || !at || !id || !Uuid.safeParse(id).success) return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : { at: date, id };
}

const OPEN: PoStatus[] = ["ORDERED", "PARTIALLY_RECEIVED"];

export async function listPurchaseOrders(ctx: TenantContext, rawQuery: unknown = {}): Promise<PoPage> {
  await requirePermission(ctx, VIEW, { operation: "po.list", entityType: "PurchaseOrder" });
  const query = PoQuery.parse(rawQuery);
  const scope = await branchIdsInScope(ctx);
  if (query.branchId !== undefined && !scope.includes(query.branchId)) throw notFound("Branch");
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) throw notFound("Page");

  const status = query.status ?? "open";
  const db = getDb();
  const where: Prisma.PurchaseOrderWhereInput = {
    orgId: ctx.orgId,
    branchId: query.branchId ?? { in: scope },
    ...(status === "all" ? {} : { status: status === "open" ? { in: OPEN } : status }),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.q ? { number: { contains: query.q, mode: "insensitive" as const } } : {}),
    ...(cursor ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] } : {}),
  };
  const [rows, org] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PO_PAGE_SIZE + 1,
      select: {
        id: true,
        number: true,
        status: true,
        createdAt: true,
        orderedAt: true,
        branch: { select: { id: true, name: true } },
        supplier: { select: { id: true, name: true } },
        items: { select: { qtyOrdered: true, qtyReceived: true, unitCostMinor: true } },
      },
    }),
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { currency: true } }),
  ]);
  const page = rows.slice(0, PO_PAGE_SIZE);
  const last = page.at(-1);
  return {
    currency: org.currency,
    nextCursor: rows.length > PO_PAGE_SIZE && last ? encodeCursor(last.createdAt, last.id) : null,
    rows: page.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      branch: row.branch,
      supplier: row.supplier,
      createdAt: row.createdAt.toISOString(),
      orderedAt: row.orderedAt?.toISOString() ?? null,
      totals: poTotals(row.items),
    })),
  };
}
