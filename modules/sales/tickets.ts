import "server-only";
import { z } from "zod";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb, type Db } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import type { Prisma } from "@/lib/generated/prisma/client";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { getItemsForHistory, type SellableSummary } from "@/modules/catalog";
import { customerForSale } from "@/modules/customers";
import { ItemRefInput, Qty, Uuid } from "@/modules/inventory/schemas";
import { requireBranch, requirePermission } from "./access";
import { lineKeyOf, resolveOptions, type OptionSnapshot } from "./options";
import { LineNote } from "./schemas";
import { priceSale } from "./totals";

/**
 * Open tickets (docs/planning/ui-refresh/restaurant-cafe-spec.md R4-R6, R10): orders not paid yet, kept on the server
 * so every till in the branch sees them. They hold no stock; paying one is an ordinary sale (`createSale` with
 * `ticket`). Every change bumps `version`; a save with an older version is 409 TICKET_CHANGED.
 *
 * Lines are stored per kitchen send: a dish sent twice is two rows. The till sees one line per item, options and
 * note (`key`), with how much of it went to the kitchen (`sentQty`).
 */

type Tx = Prisma.TransactionClient;

const Text = z.string().trim().min(1).max(200);

export const OpenTicketInput = z.strictObject({
  branchId: Uuid,
  orderType: z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY"]),
  tableId: Uuid.optional(),
  customerId: Uuid.optional(),
  deliveryAddress: Text.optional(),
  deliveryNote: Text.optional(),
});

export const TicketLineInput = z.strictObject({
  ref: ItemRefInput,
  qty: Qty,
  options: z.array(Uuid).max(20).optional(),
  note: LineNote.optional(),
});

export const SaveTicketInput = z.strictObject({
  version: z.int().min(1),
  lines: z.array(TicketLineInput).max(200),
});

export type TicketLineView = {
  key: string;
  item: SellableSummary;
  qty: number;
  /** How much of `qty` went to the kitchen. */
  sentQty: number;
  options: string[];
  optionLabels: OptionSnapshot[];
  note: string | null;
  /** Base price plus options. */
  unitPriceMinor: number;
};

export type TicketView = {
  id: string;
  number: number;
  branchId: string;
  orderType: "DINE_IN" | "TAKEAWAY" | "DELIVERY";
  table: { id: string; name: string } | null;
  customer: { id: string; name: string; phone: string } | null;
  deliveryAddress: string | null;
  deliveryNote: string | null;
  status: "OPEN" | "PAID" | "CANCELLED";
  version: number;
  openedAt: string;
  lines: TicketLineView[];
  totalMinor: number;
};

export type TicketSummary = {
  id: string;
  number: number;
  orderType: TicketView["orderType"];
  tableId: string | null;
  tableName: string | null;
  totalMinor: number;
  lineCount: number;
  openedAt: string;
};

/** What the kitchen slip prints (R10): the lines just sent, or just cancelled. */
export type KitchenSlip = {
  ticketNumber: number;
  orderType: TicketView["orderType"];
  tableName: string | null;
  waiter: string;
  at: string;
  cancelled: boolean;
  lines: {
    qty: number;
    unitType: "EACH" | "KG";
    name: string;
    nameAr: string | null;
    options: OptionSnapshot[];
    note: string | null;
  }[];
};

function ticketConflict(reason: "TICKET_CHANGED" | "TICKET_CLOSED" | "TABLE_BUSY", message: string): AppError {
  return new AppError("CONFLICT", message, { reason });
}

function invalidTicket(reason: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason });
}

const TICKET_INCLUDE = {
  table: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true, phone: true } },
  lines: { orderBy: [{ sortOrder: "asc" as const }, { id: "asc" as const }] },
};

type TicketRow = Prisma.TicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

