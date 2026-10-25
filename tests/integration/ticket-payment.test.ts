import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { createCustomer } from "@/modules/customers";
import * as inventory from "@/modules/inventory";
import { listTables, saveTables } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { createSale, getReceipt, getTicket, openTicket, saveTicketLines, sendToKitchen } from "@/modules/sales";
import { createMember, createProduct, createTenant, expectAppError, expectReconciled, testDb } from "./helpers";

/**
 * Paying a ticket (restaurant-cafe-spec R5): an ordinary sale of exactly the ticket's lines, in one transaction that
 * closes the ticket. Tea 10.00, cake 25.00, VAT included.
 */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let cashier: TenantContext;
let tea: string;
let cake: string;
let tableId: string;

const KEY = () => `tkt-${crypto.randomUUID()}`;
const ref = (productId: string) => ({ productId, variantId: null });
const onHand = async (productId: string) =>
  (await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId, variantId: null } })).qty;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "TicketPay");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  const owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  tea = (await createProduct(db, orgId, "TP-TEA")).id;
  cake = (await createProduct(db, orgId, "TP-CAKE")).id;
  await db.product.update({ where: { id: cake }, data: { priceMinor: 2_500 } });
  await inventory.recordOpeningBalances(owner, {
    branchId,
    lines: [
      { ref: ref(tea), qty: 20 },
      { ref: ref(cake), qty: 20 },
    ],
  });
  await saveTables(owner, { branchId, tables: [{ name: "4" }] });
  tableId = (await listTables(owner, branchId))[0].id;
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const pay = (lines: unknown[], ticket: { id: string; version: number }, key = KEY(), amountMinor = 4_500) =>
  createSale(
    cashier,
    {
      branchId,
      registerId,
      lines,
      ticket: { id: ticket.id, version: ticket.version },
      payments: [{ method: "CASH", amountMinor }],
    },
    key,
  );

describe("paying a ticket", () => {
  it("sells exactly its lines, closes it, and carries the table on the sale and receipt", async () => {
    const opened = await openTicket(cashier, { branchId, orderType: "DINE_IN", tableId });
    const { ticket } = await saveTicketLines(cashier, opened.id, {
      version: 1,
      lines: [
        { ref: ref(tea), qty: 2 },
        { ref: ref(cake), qty: 1, note: "candle" },
      ],
    });
    const sent = (await sendToKitchen(cashier, ticket.id, ticket.version)).ticket;
    const lines = [
      { ref: ref(tea), qty: 2 },
      { ref: ref(cake), qty: 1, note: "candle" },
    ];

    // A cart that is not the ticket, or an older version, is refused and sells nothing.
    await expectAppError(pay([{ ref: ref(tea), qty: 2 }], sent), 409, "TICKET_CHANGED");
    await expectAppError(pay(lines, { id: sent.id, version: 1 }), 409, "TICKET_CHANGED");
    expect(await onHand(tea)).toBe(20);

    const key = KEY();
    const { sale } = await pay(lines, sent, key);
    expect(sale).toMatchObject({ totalMinor: 4_500, orderType: "DINE_IN", tableName: "4", ticketId: sent.id });
    expect(await onHand(tea)).toBe(18);
    expect(await getTicket(cashier, sent.id)).toMatchObject({ status: "PAID" });
    const receipt = await getReceipt(cashier, sale.id, { kind: "SALE", copy: false });
    expect(receipt.order).toEqual({ type: "DINE_IN", tableName: "4", deliveryAddress: null });

    // The same key replays the sale; another key finds the ticket closed. The table is free again.
    expect((await pay(lines, sent, key)).sale.id).toBe(sale.id);
    await expectAppError(pay(lines, { id: sent.id, version: sent.version + 1 }), 409, "TICKET_CLOSED");
    const next = await openTicket(cashier, { branchId, orderType: "DINE_IN", tableId });
    expect(next.id).not.toBe(sent.id);
  });

  it("takes a delivery ticket's customer and address onto the sale", async () => {
    const customer = await createCustomer(cashier, { name: "Mona", phone: "01001234567" });
    const opened = await openTicket(cashier, {
      branchId,
      orderType: "DELIVERY",
      customerId: customer.id,
      deliveryAddress: "12 Nile St, flat 3",
    });
    const { ticket } = await saveTicketLines(cashier, opened.id, { version: 1, lines: [{ ref: ref(cake), qty: 1 }] });
    const { sale } = await pay([{ ref: ref(cake), qty: 1 }], ticket, KEY(), 2_500);
    expect(sale).toMatchObject({
      orderType: "DELIVERY",
      delivery: { address: "12 Nile St, flat 3", note: null },
      customer: { name: "Mona" },
    });
  });

  it("records the order type of a counter sale without a ticket", async () => {
    const { sale } = await createSale(
      cashier,
      {
        branchId,
        registerId,
        lines: [{ ref: ref(tea), qty: 1 }],
        orderType: "TAKEAWAY",
        payments: [{ method: "CASH", amountMinor: 1_000 }],
      },
      KEY(),
    );
    expect(sale).toMatchObject({ orderType: "TAKEAWAY", tableName: null, ticketId: null });
  });
});
