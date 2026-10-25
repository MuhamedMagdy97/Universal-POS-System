import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { listTables, saveTables } from "@/modules/org";
import {
  cancelTicket,
  getTicket,
  listOpenTickets,
  moveTicket,
  openTicket,
  saveTicketLines,
  sendToKitchen,
} from "@/modules/sales";
import { createMember, createProduct, createTenant, expectAppError, testDb } from "./helpers";

/**
 * Open tickets (restaurant-cafe-spec R4-R6, R10): opened on a table, added to from two tills, sent to the kitchen in
 * parts, moved and cancelled. Tea 10.00, cake 25.00, VAT included.
 */

let db: Db;
let orgId: string;
let branchId: string;
let owner: TenantContext;
let manager: TenantContext;
let cashier: TenantContext;
let stranger: TenantContext;
let tea: string;
let cake: string;
let tables: { id: string; name: string }[];

const ref = (productId: string) => ({ productId, variantId: null });

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Tickets");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  owner = await createMember(db, orgId, "OWNER");
  manager = await createMember(db, orgId, "MANAGER");
  cashier = await createMember(db, orgId, "CASHIER");
  const other = await createTenant(db, "TicketsOther");
  stranger = await createMember(db, other.org.id, "OWNER");
  tea = (await createProduct(db, orgId, "TK-TEA")).id;
  cake = (await createProduct(db, orgId, "TK-CAKE")).id;
  await db.product.update({ where: { id: cake }, data: { priceMinor: 2_500, name: "Cake" } });
  await db.product.update({ where: { id: tea }, data: { name: "Tea" } });
  await saveTables(owner, { branchId, tables: [{ name: "1" }, { name: "2" }, { name: "3" }] });
  tables = await listTables(owner, branchId);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("open tickets", () => {
  it("opens one ticket per table and refuses what an order type does not allow", async () => {
    const first = await openTicket(cashier, { branchId, orderType: "DINE_IN", tableId: tables[0].id });
    const again = await openTicket(manager, { branchId, orderType: "DINE_IN", tableId: tables[0].id });
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ status: "OPEN", version: 1, table: { name: "1" }, lines: [], totalMinor: 0 });

    await expectAppError(openTicket(cashier, { branchId, orderType: "DINE_IN" }), 422, "TABLE_REQUIRED");
    await expectAppError(openTicket(cashier, { branchId, orderType: "DELIVERY" }), 422, "CUSTOMER_REQUIRED");
    const takeaway = await openTicket(cashier, { branchId, orderType: "TAKEAWAY" });
    expect(takeaway.number).toBe(first.number + 1);
    await expectAppError(getTicket(stranger, first.id), 404);
  });

  it("saves lines with versions, sends them in parts and needs a manager to take back what was sent", async () => {
    const ticket = await openTicket(cashier, { branchId, orderType: "DINE_IN", tableId: tables[1].id });
    const v2 = await saveTicketLines(cashier, ticket.id, {
      version: 1,
      lines: [
        { ref: ref(tea), qty: 2 },
        { ref: ref(cake), qty: 1, note: "candle" },
      ],
    });
    expect(v2.ticket).toMatchObject({ version: 2, totalMinor: 4_500 });
    // The second till still holds version 1.
    await expectAppError(
      saveTicketLines(manager, ticket.id, { version: 1, lines: [{ ref: ref(tea), qty: 1 }] }),
      409,
      "TICKET_CHANGED",
    );

    const sent = await sendToKitchen(cashier, ticket.id, 2);
    expect(sent.slip?.lines.map((line) => [line.qty, line.name, line.note])).toEqual([
      [2, "Tea", null],
      [1, "Cake", "candle"],
    ]);
    expect(sent.slip).toMatchObject({ tableName: "2", cancelled: false });
    // Nothing new: no slip.
    expect((await sendToKitchen(cashier, ticket.id, 3)).slip).toBeNull();

    // One more tea: only that one goes out next.
    const more = await saveTicketLines(cashier, ticket.id, {
      version: 3,
      lines: [
        { ref: ref(tea), qty: 3 },
        { ref: ref(cake), qty: 1, note: "candle" },
      ],
    });
    expect(more.ticket.lines.find((line) => line.item.productId === tea)).toMatchObject({ qty: 3, sentQty: 2 });
    const next = await sendToKitchen(cashier, ticket.id, 4);
    expect(next.slip?.lines.map((line) => [line.qty, line.name])).toEqual([[1, "Tea"]]);

    // Taking back a sent cake: a cashier may not, a manager may, with a cancelled slip.
    const without = { version: 5, lines: [{ ref: ref(tea), qty: 3 }] };
    await expectAppError(saveTicketLines(cashier, ticket.id, without), 403);
    const back = await saveTicketLines(manager, ticket.id, without);
    expect(back.cancelled).toMatchObject({ cancelled: true, lines: [{ qty: 1, name: "Cake", note: "candle" }] });
    expect(back.ticket.lines).toMatchObject([{ qty: 3, sentQty: 3 }]);
    expect(await db.auditEvent.count({ where: { orgId, action: "ticket.line.cancelled" } })).toBe(1);

    const open = await listOpenTickets(cashier, branchId);
    expect(open.find((row) => row.id === ticket.id)).toMatchObject({ tableName: "2", totalMinor: 3_000, lineCount: 1 });
  });

  it("moves to a free table only, and cancels with a manager and a reason once anything was sent", async () => {
    const busy = (await listOpenTickets(cashier, branchId)).find((row) => row.tableName === "2");
    if (!busy) throw new Error("table 2 has no ticket");
    const ticket = await openTicket(cashier, { branchId, orderType: "DINE_IN", tableId: tables[2].id });
    await expectAppError(moveTicket(cashier, ticket.id, { version: 1, tableId: busy.tableId }), 409, "TABLE_BUSY");

    // Unsent: the cashier cancels it.
    const cancelled = await cancelTicket(cashier, ticket.id, { version: 1 });
    expect(cancelled.status).toBe("CANCELLED");
    await expectAppError(saveTicketLines(cashier, ticket.id, { version: 2, lines: [] }), 409, "TICKET_CLOSED");

    // The sent ticket on table 2.
    const sent = await getTicket(cashier, busy.id);
    await expectAppError(cancelTicket(cashier, busy.id, { version: sent.version, reason: "Left" }), 403);
    await expectAppError(cancelTicket(manager, busy.id, { version: sent.version }), 422, "REASON_REQUIRED");
    const moved = await moveTicket(cashier, busy.id, { version: sent.version, tableId: tables[2].id });
    expect(moved.table?.name).toBe("3");
    const done = await cancelTicket(manager, busy.id, { version: moved.version, reason: "Guests left" });
    expect(done.status).toBe("CANCELLED");
    expect(await db.auditEvent.count({ where: { orgId, action: { in: ["ticket.cancelled", "ticket.moved"] } } })).toBe(
      3,
    );
  });
});
