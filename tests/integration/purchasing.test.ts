import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { getOnHand } from "@/modules/inventory";
import {
  archiveSupplier,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  listPurchaseOrders,
  listSuppliers,
  orderPurchaseOrder,
  receivePurchaseOrder,
  restoreSupplier,
  updatePurchaseOrder,
  updateSupplier,
  type PoDetail,
} from "@/modules/purchasing";
import {
  createMember,
  createProduct,
  createTenant,
  createVariant,
  expectAppError,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/** Purchasing (T5, purchasing-spec.md): suppliers, POs, receiving, idempotency, races, scope. */

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let orgId: string;
let branchId: string;
let owner: TenantContext;
let admin: TenantContext;
let manager: TenantContext;
let scopedManager: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Purchasing");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  owner = await createMember(db, orgId, "OWNER");
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
  cashier = await createMember(db, orgId, "CASHIER");
  // A manager limited to the second branch only.
  scopedManager = await createMember(db, orgId, "MANAGER");
  await db.membership.update({ where: { id: scopedManager.membershipId }, data: { allBranches: false } });
  await db.membershipBranch.create({
    data: { orgId, membershipId: scopedManager.membershipId, branchId: tenant.branchB.id },
  });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const KEY = () => `rcv-${uniqueCode()}`;

async function supplier(name = `Supplier ${uniqueCode()}`) {
  return createSupplier(admin, { name });
}

async function product(costMinor = 100) {
  const p = await createProduct(db, orgId);
  await db.product.update({ where: { id: p.id }, data: { costMinor } });
  return p;
}

/** An ORDERED PO at branch A with one line per `[productId, qty, cost]`. */
async function orderedPo(lines: [string, number, number][], branch = branchId): Promise<PoDetail> {
  const s = await supplier();
  const po = await createPurchaseOrder(admin, {
    branchId: branch,
    supplierId: s.id,
    lines: lines.map(([productId, qty, unitCostMinor]) => ({ ref: { productId }, qty, unitCostMinor })),
  });
  return orderPurchaseOrder(admin, po.id);
}

/** Archives a product directly (the catalog service needs the editor's version). */
async function archive(productId: string) {
  await db.product.update({ where: { id: productId }, data: { isActive: false } });
}

function lineFor(po: PoDetail, productId: string) {
  const found = po.lines.find((l) => l.productId === productId);
  if (!found) throw new Error("line missing");
  return found;
}

async function onHand(productId: string, variantId: string | null = null, branch = branchId) {
  const [qty] = await getOnHand(db, orgId, branch, [{ productId, variantId }]);
  return qty;
}

describe("suppliers", () => {
  it("creates, renames, archives and restores, auditing each change", async () => {
    const s = await supplier();
    const renamed = await updateSupplier(admin, s.id, { name: `${s.name} Ltd`, phone: "0100" });
    expect(renamed).toMatchObject({ phone: "0100", isActive: true });
    expect((await archiveSupplier(admin, s.id)).isActive).toBe(false);
    expect((await listSuppliers(admin)).some((row) => row.id === s.id)).toBe(false);
    expect((await listSuppliers(admin, { includeArchived: "true" })).some((row) => row.id === s.id)).toBe(true);
    expect((await restoreSupplier(admin, s.id)).isActive).toBe(true);
    const actions = await db.auditEvent.findMany({ where: { orgId, entityId: s.id }, select: { action: true } });
    expect(actions.map((a) => a.action).sort()).toEqual([
      "purchasing.supplier.archived",
      "purchasing.supplier.created",
      "purchasing.supplier.restored",
      "purchasing.supplier.updated",
    ]);
  });

  it("refuses a duplicate name ignoring case", async () => {
    const s = await supplier();
    await expectAppError(createSupplier(admin, { name: s.name.toUpperCase() }), 409, "SUPPLIER_NAME_TAKEN");
  });

  it("lets a manager list but not create, and audits the refusal", async () => {
    await expect(listSuppliers(manager)).resolves.toBeInstanceOf(Array);
    await expectAppError(createSupplier(manager, { name: `M ${uniqueCode()}` }), 403);
    await expectAppError(listSuppliers(cashier), 403);
    const denied = await db.auditEvent.count({
      where: { orgId, actorUserId: manager.userId, action: "purchasing.permission.denied" },
    });
    expect(denied).toBe(1);
  });
});

describe("purchase orders", () => {
  it("numbers drafts in sequence and merges a repeated item", async () => {
    const s = await supplier();
    const p = await product();
    const first = await createPurchaseOrder(admin, {
      branchId,
      supplierId: s.id,
      lines: [
        { ref: { productId: p.id }, qty: 2, unitCostMinor: 100 },
        { ref: { productId: p.id }, qty: 3, unitCostMinor: 110 },
      ],
    });
    const second = await createPurchaseOrder(admin, {
      branchId,
      supplierId: s.id,
      lines: [{ ref: { productId: p.id }, qty: 1, unitCostMinor: 100 }],
    });
    expect(first.status).toBe("DRAFT");
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toMatchObject({ qtyOrdered: 5, unitCostMinor: 110, lineTotalMinor: 550 });
    expect(Number(second.number.slice(3))).toBe(Number(first.number.slice(3)) + 1);
    expect(first.number).toMatch(/^PO-\d{6}$/);
  });

  it("edits lines while ordered with nothing received, then freezes after the first receipt", async () => {
    const a = await product();
    const b = await product();
    const po = await orderedPo([[a.id, 4, 100]]);
    const edited = await updatePurchaseOrder(admin, po.id, {
      lines: [
        { ref: { productId: a.id }, qty: 6, unitCostMinor: 90 },
        { ref: { productId: b.id }, qty: 1, unitCostMinor: 10 },
      ],
      note: "Second call",
    });
    expect(edited.totals).toMatchObject({ lineCount: 2, orderedUnits: 7, totalMinor: 550 });
    expect(edited.note).toBe("Second call");
    await receivePurchaseOrder(manager, po.id, KEY(), { lines: [{ poItemId: lineFor(edited, a.id).id, qty: 1 }] });
    await expectAppError(updatePurchaseOrder(admin, po.id, { note: "late" }), 409, "PO_NOT_EDITABLE");
    await expectAppError(cancelPurchaseOrder(admin, po.id, {}), 409, "PO_BAD_TRANSITION");
  });

  it("orders only drafts, cancels before receipt and closes only partial POs", async () => {
    const p = await product();
    const po = await orderedPo([[p.id, 2, 100]]);
    await expectAppError(orderPurchaseOrder(admin, po.id), 409, "PO_BAD_TRANSITION");
    await expectAppError(closePurchaseOrder(admin, po.id, { reason: "short" }), 409, "PO_BAD_TRANSITION");
    const cancelled = await cancelPurchaseOrder(admin, po.id, { reason: "Supplier out of stock" });
    expect(cancelled).toMatchObject({ status: "CANCELLED", closeReason: "Supplier out of stock" });
    await expectAppError(
      receivePurchaseOrder(manager, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty: 1 }] }),
      409,
      "PO_NOT_RECEIVABLE",
    );
  });

  it("refuses a draft receipt, an archived supplier and an archived item", async () => {
    const p = await product();
    const s = await supplier();
    const draft = await createPurchaseOrder(admin, {
      branchId,
      supplierId: s.id,
      lines: [{ ref: { productId: p.id }, qty: 1, unitCostMinor: 1 }],
    });
    await expectAppError(
      receivePurchaseOrder(manager, draft.id, KEY(), { lines: [{ poItemId: draft.lines[0].id, qty: 1 }] }),
      409,
      "PO_NOT_RECEIVABLE",
    );
    await archiveSupplier(admin, s.id);
    await expectAppError(
      createPurchaseOrder(admin, {
        branchId,
        supplierId: s.id,
        lines: [{ ref: { productId: p.id }, qty: 1, unitCostMinor: 1 }],
      }),
      409,
      "SUPPLIER_INACTIVE",
    );
    const other = await supplier();
    await archive(p.id);
    await expectAppError(
      createPurchaseOrder(admin, {
        branchId,
        supplierId: other.id,
        lines: [{ ref: { productId: p.id }, qty: 1, unitCostMinor: 1 }],
      }),
      422,
      "ITEM_NOT_SELLABLE",
    );
  });

  it("lists open POs by default, newest first, and pages with a cursor", async () => {
    const p = await product();
    const ordered = await orderedPo([[p.id, 1, 100]]);
    const page = await listPurchaseOrders(admin);
    expect(page.rows[0].id).toBe(ordered.id);
    expect(page.rows.every((row) => row.status === "ORDERED" || row.status === "PARTIALLY_RECEIVED")).toBe(true);
    const drafts = await listPurchaseOrders(admin, { status: "DRAFT" });
    expect(drafts.rows.every((row) => row.status === "DRAFT")).toBe(true);
    await expectAppError(listPurchaseOrders(admin, { cursor: "nonsense" }), 404);
  });

  it("refuses a manager creating a PO", async () => {
    const s = await supplier();
    const p = await product();
    await expectAppError(
      createPurchaseOrder(manager, {
        branchId,
        supplierId: s.id,
        lines: [{ ref: { productId: p.id }, qty: 1, unitCostMinor: 1 }],
      }),
      403,
    );
  });
});