/** Rows grouped by key (first-seen order) with their sent quantity. */
function grouped(rows: TicketRow["lines"]) {
  const groups = new Map<
    string,
    {
      ref: { productId: string; variantId: string | null };
      options: string[];
      note: string | null;
      qty: number;
      sentQty: number;
    }
  >();
  for (const row of rows) {
    const ref = { productId: row.productId, variantId: row.variantId };
    const key = lineKeyOf(ref, row.options, row.note);
    const group = groups.get(key) ?? { ref, options: row.options, note: row.note, qty: 0, sentQty: 0 };
    group.qty += row.qty;
    if (row.sentAt) group.sentQty += row.qty;
    groups.set(key, group);
  }
  return groups;
}

async function viewOf(client: Db | Tx, orgId: string, ticket: TicketRow): Promise<TicketView> {
  const groups = [...grouped(ticket.lines).entries()];
  const items = await getItemsForHistory(
    client,
    orgId,
    groups.map(([, group]) => group.ref),
  );
  const lines = groups.map(([key, group], index): TicketLineView => {
    const { costMinor: _cost, ...item } = items[index];
    // A choice archived since the ticket was opened still prices as it was picked: pay reprices it anyway.
    let priced: ReturnType<typeof resolveOptions>;
    try {
      priced = resolveOptions(item, group.options);
    } catch {
      priced = { unitPriceMinor: item.unitPriceMinor, snapshot: [] };
    }
    return {
      key,
      item,
      qty: group.qty,
      sentQty: group.sentQty,
      options: group.options,
      optionLabels: priced.snapshot,
      note: group.note,
      unitPriceMinor: priced.unitPriceMinor,
    };
  });
  const org = await client.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { vatRateBp: true, pricesIncludeVat: true },
  });
  const total = priceSale(
    lines.map((line) => ({
      unitPriceMinor: line.unitPriceMinor,
      qty: line.qty,
      vatApplicable: line.item.vatApplicable,
      unitType: line.item.unitType,
    })),
    null,
    org.vatRateBp,
    org.pricesIncludeVat,
  );
  return {
    id: ticket.id,
    number: ticket.number,
    branchId: ticket.branchId,
    orderType: ticket.orderType,
    table: ticket.table,
    customer: ticket.customer,
    deliveryAddress: ticket.deliveryAddress,
    deliveryNote: ticket.deliveryNote,
    status: ticket.status,
    version: ticket.version,
    openedAt: ticket.openedAt.toISOString(),
    lines,
    totalMinor: total.totalMinor,
  };
}

async function loadTicket(client: Db | Tx, ctx: TenantContext, id: string): Promise<TicketRow> {
  if (!Uuid.safeParse(id).success) throw notFound("Ticket");
  const ticket = await client.ticket.findFirst({ where: { id, orgId: ctx.orgId }, include: TICKET_INCLUDE });
  if (!ticket) throw notFound("Ticket");
  await requireBranch(ctx, ticket.branchId);
  return ticket;
}

/** Locks the ticket and checks it is still OPEN at `version`. */
async function lockOpen(tx: Tx, ctx: TenantContext, id: string, version: number): Promise<TicketRow> {
  if (!Uuid.safeParse(id).success) throw notFound("Ticket");
  await tx.$queryRaw`SELECT 1 FROM "Ticket" WHERE "id" = ${id}::uuid AND "orgId" = ${ctx.orgId}::uuid FOR UPDATE`;
  const ticket = await loadTicket(tx, ctx, id);
  if (ticket.status !== "OPEN") throw ticketConflict("TICKET_CLOSED", "This ticket is already paid or cancelled");
  if (ticket.version !== version) throw ticketConflict("TICKET_CHANGED", "This ticket was changed on another till");
  return ticket;
}

const permission = (ctx: TenantContext, operation: string, meta?: AuditRequestMeta) =>
  requirePermission(ctx, "sales.create", { operation, entityType: "Sale", meta });

