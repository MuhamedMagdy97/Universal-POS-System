import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { adjustStock, getOnHand } from "@/modules/inventory";
import {
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  getPurchaseReturn,
  orderPurchaseOrder,
  receivePurchaseOrder,
  returnToSupplier,
  type PoDetail,
} from "@/modules/purchasing";
import {
  createMember,
  createProduct,
  createTenant,
  expectAppError,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/** Purchase returns (purchase-returns-spec.md): stock, ledger, limits, races, idempotency, scope. */

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let manager: TenantContext;
let scopedManagerB: TenantContext;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Purchase returns");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
  // An admin limited to branch B, to check branch scope on a manage-level write.
  scopedManagerB = await createMember(db, orgId, "ADMIN");
  await db.membership.update({ where: { id: scopedManagerB.membershipId }, data: { allBranches: false } });
  await db.membershipBranch.create({
    data: { orgId, membershipId: scopedManagerB.membershipId, branchId: tenant.branchB.id },
  });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const KEY = () => `ret-${uniqueCode()}`;

async function product(costMinor = 100) {
  const p = await createProduct(db, orgId);
  await db.product.update({ where: { id: p.id }, data: { costMinor } });
  return p;
}

/** A PO at branch A with one line per `[productId, qty, cost]`, fully received. */
async function receivedPo(lines: [string, number, number][]): Promise<PoDetail> {
  const s = await createSupplier(admin, { name: `Supplier ${uniqueCode()}` });
  const draft = await createPurchaseOrder(admin, {
    branchId,
    supplierId: s.id,
    lines: lines.map(([productId, qty, unitCostMinor]) => ({ ref: { productId }, qty, unitCostMinor })),
  });
  const po = await orderPurchaseOrder(admin, draft.id);
  const received = await receivePurchaseOrder(admin, po.id, KEY(), {
    lines: po.lines.map((line) => ({ poItemId: line.id, qty: line.qtyOrdered })),
  });
  return received.po;
}

async function onHand(productId: string) {
  const [qty] = await getOnHand(db, orgId, branchId, [{ productId, variantId: null }]);
  return qty;
}

describe("returning to the supplier", () => {
  it("takes the stock out, writes the ledger and audit, values at PO cost and keeps last cost", async () => {
    const a = await product(100);
    const po = await receivedPo([[a.id, 10, 120]]);
    // A later price change: the return still values at the PO line's cost.
    await db.product.update({ where: { id: a.id }, data: { costMinor: 130 } });

    const result = await returnToSupplier(admin, po.id, KEY(), {
      reason: "DAMAGED",
      note: "Crushed boxes",
      lines: [{ poItemId: po.lines[0].id, qty: 3 }],
    });
    expect(result.created).toBe(true);
    expect(result.po.status).toBe("RECEIVED");
    expect(result.po.lines[0]).toMatchObject({ qtyReceived: 10, qtyReturned: 3, returnable: 7, outstanding: 0 });
    expect(result.po.returns).toHaveLength(1);
    expect(result.po.returns[0]).toMatchObject({
      number: `${po.number}-R1`,
      reason: "DAMAGED",
      note: "Crushed boxes",
      units: 3,
      valueMinor: 360,
    });
    expect(await onHand(a.id)).toBe(7);
    expect((await db.product.findUniqueOrThrow({ where: { id: a.id } })).costMinor).toBe(130);

    const ledger = await db.inventoryMovement.findMany({ where: { orgId, refId: result.returnId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reason: "PURCHASE_RETURN", refType: "PurchaseReturn", qtyDelta: -3, branchId });

    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "purchasing.return.created", entityId: result.returnId },
    });
    expect(event.metadata).toMatchObject({ number: `${po.number}-R1`, units: 3, valueMinor: 360, reason: "DAMAGED" });

    const detail = await getPurchaseReturn(manager, po.id, result.returnId);
    expect(detail.lines).toEqual([{ poItemId: po.lines[0].id, qty: 3, unitCostMinor: 120, lineTotalMinor: 360 }]);

    const second = await returnToSupplier(admin, po.id, KEY(), {
      reason: "EXPIRED",
      lines: [{ poItemId: po.lines[0].id, qty: 7 }],
    });
    expect(second.po.returns.map((r) => r.number)).toEqual([`${po.number}-R1`, `${po.number}-R2`]);
    expect(second.po.lines[0].returnable).toBe(0);
    expect(await onHand(a.id)).toBe(0);
  });

  it("refuses more than is returnable, across returns too, and writes nothing", async () => {
    const a = await product();
    const po = await receivedPo([[a.id, 4, 100]]);
    const line = po.lines[0].id;
    const err = await expectAppError(
      returnToSupplier(admin, po.id, KEY(), { reason: "OTHER", lines: [{ poItemId: line, qty: 5 }] }),
      409,
      "QTY_EXCEEDS_RETURNABLE",
    );
    expect(err.details).toMatchObject({ returnable: 4, requested: 5 });
    await returnToSupplier(admin, po.id, KEY(), { reason: "OTHER", lines: [{ poItemId: line, qty: 3 }] });
    await expectAppError(
      returnToSupplier(admin, po.id, KEY(), { reason: "OTHER", lines: [{ poItemId: line, qty: 2 }] }),
      409,
      "QTY_EXCEEDS_RETURNABLE",
    );
    await expectAppError(
      returnToSupplier(admin, po.id, KEY(), { reason: "OTHER", lines: [{ poItemId: line, qty: 0 }] }),
      422,
      "NOTHING_TO_RETURN",
    );
    expect(await onHand(a.id)).toBe(1);
    expect((await getPurchaseOrder(admin, po.id)).lines[0].qtyReturned).toBe(3);
  });

  it("refuses a PO with nothing received and a line of another PO", async () => {
    const a = await product();
    const s = await createSupplier(admin, { name: `S ${uniqueCode()}` });
    const draft = await createPurchaseOrder(admin, {
      branchId,
      supplierId: s.id,
      lines: [{ ref: { productId: a.id }, qty: 2, unitCostMinor: 1 }],
    });
    const ordered = await orderPurchaseOrder(admin, draft.id);
    await expectAppError(
      returnToSupplier(admin, ordered.id, KEY(), {
        reason: "OTHER",
        lines: [{ poItemId: ordered.lines[0].id, qty: 1 }],
      }),
      409,
      "QTY_EXCEEDS_RETURNABLE",
    );
    const other = await receivedPo([[a.id, 1, 1]]);
    await expectAppError(
      returnToSupplier(admin, ordered.id, KEY(), { reason: "OTHER", lines: [{ poItemId: other.lines[0].id, qty: 1 }] }),
      404,
    );
  });

  it("lets only one of two concurrent returns of the last units through", async () => {
    const a = await product();
    const po = await receivedPo([[a.id, 3, 100]]);
    const body = { reason: "DEFECTIVE" as const, lines: [{ poItemId: po.lines[0].id, qty: 3 }] };
    const results = await Promise.allSettled([
      returnToSupplier(admin, po.id, KEY(), body),
      returnToSupplier(admin, po.id, KEY(), body),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await onHand(a.id)).toBe(0);
    expect(await db.purchaseReturn.count({ where: { orgId, purchaseOrderId: po.id } })).toBe(1);
  });

  it("replays the same key and body, and refuses the key with another body", async () => {
    const a = await product();
    const po = await receivedPo([[a.id, 5, 100]]);
    const key = KEY();
    const body = { reason: "WRONG_ITEM" as const, lines: [{ poItemId: po.lines[0].id, qty: 2 }] };
    const first = await returnToSupplier(admin, po.id, key, body);
    const again = await returnToSupplier(admin, po.id, key, body);
    expect(again).toMatchObject({ created: false, returnId: first.returnId });
    expect(await onHand(a.id)).toBe(3);
    await expectAppError(
      returnToSupplier(admin, po.id, key, { ...body, reason: "OTHER" }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("blocks going below zero when the shop blocks negative stock, and allows it otherwise", async () => {
    const a = await product();
    const po = await receivedPo([[a.id, 4, 100]]);
    // Three of the four were sold or moved since receiving.
    await adjustStock(admin, {
      branchId,
      ref: { productId: a.id, variantId: null },
      adjustmentReason: "LOST_OR_STOLEN",
      qtyDelta: -3,
      expectedOnHand: 4,
    });
    const body = { reason: "DAMAGED" as const, lines: [{ poItemId: po.lines[0].id, qty: 2 }] };
    await expectAppError(returnToSupplier(admin, po.id, KEY(), body), 409, "INSUFFICIENT_STOCK");
    expect((await getPurchaseOrder(admin, po.id)).lines[0].qtyReturned).toBe(0);

    await db.organization.update({ where: { id: orgId }, data: { blockNegativeStock: false } });
    try {
      await returnToSupplier(admin, po.id, KEY(), body);
      expect(await onHand(a.id)).toBe(-1);
    } finally {
      await db.organization.update({ where: { id: orgId }, data: { blockNegativeStock: true } });
    }
  });

  it("returns an item archived after receiving", async () => {
    const a = await product();
    const po = await receivedPo([[a.id, 2, 100]]);
    await db.product.update({ where: { id: a.id }, data: { isActive: false } });
    await returnToSupplier(admin, po.id, KEY(), { reason: "EXPIRED", lines: [{ poItemId: po.lines[0].id, qty: 2 }] });
    expect(await onHand(a.id)).toBe(0);
  });
});

describe("access", () => {
  it("refuses a manager (no purchases.manage), audited", async () => {
    const a = await product();
    const po = await receivedPo([[a.id, 1, 100]]);
    await expectAppError(
      returnToSupplier(manager, po.id, KEY(), { reason: "OTHER", lines: [{ poItemId: po.lines[0].id, qty: 1 }] }),
      403,
    );
    expect(
      await db.auditEvent.count({
        where: {
          orgId,
          actorUserId: manager.userId,
          action: "purchasing.permission.denied",
          entityType: "PurchaseReturn",
        },
      }),
    ).toBe(1);
  });

  it("refuses a shop linked to the inventory system", async () => {
    const a = await product();
    const po = await receivedPo([[a.id, 1, 100]]);
    await db.organization.update({ where: { id: orgId }, data: { inventorySource: "EXTERNAL" } });
    try {
      await expectAppError(
        returnToSupplier(admin, po.id, KEY(), { reason: "OTHER", lines: [{ poItemId: po.lines[0].id, qty: 1 }] }),
        409,
        "MANAGED_BY_INVENTORY",
      );
    } finally {
      await db.organization.update({ where: { id: orgId }, data: { inventorySource: "BUILT_IN" } });
    }
    expect(await onHand(a.id)).toBe(1);
  });

  it("hides another branch's PO and another org's PO (404)", async () => {
    const a = await product();
    const po = await receivedPo([[a.id, 2, 100]]);
    const body = { reason: "OTHER" as const, lines: [{ poItemId: po.lines[0].id, qty: 1 }] };
    await expectAppError(returnToSupplier(scopedManagerB, po.id, KEY(), body), 404);

    // A key used in branch A is not replayed to a user outside it.
    const key = KEY();
    const first = await returnToSupplier(admin, po.id, key, body);
    await expectAppError(returnToSupplier(scopedManagerB, po.id, key, body), 404);
    await expectAppError(getPurchaseReturn(scopedManagerB, po.id, first.returnId), 404);

    const other = await createTenant(db, "Purchase returns other");
    const otherAdmin = await createMember(db, other.org.id, "ADMIN");
    await expectAppError(returnToSupplier(otherAdmin, po.id, KEY(), body), 404);
    await expectAppError(getPurchaseReturn(otherAdmin, po.id, first.returnId), 404);
    await expectAppError(getPurchaseReturn(admin, po.id, randomUUID()), 404);
    expect(await onHand(a.id)).toBe(1);
  });
});