describe("receiving", () => {
  it("receives in two parts: stock, ledger, PO status and last cost all follow", async () => {
    const a = await product(100);
    const b = await product(500);
    const po = await orderedPo([
      [a.id, 10, 120],
      [b.id, 4, 500],
    ]);
    const first = await receivePurchaseOrder(manager, po.id, KEY(), {
      lines: [
        { poItemId: lineFor(po, a.id).id, qty: 6, unitCostMinor: 125 },
        { poItemId: lineFor(po, b.id).id, qty: 0 },
      ],
      note: "Van 1",
    });
    expect(first.created).toBe(true);
    expect(first.po.status).toBe("PARTIALLY_RECEIVED");
    expect(lineFor(first.po, a.id)).toMatchObject({ qtyReceived: 6, outstanding: 4 });
    expect(first.po.receipts).toHaveLength(1);
    expect(first.po.receipts[0]).toMatchObject({ units: 6, valueMinor: 750, note: "Van 1" });
    expect(await onHand(a.id)).toBe(6);
    expect(await onHand(b.id)).toBe(0);

    const ledger = await db.inventoryMovement.findMany({ where: { orgId, refId: first.receiptId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reason: "PURCHASE_RECEIPT", refType: "GoodsReceipt", qtyDelta: 6, branchId });

    // Last cost (P2): a moved to the corrected 125, b untouched (nothing received).
    expect((await db.product.findUniqueOrThrow({ where: { id: a.id } })).costMinor).toBe(125);
    expect((await db.product.findUniqueOrThrow({ where: { id: b.id } })).costMinor).toBe(500);
    const costEvents = await db.auditEvent.findMany({
      where: { orgId, action: "catalog.cost.received", entityId: a.id },
    });
    expect(costEvents).toHaveLength(1);
    expect(costEvents[0].metadata).toMatchObject({ fromMinor: 100, toMinor: 125, goodsReceiptId: first.receiptId });

    const second = await receivePurchaseOrder(manager, po.id, KEY(), {
      lines: [
        { poItemId: lineFor(po, a.id).id, qty: 4 },
        { poItemId: lineFor(po, b.id).id, qty: 4 },
      ],
    });
    expect(second.po.status).toBe("RECEIVED");
    expect(second.po.closedAt).not.toBeNull();
    expect(await onHand(a.id)).toBe(10);
    expect(await onHand(b.id)).toBe(4);
    // a went back to the PO cost 120; b's cost was unchanged, so no audit row for it.
    expect((await db.product.findUniqueOrThrow({ where: { id: a.id } })).costMinor).toBe(120);
    expect(await db.auditEvent.count({ where: { orgId, action: "catalog.cost.received", entityId: b.id } })).toBe(0);
  });

  it("sets a variant's own cost", async () => {
    const p = await product(100);
    const v = await createVariant(db, orgId, p.id);
    const s = await supplier();
    const draft = await createPurchaseOrder(admin, {
      branchId,
      supplierId: s.id,
      lines: [{ ref: { productId: p.id, variantId: v.id }, qty: 3, unitCostMinor: 70 }],
    });
    const po = await orderPurchaseOrder(admin, draft.id);
    await receivePurchaseOrder(manager, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty: 3 }] });
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: v.id } })).costMinor).toBe(70);
    expect((await db.product.findUniqueOrThrow({ where: { id: p.id } })).costMinor).toBe(100);
    expect(await onHand(p.id, v.id)).toBe(3);
  });

  it("refuses more than outstanding, a line of another PO, and an all-zero receipt", async () => {
    const p = await product();
    const po = await orderedPo([[p.id, 2, 100]]);
    const other = await orderedPo([[p.id, 2, 100]]);
    const err = await expectAppError(
      receivePurchaseOrder(manager, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty: 3 }] }),
      409,
      "QTY_EXCEEDS_OUTSTANDING",
    );
    expect(err.details).toMatchObject({ outstanding: 2, requested: 3 });
    await expectAppError(
      receivePurchaseOrder(manager, po.id, KEY(), { lines: [{ poItemId: other.lines[0].id, qty: 1 }] }),
      404,
    );
    await expectAppError(
      receivePurchaseOrder(manager, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty: 0 }] }),
      422,
      "NOTHING_TO_RECEIVE",
    );
    expect(await onHand(p.id)).toBe(0);
  });

  it("refuses an item archived after ordering and writes nothing", async () => {
    const p = await product();
    const po = await orderedPo([[p.id, 2, 100]]);
    await archive(p.id);
    await expectAppError(
      receivePurchaseOrder(manager, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty: 2 }] }),
      422,
      "ITEM_NOT_SELLABLE",
    );
    expect(await db.goodsReceipt.count({ where: { orgId, purchaseOrderId: po.id } })).toBe(0);
    expect((await getPurchaseOrder(admin, po.id)).lines[0].qtyReceived).toBe(0);
  });

  it("replays the same key and body, and refuses the key with another body", async () => {
    const p = await product();
    const po = await orderedPo([[p.id, 5, 100]]);
    const key = KEY();
    const body = { lines: [{ poItemId: po.lines[0].id, qty: 2 }] };
    const first = await receivePurchaseOrder(manager, po.id, key, body);
    const again = await receivePurchaseOrder(manager, po.id, key, body);
    expect(again).toMatchObject({ created: false, receiptId: first.receiptId });
    expect(await onHand(p.id)).toBe(2);
    await expectAppError(
      receivePurchaseOrder(manager, po.id, key, { lines: [{ poItemId: po.lines[0].id, qty: 3 }] }),
      409,
    );
  });

  it("lets only one of two concurrent receipts of the last units through", async () => {
    const p = await product();
    const po = await orderedPo([[p.id, 3, 100]]);
    const body = { lines: [{ poItemId: po.lines[0].id, qty: 3 }] };
    const results = await Promise.allSettled([
      receivePurchaseOrder(manager, po.id, KEY(), body),
      receivePurchaseOrder(admin, po.id, KEY(), body),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await onHand(p.id)).toBe(3);
  });

  it("closes a partial PO short, dropping the rest", async () => {
    const p = await product();
    const po = await orderedPo([[p.id, 5, 100]]);
    await receivePurchaseOrder(manager, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty: 2 }] });
    await expect(closePurchaseOrder(admin, po.id, { reason: "" })).rejects.toThrow(/too_small|>=1/);
    const closed = await closePurchaseOrder(admin, po.id, { reason: "Discontinued by supplier" });
    expect(closed).toMatchObject({ status: "RECEIVED", closeReason: "Discontinued by supplier" });
    expect(closed.lines[0]).toMatchObject({ qtyReceived: 2, outstanding: 3 });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "purchasing.po.closed", entityId: po.id },
    });
    expect(event.metadata).toMatchObject({ unitsDropped: 3 });
  });

  it("refuses a cashier, audited", async () => {
    const p = await product();
    const po = await orderedPo([[p.id, 1, 100]]);
    await expectAppError(
      receivePurchaseOrder(cashier, po.id, KEY(), { lines: [{ poItemId: po.lines[0].id, qty: 1 }] }),
      403,
    );
    expect(
      await db.auditEvent.count({
        where: {
          orgId,
          actorUserId: cashier.userId,
          action: "purchasing.permission.denied",
          entityType: "GoodsReceipt",
        },
      }),
    ).toBe(1);
  });
});