export async function getTicket(ctx: TenantContext, id: string): Promise<TicketView> {
  await permission(ctx, "ticket.read");
  const db = getDb();
  return viewOf(db, ctx.orgId, await loadTicket(db, ctx, id));
}

/** The branch's open tickets, oldest first, with their totals. */
export async function listOpenTickets(ctx: TenantContext, branchId: string): Promise<TicketSummary[]> {
  await permission(ctx, "ticket.list");
  if (!Uuid.safeParse(branchId).success) throw notFound("Branch");
  await requireBranch(ctx, branchId);
  const db = getDb();
  const rows = await db.ticket.findMany({
    where: { orgId: ctx.orgId, branchId, status: "OPEN" },
    orderBy: [{ openedAt: "asc" }, { number: "asc" }],
    include: TICKET_INCLUDE,
  });
  return Promise.all(
    rows.map(async (row) => {
      const view = await viewOf(db, ctx.orgId, row);
      return {
        id: row.id,
        number: row.number,
        orderType: row.orderType,
        tableId: row.table?.id ?? null,
        tableName: row.table?.name ?? null,
        totalMinor: view.totalMinor,
        lineCount: view.lines.length,
        openedAt: view.openedAt,
      };
    }),
  );
}

/**
 * Opens a ticket. A dine-in ticket needs an active table of the branch; if that table already has an open ticket,
 * that one is returned instead (R4). Delivery needs a customer (R2).
 */
export async function openTicket(ctx: TenantContext, input: unknown, meta?: AuditRequestMeta): Promise<TicketView> {
  await permission(ctx, "ticket.open", meta);
  const data = OpenTicketInput.parse(input);
  await requireBranch(ctx, data.branchId);
  if (data.orderType === "DINE_IN" && !data.tableId) throw invalidTicket("TABLE_REQUIRED", "Choose a table");
  if (data.orderType !== "DINE_IN" && data.tableId)
    throw invalidTicket("TABLE_NOT_ALLOWED", "Only dine-in has a table");
  if (data.orderType === "DELIVERY" && !data.customerId) {
    throw invalidTicket("CUSTOMER_REQUIRED", "Choose the customer to deliver to");
  }
  const customer = data.customerId ? await customerForSale(ctx, data.customerId, meta) : null;
  const db = getDb();
  return db.$transaction(async (tx) => {
    if (data.tableId) {
      const table = await tx.diningTable.findFirst({
        where: { id: data.tableId, orgId: ctx.orgId, branchId: data.branchId, isActive: true },
        select: { id: true },
      });
      if (!table) throw notFound("DiningTable");
      await tx.$queryRaw`SELECT 1 FROM "DiningTable" WHERE "id" = ${table.id}::uuid FOR UPDATE`;
      const open = await tx.ticket.findFirst({
        where: { orgId: ctx.orgId, tableId: table.id, status: "OPEN" },
        include: TICKET_INCLUDE,
      });
      if (open) return viewOf(tx, ctx.orgId, open);
    }
    const [{ lastTicketNo }] = await tx.$queryRaw<{ lastTicketNo: number }[]>`
      UPDATE "Organization" SET "lastTicketNo" = "lastTicketNo" + 1 WHERE "id" = ${ctx.orgId}::uuid
      RETURNING "lastTicketNo"`;
    const ticket = await tx.ticket.create({
      data: {
        orgId: ctx.orgId,
        branchId: data.branchId,
        number: lastTicketNo,
        orderType: data.orderType,
        tableId: data.tableId ?? null,
        customerId: customer?.id ?? null,
        deliveryAddress: data.deliveryAddress ?? null,
        deliveryNote: data.deliveryNote ?? null,
        openedById: ctx.userId,
      },
      include: TICKET_INCLUDE,
    });
    await record(tx, {
      ctx,
      meta,
      action: "ticket.opened",
      entityType: "Ticket",
      entityId: ticket.id,
      metadata: { number: ticket.number, orderType: ticket.orderType, tableId: ticket.tableId },
    });
    return viewOf(tx, ctx.orgId, ticket);
  });
}

