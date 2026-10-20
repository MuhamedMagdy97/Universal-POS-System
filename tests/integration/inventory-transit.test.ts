import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { createMember, createProduct, createTenant, expectAppError, expectReconciled, testDb } from "./helpers";

/** Two-step transfers (docs/planning/transfers/transit-transfers-spec.md). */
let db: Db;
let orgId: string;
let branchA: string;
let branchB: string;
let admin: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Inv Transit");
  orgId = tenant.org.id;
  branchA = tenant.branchA.id;
  branchB = tenant.branchB.id;
  admin = await createMember(db, orgId, "ADMIN");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const ref = (productId: string) => ({ productId, variantId: null });

async function stockedAt(branchId: string, qty: number) {
  const product = await createProduct(db, orgId);
  await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty }] });
  return product;
}

const onHand = (productId: string, branch: string) =>
  inventory.getOnHand(db, orgId, branch, [ref(productId)]).then((qty) => qty[0]);

async function send(lines: { productId: string; qty: number }[], ctx = admin, from = branchA, to = branchB) {
  const transferId = randomUUID();
  await inventory.sendTransfer(ctx, {
    transferId,
    fromBranchId: from,
    toBranchId: to,
    lines: lines.map((line) => ({ ref: ref(line.productId), qty: line.qty })),
  });
  return transferId;
}

const full = (productId: string, qty: number) => ({ ref: ref(productId), qtyReceived: qty });