describe("scope and isolation", () => {
  it("hides another branch's PO from a branch-limited manager", async () => {
    const p = await product();
    const poA = await orderedPo([[p.id, 1, 100]]);
    const poB = await orderedPo([[p.id, 1, 100]], tenant.branchB.id);
    await expectAppError(getPurchaseOrder(scopedManager, poA.id), 404);
    await expectAppError(
      receivePurchaseOrder(scopedManager, poA.id, KEY(), { lines: [{ poItemId: poA.lines[0].id, qty: 1 }] }),
      404,
    );
    const page = await listPurchaseOrders(scopedManager, { status: "all" });
    expect(page.rows.map((row) => row.id)).toContain(poB.id);
    expect(page.rows.every((row) => row.branch.id === tenant.branchB.id)).toBe(true);
    await receivePurchaseOrder(scopedManager, poB.id, KEY(), { lines: [{ poItemId: poB.lines[0].id, qty: 1 }] });
    expect(await onHand(p.id, null, tenant.branchB.id)).toBe(1);
  });

  it("answers 404 for another org's PO and supplier, and for a malformed id", async () => {
    const other = await createTenant(db, "Purchasing other");
    const otherOwner = await createMember(db, other.org.id, "OWNER");
    const s = await createSupplier(otherOwner, { name: `Other ${uniqueCode()}` });
    const p = await createProduct(db, other.org.id);
    const po = await createPurchaseOrder(otherOwner, {
      branchId: other.branchA.id,
      supplierId: s.id,
      lines: [{ ref: { productId: p.id }, qty: 1, unitCostMinor: 1 }],
    });
    await expectAppError(getPurchaseOrder(owner, po.id), 404);
    await expectAppError(updateSupplier(owner, s.id, { phone: "1" }), 404);
    await expectAppError(getPurchaseOrder(owner, "not-a-uuid"), 404);
    await expectAppError(
      createPurchaseOrder(owner, {
        branchId,
        supplierId: s.id,
        lines: [{ ref: { productId: p.id }, qty: 1, unitCostMinor: 1 }],
      }),
      404,
    );
    await expectAppError(getPurchaseOrder(owner, randomUUID()), 404);
  });
});