/**
 * Saves the ticket's lines (the till's cart). Unsent quantities are replaced freely. Taking back what was sent to the
 * kitchen needs `sales.void`, is audited as `ticket.line.cancelled` and comes back as a "cancelled" kitchen slip.
 */
export async function saveTicketLines(
  ctx: TenantContext,
  id: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<{ ticket: TicketView; cancelled: KitchenSlip | null }> {
  await permission(ctx, "ticket.save", meta);
  const data = SaveTicketInput.parse(input);
  const db = getDb();
  return db.$transaction(async (tx) => {
    const ticket = await lockOpen(tx, ctx, id, data.version);
    const wanted = new Map<
      string,
      { ref: { productId: string; variantId: string | null }; options: string[]; note: string | null; qty: number }
    >();
    for (const line of data.lines) {
      const ref = { productId: line.ref.productId, variantId: line.ref.variantId ?? null };
      const key = lineKeyOf(ref, line.options ?? [], line.note);
      const current = wanted.get(key);
      if (current) current.qty += line.qty;
      else wanted.set(key, { ref, options: [...(line.options ?? [])].sort(), note: line.note ?? null, qty: line.qty });
    }
    // Every wanted item must be sellable now with options that fit (as at payment).
    const refs = [...wanted.values()].map((line) => line.ref);
    const items = await getItemsForHistory(tx, ctx.orgId, refs);
    [...wanted.values()].forEach((line, index) => resolveOptions(items[index], line.options));

    const have = grouped(ticket.lines);
    // What was sent and is now taken back, per line (R10).
    const taken = [...have.entries()].flatMap(([key, group]) => {
      const back = group.sentQty - Math.min(group.sentQty, wanted.get(key)?.qty ?? 0);
      return back > 0 ? [{ group, qty: back }] : [];
    });
    if (taken.length > 0) {
      await requirePermission(ctx, "sales.void", { operation: "ticket.line.cancel", entityType: "Sale", meta });
    }

    // Rewrite the rows: the kept sent part keeps its first send time, the rest is unsent.
    const sentAtOf = new Map<string, Date>();
    for (const row of ticket.lines) {
      const key = lineKeyOf({ productId: row.productId, variantId: row.variantId }, row.options, row.note);
      if (row.sentAt && !sentAtOf.has(key)) sentAtOf.set(key, row.sentAt);
    }
    await tx.ticketLine.deleteMany({ where: { orgId: ctx.orgId, ticketId: ticket.id } });
    const rows: Prisma.TicketLineCreateManyInput[] = [];
    for (const [key, line] of wanted) {
      const sent = Math.min(have.get(key)?.sentQty ?? 0, line.qty);
      const base = {
        orgId: ctx.orgId,
        ticketId: ticket.id,
        productId: line.ref.productId,
        variantId: line.ref.variantId,
        options: line.options,
        note: line.note,
        sortOrder: rows.length,
      };
      if (sent > 0) rows.push({ ...base, qty: sent, sentAt: sentAtOf.get(key) ?? new Date() });
      if (line.qty > sent) rows.push({ ...base, qty: line.qty - sent });
    }
    if (rows.length > 0) await tx.ticketLine.createMany({ data: rows });
    await tx.ticket.update({ where: { id: ticket.id }, data: { version: { increment: 1 } } });

    let slip: KitchenSlip | null = null;
    if (taken.length > 0) {
      const takenItems = await getItemsForHistory(
        tx,
        ctx.orgId,
        taken.map(({ group }) => group.ref),
      );
      slip = await slipOf(
        tx,
        ctx,
        ticket,
        true,
        taken.map(({ group, qty }, index) => ({
          qty,
          item: takenItems[index],
          options: group.options,
          note: group.note,
        })),
      );
      await record(tx, {
        ctx,
        meta,
        action: "ticket.line.cancelled",
        entityType: "Ticket",
        entityId: ticket.id,
        metadata: { number: ticket.number, lines: slip.lines.map((line) => ({ name: line.name, qty: line.qty })) },
      });
    }
    return { ticket: await viewOf(tx, ctx.orgId, await loadTicket(tx, ctx, ticket.id)), cancelled: slip };
  });
}

async function slipOf(
  tx: Tx,
  ctx: TenantContext,
  ticket: TicketRow,
  cancelled: boolean,
  lines: { qty: number; item: SellableSummary; options: string[]; note: string | null }[],
): Promise<KitchenSlip> {
  const user = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
  return {
    ticketNumber: ticket.number,
    orderType: ticket.orderType,
    tableName: ticket.table?.name ?? null,
    waiter: user?.name ?? "",
    at: new Date().toISOString(),
    cancelled,
    lines: lines.map((line) => {
      let options: OptionSnapshot[] = [];
      try {
        options = resolveOptions(line.item, line.options).snapshot;
      } catch {
        options = [];
      }
      return {
        qty: line.qty,
        unitType: line.item.unitType,
        name: line.item.name,
        nameAr: line.item.nameAr,
        options,
        note: line.note,
      };
    }),
  };
}

/** Sends what is not sent yet to the kitchen: stamps it and returns the slip to print (R10). */
export async function sendToKitchen(
  ctx: TenantContext,
  id: string,
  version: unknown,
  meta?: AuditRequestMeta,
): Promise<{ ticket: TicketView; slip: KitchenSlip | null }> {
  await permission(ctx, "ticket.send", meta);
  const v = z.int().min(1).parse(version);
  const db = getDb();
  return db.$transaction(async (tx) => {
    const ticket = await lockOpen(tx, ctx, id, v);
    const unsent = ticket.lines.filter((line) => !line.sentAt);
    if (unsent.length === 0) return { ticket: await viewOf(tx, ctx.orgId, ticket), slip: null };
    const now = new Date();
    await tx.ticketLine.updateMany({
      where: { orgId: ctx.orgId, ticketId: ticket.id, sentAt: null },
      data: { sentAt: now },
    });
    await tx.ticket.update({ where: { id: ticket.id }, data: { version: { increment: 1 } } });
    const items = await getItemsForHistory(
      tx,
      ctx.orgId,
      unsent.map((line) => ({ productId: line.productId, variantId: line.variantId })),
    );
    const slip = await slipOf(
      tx,
      ctx,
      ticket,
      false,
      unsent.map((line, index) => ({ qty: line.qty, item: items[index], options: line.options, note: line.note })),
    );
    await record(tx, {
      ctx,
      meta,
      action: "ticket.sent",
      entityType: "Ticket",
      entityId: ticket.id,
      metadata: { number: ticket.number, lines: slip.lines.length },
    });
    return { ticket: await viewOf(tx, ctx.orgId, await loadTicket(tx, ctx, ticket.id)), slip };
  });
}

/** Moves a dine-in ticket to another free table of its branch. */
export async function moveTicket(
  ctx: TenantContext,
  id: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<TicketView> {
  await permission(ctx, "ticket.move", meta);
  const data = z.strictObject({ version: z.int().min(1), tableId: Uuid }).parse(input);
  const db = getDb();
  return db.$transaction(async (tx) => {
    const ticket = await lockOpen(tx, ctx, id, data.version);
    if (ticket.orderType !== "DINE_IN") throw invalidTicket("TABLE_NOT_ALLOWED", "Only dine-in has a table");
    const table = await tx.diningTable.findFirst({
      where: { id: data.tableId, orgId: ctx.orgId, branchId: ticket.branchId, isActive: true },
      select: { id: true, name: true },
    });
    if (!table) throw notFound("DiningTable");
    const busy = await tx.ticket.findFirst({
      where: { orgId: ctx.orgId, tableId: table.id, status: "OPEN", id: { not: ticket.id } },
      select: { id: true },
    });
    if (busy) throw ticketConflict("TABLE_BUSY", "That table has an open ticket");
    await tx.ticket.update({ where: { id: ticket.id }, data: { tableId: table.id, version: { increment: 1 } } });
    await record(tx, {
      ctx,
      meta,
      action: "ticket.moved",
      entityType: "Ticket",
      entityId: ticket.id,
      metadata: { number: ticket.number, from: ticket.table?.name ?? null, to: table.name },
    });
    return viewOf(tx, ctx.orgId, await loadTicket(tx, ctx, ticket.id));
  });
}

/** Cancels an open ticket (R6). With anything sent to the kitchen it needs `sales.void` and a reason. */
export async function cancelTicket(
  ctx: TenantContext,
  id: string,
  input: unknown,
  meta?: AuditRequestMeta,
): Promise<TicketView> {
  await permission(ctx, "ticket.cancel", meta);
  const data = z.strictObject({ version: z.int().min(1), reason: z.string().trim().max(200).optional() }).parse(input);
  const db = getDb();
  return db.$transaction(async (tx) => {
    const ticket = await lockOpen(tx, ctx, id, data.version);
    const sent = ticket.lines.some((line) => line.sentAt);
    if (sent) {
      await requirePermission(ctx, "sales.void", { operation: "ticket.cancel", entityType: "Sale", meta });
      if (!data.reason)
        throw invalidTicket("REASON_REQUIRED", "Give a reason: part of this order was sent to the kitchen");
    }
    await tx.ticket.update({
      where: { id: ticket.id },
      data: { status: "CANCELLED", closedAt: new Date(), cancelReason: data.reason ?? null, version: { increment: 1 } },
    });
    await record(tx, {
      ctx,
      meta,
      action: "ticket.cancelled",
      entityType: "Ticket",
      entityId: ticket.id,
      metadata: { number: ticket.number, sent, reason: data.reason ?? null },
    });
    return viewOf(tx, ctx.orgId, await loadTicket(tx, ctx, ticket.id));
  });
}

/**
 * For `createSale` (R5): locks the ticket, checks it is OPEN at `version` and that the sale's merged lines are exactly
 * its lines; returns what the sale snapshots. The caller closes it with `closeTicket` in the same transaction.
 */
export async function ticketForSale(
  tx: Tx,
  ctx: TenantContext,
  ticket: { id: string; version: number },
  branchId: string,
  lines: readonly { key: string; qty: number }[],
): Promise<{
  id: string;
  orderType: TicketView["orderType"];
  tableName: string | null;
  customerId: string | null;
  deliveryAddress: string | null;
  deliveryNote: string | null;
}> {
  const row = await lockOpen(tx, ctx, ticket.id, ticket.version);
  if (row.branchId !== branchId) throw notFound("Ticket");
  const have = grouped(row.lines);
  const same = have.size === lines.length && lines.every((line) => have.get(line.key)?.qty === line.qty);
  if (!same) throw ticketConflict("TICKET_CHANGED", "The sale does not match the ticket; reload it");
  return {
    id: row.id,
    orderType: row.orderType,
    tableName: row.table?.name ?? null,
    customerId: row.customerId,
    deliveryAddress: row.deliveryAddress,
    deliveryNote: row.deliveryNote,
  };
}

export async function closeTicket(tx: Tx, ticketId: string, saleId: string): Promise<void> {
  await tx.ticket.update({
    where: { id: ticketId },
    data: { status: "PAID", saleId, closedAt: new Date(), version: { increment: 1 } },
  });
}

/** Open tickets per branch, for the shift close (R4). */
export async function openTicketCount(client: Db | Tx, orgId: string, branchId: string): Promise<number> {
  return client.ticket.count({ where: { orgId, branchId, status: "OPEN" } });
}