describe("send", () => {
  it("takes stock out of the source; it is incoming at the destination and on hand nowhere (T3, T8)", async () => {
    const product = await stockedAt(branchA, 10);
    const id = await send([{ productId: product.id, qty: 4 }]);
    expect(await onHand(product.id, branchA)).toBe(6);
    expect(await onHand(product.id, branchB)).toBe(0);

    const rows = await db.inventoryMovement.findMany({ where: { orgId, transferGroupId: id } });
    expect(rows.map((row) => [row.reason, row.branchId, row.qtyDelta, row.refType])).toEqual([
      ["TRANSFER_OUT", branchA, -4, "StockTransfer"],
    ]);
    const stock = await inventory.listStock(admin, { branchId: branchB, q: product.sku });
    expect(stock.rows[0]).toMatchObject({ qty: 0, incoming: 4 });
    const source = await inventory.listStock(admin, { branchId: branchA, q: product.sku });
    expect(source.rows[0]).toMatchObject({ qty: 6, incoming: 0 });

    const detail = await inventory.getTransfer(admin, id);
    expect(detail).toMatchObject({ status: "SENT", unitsSent: 4, lineCount: 1 });
    expect(detail.reference).toMatch(/^TR-[0-9A-F]{8}$/);
    const audit = await db.auditEvent.findFirst({ where: { orgId, action: "inventory.transfer.sent", entityId: id } });
    expect(audit).not.toBeNull();
    await expectReconciled(db, orgId);
  });

  it("refuses to send more than the source holds (INSUFFICIENT_STOCK) and creates nothing", async () => {
    const product = await stockedAt(branchA, 2);
    const transferId = randomUUID();
    await expectAppError(
      inventory.sendTransfer(admin, {
        transferId,
        fromBranchId: branchA,
        toBranchId: branchB,
        lines: [{ ref: ref(product.id), qty: 3 }],
      }),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(await db.stockTransfer.findFirst({ where: { id: transferId } })).toBeNull();
    expect(await onHand(product.id, branchA)).toBe(2);
  });

  it("replays a retried send, conflicts on different content, and applies a race once (T9)", async () => {
    const product = await stockedAt(branchA, 10);
    const input = {
      transferId: randomUUID(),
      fromBranchId: branchA,
      toBranchId: branchB,
      lines: [{ ref: ref(product.id), qty: 2 }],
    };
    const results = await Promise.all([inventory.sendTransfer(admin, input), inventory.sendTransfer(admin, input)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await inventory.sendTransfer(admin, input)).toMatchObject({ replayed: true });
    expect(await onHand(product.id, branchA)).toBe(8);
    await expectAppError(
      inventory.sendTransfer(admin, { ...input, lines: [{ ref: ref(product.id), qty: 3 }] }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("refuses an id already used by an instant transfer, and the reverse", async () => {
    const product = await stockedAt(branchA, 10);
    const instantId = randomUUID();
    const lines = [{ ref: ref(product.id), qty: 1 }];
    await inventory.transferStock(admin, { transferId: instantId, fromBranchId: branchA, toBranchId: branchB, lines });
    await expectAppError(
      inventory.sendTransfer(admin, { transferId: instantId, fromBranchId: branchA, toBranchId: branchB, lines }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    const transitId = await send([{ productId: product.id, qty: 1 }]);
    await expectAppError(
      inventory.transferStock(admin, { transferId: transitId, fromBranchId: branchA, toBranchId: branchB, lines }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("refuses the same branch", async () => {
    const product = await stockedAt(branchA, 1);
    await expectAppError(
      inventory.sendTransfer(admin, {
        transferId: randomUUID(),
        fromBranchId: branchA,
        toBranchId: branchA,
        lines: [{ ref: ref(product.id), qty: 1 }],
      }),
      422,
      "SAME_BRANCH",
    );
  });
});

describe("receive", () => {
  it("receives in full: TRANSFER_IN at the destination, status RECEIVED (T4)", async () => {
    const product = await stockedAt(branchA, 5);
    const id = await send([{ productId: product.id, qty: 5 }]);
    const result = await inventory.receiveTransfer(admin, id, {
      receiveKey: randomUUID(),
      lines: [full(product.id, 5)],
    });
    expect(result).toEqual({ replayed: false, received: 5, shortfall: 0 });
    expect(await onHand(product.id, branchB)).toBe(5);
    const stock = await inventory.listStock(admin, { branchId: branchB, q: product.sku });
    expect(stock.rows[0]).toMatchObject({ qty: 5, incoming: 0 });
    expect((await inventory.getTransfer(admin, id)).status).toBe("RECEIVED");
    await expectReconciled(db, orgId);
  });

  it("writes a shortfall off at the destination with its reason (T5)", async () => {
    const a = await stockedAt(branchA, 10);
    const b = await stockedAt(branchA, 10);
    const c = await stockedAt(branchA, 10);
    const id = await send([
      { productId: a.id, qty: 6 },
      { productId: b.id, qty: 3 },
      { productId: c.id, qty: 2 },
    ]);
    const result = await inventory.receiveTransfer(admin, id, {
      receiveKey: randomUUID(),
      note: "Box crushed",
      lines: [
        { ref: ref(a.id), qtyReceived: 4, shortfallReason: "DAMAGED" },
        { ref: ref(b.id), qtyReceived: 0, shortfallReason: "OTHER" },
        full(c.id, 2),
      ],
    });
    expect(result).toEqual({ replayed: false, received: 6, shortfall: 5 });
    expect(await onHand(a.id, branchB)).toBe(4);
    expect(await onHand(b.id, branchB)).toBe(0);
    expect(await onHand(c.id, branchB)).toBe(2);
    expect(await onHand(a.id, branchA)).toBe(4);

    const rows = await db.inventoryMovement.findMany({
      where: { orgId, branchId: branchB, productId: a.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((row) => [row.reason, row.adjustmentReason, row.qtyDelta, row.refId])).toEqual([
      ["TRANSFER_IN", null, 6, id],
      ["ADJUSTMENT", "DAMAGED", -2, id],
    ]);
    const detail = await inventory.getTransfer(admin, id);
    expect(detail.lines.find((line) => line.ref.productId === a.id)).toMatchObject({
      qtyReceived: 4,
      shortfallReason: "DAMAGED",
    });
    expect(detail.receiveNote).toBe("Box crushed");
    await expectReconciled(db, orgId);
  });

  it("validates lines: over-sent, missing reason, reason on a full line, missing line, OTHER without note", async () => {
    const a = await stockedAt(branchA, 5);
    const b = await stockedAt(branchA, 5);
    const id = await send([
      { productId: a.id, qty: 2 },
      { productId: b.id, qty: 2 },
    ]);
    const receive = (lines: Parameters<typeof inventory.receiveTransfer>[2]["lines"], note?: string) =>
      inventory.receiveTransfer(admin, id, { receiveKey: randomUUID(), lines, note });
    await expectAppError(receive([full(a.id, 3), full(b.id, 2)]), 422, "QTY_OVER_SENT");
    await expectAppError(receive([full(a.id, 1), full(b.id, 2)]), 422, "SHORTFALL_REASON");
    await expectAppError(
      receive([{ ...full(a.id, 2), shortfallReason: "DAMAGED" }, full(b.id, 2)]),
      422,
      "SHORTFALL_REASON",
    );
    await expectAppError(receive([full(a.id, 2)]), 422, "LINES_MISMATCH");
    // OTHER without a note fails input validation (the route answers 422).
    await expect(receive([{ ...full(a.id, 1), shortfallReason: "OTHER" }, full(b.id, 2)])).rejects.toThrow(/note/);
    expect((await inventory.getTransfer(admin, id)).status).toBe("SENT");
    expect(await onHand(a.id, branchB)).toBe(0);
  });

  it("replays a retried receive with the same key; another key is TRANSFER_STATE (T9)", async () => {
    const product = await stockedAt(branchA, 5);
    const id = await send([{ productId: product.id, qty: 3 }]);
    const input = {
      receiveKey: randomUUID(),
      lines: [{ ...full(product.id, 2), shortfallReason: "LOST_OR_STOLEN" as const }],
    };
    await inventory.receiveTransfer(admin, id, input);
    expect(await inventory.receiveTransfer(admin, id, input)).toEqual({ replayed: true, received: 2, shortfall: 1 });
    await expectAppError(
      inventory.receiveTransfer(admin, id, { ...input, receiveKey: randomUUID() }),
      409,
      "TRANSFER_STATE",
    );
    expect(await onHand(product.id, branchB)).toBe(2);
  });

  it("applies one of two racing receives, and one of a racing receive and cancel (T10)", async () => {
    const product = await stockedAt(branchA, 10);
    const id = await send([{ productId: product.id, qty: 2 }]);
    const results = await Promise.allSettled([
      inventory.receiveTransfer(admin, id, { receiveKey: randomUUID(), lines: [full(product.id, 2)] }),
      inventory.receiveTransfer(admin, id, { receiveKey: randomUUID(), lines: [full(product.id, 2)] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await onHand(product.id, branchB)).toBe(2);

    const other = await send([{ productId: product.id, qty: 3 }]);
    const raced = await Promise.allSettled([
      inventory.receiveTransfer(admin, other, { receiveKey: randomUUID(), lines: [full(product.id, 3)] }),
      inventory.cancelTransfer(admin, other),
    ]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const status = (await inventory.getTransfer(admin, other)).status;
    // Received: 2 + 3 at B and 5 left at A; cancelled: 2 at B and 8 back at A.
    expect([await onHand(product.id, branchA), await onHand(product.id, branchB)]).toEqual(
      status === "RECEIVED" ? [5, 5] : [8, 2],
    );
    await expectReconciled(db, orgId);
  });
});

describe("cancel", () => {
  it("returns the stock to the source, replays, and blocks a later receive (T7)", async () => {
    const product = await stockedAt(branchA, 5);
    const id = await send([{ productId: product.id, qty: 5 }]);
    expect(await onHand(product.id, branchA)).toBe(0);
    expect(await inventory.cancelTransfer(admin, id)).toEqual({ replayed: false });
    expect(await inventory.cancelTransfer(admin, id)).toEqual({ replayed: true });
    expect(await onHand(product.id, branchA)).toBe(5);
    expect(await onHand(product.id, branchB)).toBe(0);
    await expectAppError(
      inventory.receiveTransfer(admin, id, { receiveKey: randomUUID(), lines: [full(product.id, 5)] }),
      409,
      "TRANSFER_STATE",
    );
    const stock = await inventory.listStock(admin, { branchId: branchB, q: product.sku });
    expect(stock.rows[0]).toMatchObject({ incoming: 0 });
    await expectReconciled(db, orgId);
  });

  it("refuses to cancel a received transfer", async () => {
    const product = await stockedAt(branchA, 1);
    const id = await send([{ productId: product.id, qty: 1 }]);
    await inventory.receiveTransfer(admin, id, { receiveKey: randomUUID(), lines: [full(product.id, 1)] });
    await expectAppError(inventory.cancelTransfer(admin, id), 409, "TRANSFER_STATE");
  });
});

describe("access", () => {
  it("scopes each side to its branch: send/cancel at the source, receive at the destination (T11)", async () => {
    const product = await stockedAt(branchA, 10);
    const scopedTo = async (branchId: string) => {
      const member = await createMember(db, orgId, "MANAGER");
      await db.membership.update({ where: { id: member.membershipId }, data: { allBranches: false } });
      await db.membershipBranch.create({ data: { orgId, membershipId: member.membershipId, branchId } });
      return member;
    };
    const atA = await scopedTo(branchA);
    const atB = await scopedTo(branchB);

    const id = await send([{ productId: product.id, qty: 2 }], atA);
    await expectAppError(send([{ productId: product.id, qty: 1 }], atB), 404);
    // Both sides see it; only the destination receives and only the source cancels.
    expect((await inventory.getTransfer(atA, id)).status).toBe("SENT");
    expect((await inventory.getTransfer(atB, id)).status).toBe("SENT");
    expect(
      (await inventory.listTransfers(atB, { branchId: branchB, direction: "incoming" })).map((t) => t.id),
    ).toContain(id);
    await expectAppError(inventory.listTransfers(atB, { branchId: branchA, direction: "outgoing" }), 404);
    await expectAppError(
      inventory.receiveTransfer(atA, id, { receiveKey: randomUUID(), lines: [full(product.id, 2)] }),
      404,
    );
    await expectAppError(inventory.cancelTransfer(atB, id), 404);
    await inventory.receiveTransfer(atB, id, { receiveKey: randomUUID(), lines: [full(product.id, 2)] });

    // A cashier holds no inventory permission.
    const cashier = await createMember(db, orgId, "CASHIER");
    await expectAppError(send([{ productId: product.id, qty: 1 }], cashier), 403);
  });

  it("hides another org's transfer (404) and refuses writes for a linked shop (T12)", async () => {
    const product = await stockedAt(branchA, 3);
    const id = await send([{ productId: product.id, qty: 1 }]);
    const other = await createTenant(db, "Inv Transit Other");
    const outsider = await createMember(db, other.org.id, "ADMIN");
    await expectAppError(inventory.getTransfer(outsider, id), 404);
    await expectAppError(
      inventory.receiveTransfer(outsider, id, { receiveKey: randomUUID(), lines: [full(product.id, 1)] }),
      404,
    );
    await expectAppError(inventory.cancelTransfer(outsider, id), 404);

    const shop = await createTenant(db, "Inv Transit Linked");
    const owner = await createMember(db, shop.org.id, "OWNER");
    const item = await createProduct(db, shop.org.id);
    await inventory.recordOpeningBalances(owner, { branchId: shop.branchA.id, lines: [{ ref: ref(item.id), qty: 2 }] });
    const linkedId = randomUUID();
    await inventory.sendTransfer(owner, {
      transferId: linkedId,
      fromBranchId: shop.branchA.id,
      toBranchId: shop.branchB.id,
      lines: [{ ref: ref(item.id), qty: 1 }],
    });
    await db.organization.update({ where: { id: shop.org.id }, data: { inventorySource: "EXTERNAL" } });
    await expectAppError(
      inventory.receiveTransfer(owner, linkedId, { receiveKey: randomUUID(), lines: [full(item.id, 1)] }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    await expectAppError(inventory.cancelTransfer(owner, linkedId), 409, "MANAGED_BY_INVENTORY");
    await expectAppError(
      inventory.sendTransfer(owner, {
        transferId: randomUUID(),
        fromBranchId: shop.branchA.id,
        toBranchId: shop.branchB.id,
        lines: [{ ref: ref(item.id), qty: 1 }],
      }),
      409,
      "MANAGED_BY_INVENTORY",
    );
  });
});

describe("database rules", () => {
  it("rejects a received quantity above sent, and a short line without a reason", async () => {
    const product = await stockedAt(branchA, 2);
    const id = await send([{ productId: product.id, qty: 2 }]);
    const line = await db.stockTransferLine.findFirstOrThrow({ where: { transferId: id } });
    await expect(db.stockTransferLine.update({ where: { id: line.id }, data: { qtyReceived: 3 } })).rejects.toThrow();
    await expect(db.stockTransferLine.update({ where: { id: line.id }, data: { qtyReceived: 1 } })).rejects.toThrow();
    await expect(
      db.stockTransferLine.update({ where: { id: line.id }, data: { qtyReceived: 2, shortfallReason: "DAMAGED" } }),
    ).rejects.toThrow();
  });

  it("rejects RECEIVED without receivedAt, and a transfer to its own branch", async () => {
    const product = await stockedAt(branchA, 1);
    const id = await send([{ productId: product.id, qty: 1 }]);
    await expect(db.stockTransfer.update({ where: { id }, data: { status: "RECEIVED" } })).rejects.toThrow();
    await expect(
      db.stockTransfer.create({
        data: { id: randomUUID(), orgId, fromBranchId: branchA, toBranchId: branchA, sentByUserId: admin.userId },
      }),
    ).rejects.toThrow();
  });
});
