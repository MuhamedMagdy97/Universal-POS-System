import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { adjustStock, getOnHand } from "@/modules/inventory";
import {
  createPurchaseOrder,
  createSupplier,
  getDirectReceipt,
  getDirectReturn,
  getSupplierStatement,
  listSupplierInvoices,
  orderPurchaseOrder,
  receivePurchaseOrder,
  receiveWithoutPo,
  recordSupplierInvoice,
  returnDirectReceipt,
  type DirectReceiptDetail,
} from "@/modules/purchasing";
import { formatDirectReceiptNumber, formatReturnNumber } from "@/modules/purchasing/rules";
import { getReport } from "@/modules/reports";
import {
  createMember,
  createProduct,
  createTenant,
  expectAppError,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/** Returns against a direct receipt (docs/planning/purchase-returns/direct-receipt-returns-spec.md). */

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let orgId: string;
let branchId: string;
let owner: TenantContext;
let admin: TenantContext;
let manager: TenantContext;
let scopedAdminB: TenantContext;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Direct receipt returns");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  owner = await createMember(db, orgId, "OWNER");
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
  scopedAdminB = await createMember(db, orgId, "ADMIN");
  await db.membership.update({ where: { id: scopedAdminB.membershipId }, data: { allBranches: false } });
  await db.membershipBranch.create({
    data: { orgId, membershipId: scopedAdminB.membershipId, branchId: tenant.branchB.id },
  });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const KEY = () => `drr-${uniqueCode()}`;

async function product(costMinor = 100) {
  const p = await createProduct(db, orgId);
  await db.product.update({ where: { id: p.id }, data: { costMinor } });
  return p;
}

async function onHand(productId: string) {
  const [qty] = await getOnHand(db, orgId, branchId, [{ productId, variantId: null }]);
  return qty;
}

/** A direct receipt at branch A with one line per `[productId, qty, cost]`. */
async function directReceipt(lines: [string, number, number][], supplierId?: string): Promise<DirectReceiptDetail> {
  const s = supplierId ?? (await createSupplier(admin, { name: `Direct ${uniqueCode()}` })).id;
  const { receiptId } = await receiveWithoutPo(admin, KEY(), {
    branchId,
    supplierId: s,
    lines: lines.map(([productId, qty, unitCostMinor]) => ({ ref: { productId }, qty, unitCostMinor })),
  });
  return getDirectReceipt(admin, receiptId);
}

describe("returning a direct receipt", () => {
  it("takes the stock out, writes the ledger and audit, values at receipt cost and keeps last cost", async () => {
    const a = await product();
    const receipt = await directReceipt([[a.id, 5, 120]]);
    const line = receipt.lines[0];
    expect(await onHand(a.id)).toBe(5);

    const result = await returnDirectReceipt(admin, receipt.id, KEY(), {
      reason: "DAMAGED",
      note: "Crushed box",
      lines: [{ goodsReceiptItemId: line.id, qty: 3 }],
    });
    expect(result.created).toBe(true);
    expect(await onHand(a.id)).toBe(2);
    expect((await db.product.findUniqueOrThrow({ where: { id: a.id } })).costMinor).toBe(120);

    const row = await db.purchaseReturn.findUniqueOrThrow({ where: { id: result.returnId } });
    expect(row).toMatchObject({
      purchaseOrderId: null,
      goodsReceiptId: receipt.id,
      supplierId: receipt.supplier.id,
      branchId,
      seq: 1,
    });
    const ledger = await db.inventoryMovement.findMany({ where: { orgId, refId: result.returnId } });
    expect(ledger).toMatchObject([{ reason: "PURCHASE_RETURN", refType: "PurchaseReturn", qtyDelta: -3 }]);

    const number = formatReturnNumber(formatDirectReceiptNumber(receipt.id), 1);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "purchasing.return.created", entityId: result.returnId },
    });
    expect(event.metadata).toMatchObject({
      direct: true,
      goodsReceiptId: receipt.id,
      number,
      reason: "DAMAGED",
      units: 3,
      valueMinor: 360,
    });

    const after = await getDirectReceipt(admin, receipt.id);
    expect(after.lines[0]).toMatchObject({ qtyReceived: 5, qtyReturned: 3, returnable: 2 });
    expect(after.returns).toMatchObject([{ id: result.returnId, number, units: 3, valueMinor: 360 }]);
    const detail = await getDirectReturn(manager, receipt.id, result.returnId);
    expect(detail.ret.number).toBe(number);
    expect(detail.lines).toEqual([{ goodsReceiptItemId: line.id, qty: 3, unitCostMinor: 120, lineTotalMinor: 360 }]);

    const second = await returnDirectReceipt(admin, receipt.id, KEY(), {
      reason: "OTHER",
      lines: [{ goodsReceiptItemId: line.id, qty: 2 }],
    });
    expect((await db.purchaseReturn.findUniqueOrThrow({ where: { id: second.returnId } })).seq).toBe(2);
  });

  it("refuses more than is returnable, across returns too, and nothing or a foreign line", async () => {
    const a = await product();
    const receipt = await directReceipt([[a.id, 4, 100]]);
    const line = receipt.lines[0].id;
    const err = await expectAppError(
      returnDirectReceipt(admin, receipt.id, KEY(), { reason: "OTHER", lines: [{ goodsReceiptItemId: line, qty: 5 }] }),
      409,
      "QTY_EXCEEDS_RETURNABLE",
    );
    expect(err.details).toMatchObject({ returnable: 4, requested: 5 });
    await returnDirectReceipt(admin, receipt.id, KEY(), {
      reason: "OTHER",
      lines: [{ goodsReceiptItemId: line, qty: 3 }],
    });
    await expectAppError(
      returnDirectReceipt(admin, receipt.id, KEY(), { reason: "OTHER", lines: [{ goodsReceiptItemId: line, qty: 2 }] }),
      409,
      "QTY_EXCEEDS_RETURNABLE",
    );
    await expectAppError(
      returnDirectReceipt(admin, receipt.id, KEY(), { reason: "OTHER", lines: [{ goodsReceiptItemId: line, qty: 0 }] }),
      422,
      "NOTHING_TO_RETURN",
    );
    const other = await directReceipt([[a.id, 1, 100]]);
    await expectAppError(
      returnDirectReceipt(admin, receipt.id, KEY(), {
        reason: "OTHER",
        lines: [{ goodsReceiptItemId: other.lines[0].id, qty: 1 }],
      }),
      404,
    );
    expect(await onHand(a.id)).toBe(2);
  });

  it("refuses a PO receipt: its goods go back through the PO", async () => {
    const a = await product();
    const s = await createSupplier(admin, { name: `PO ${uniqueCode()}` });
    const draft = await createPurchaseOrder(admin, {
      branchId,
      supplierId: s.id,
      lines: [{ ref: { productId: a.id }, qty: 2, unitCostMinor: 100 }],
    });
    const po = await orderPurchaseOrder(admin, draft.id);
    const { receiptId } = await receivePurchaseOrder(admin, po.id, KEY(), {
      lines: [{ poItemId: po.lines[0].id, qty: 2 }],
    });
    const item = await db.goodsReceiptItem.findFirstOrThrow({ where: { goodsReceiptId: receiptId } });
    await expectAppError(
      returnDirectReceipt(admin, receiptId, KEY(), {
        reason: "OTHER",
        lines: [{ goodsReceiptItemId: item.id, qty: 1 }],
      }),
      404,
    );
    await expectAppError(getDirectReceipt(admin, receiptId), 404);
    expect(await onHand(a.id)).toBe(2);
  });

  it("lets only one of two concurrent returns of the last units through", async () => {
    const a = await product();
    const receipt = await directReceipt([[a.id, 3, 100]]);
    const body = { reason: "DEFECTIVE" as const, lines: [{ goodsReceiptItemId: receipt.lines[0].id, qty: 3 }] };
    const results = await Promise.allSettled([
      returnDirectReceipt(admin, receipt.id, KEY(), body),
      returnDirectReceipt(admin, receipt.id, KEY(), body),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await onHand(a.id)).toBe(0);
    expect(await db.purchaseReturn.count({ where: { orgId, goodsReceiptId: receipt.id } })).toBe(1);
  });

  it("replays the same key and body, and refuses the key with another body", async () => {
    const a = await product();
    const receipt = await directReceipt([[a.id, 5, 100]]);
    const key = KEY();
    const body = { reason: "WRONG_ITEM" as const, lines: [{ goodsReceiptItemId: receipt.lines[0].id, qty: 2 }] };
    const first = await returnDirectReceipt(admin, receipt.id, key, body);
    expect(await returnDirectReceipt(admin, receipt.id, key, body)).toEqual({
      returnId: first.returnId,
      created: false,
    });
    expect(await onHand(a.id)).toBe(3);
    await expectAppError(
      returnDirectReceipt(admin, receipt.id, key, { ...body, reason: "OTHER" }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("follows the shop's negative-stock rule", async () => {
    const a = await product();
    const receipt = await directReceipt([[a.id, 4, 100]]);
    await adjustStock(admin, {
      branchId,
      ref: { productId: a.id, variantId: null },
      adjustmentReason: "LOST_OR_STOLEN",
      qtyDelta: -3,
      expectedOnHand: 4,
    });
    const body = { reason: "DAMAGED" as const, lines: [{ goodsReceiptItemId: receipt.lines[0].id, qty: 2 }] };
    await expectAppError(returnDirectReceipt(admin, receipt.id, KEY(), body), 409, "INSUFFICIENT_STOCK");
    expect((await getDirectReceipt(admin, receipt.id)).lines[0].qtyReturned).toBe(0);
    await db.organization.update({ where: { id: orgId }, data: { blockNegativeStock: false } });
    try {
      await returnDirectReceipt(admin, receipt.id, KEY(), body);
      expect(await onHand(a.id)).toBe(-1);
    } finally {
      await db.organization.update({ where: { id: orgId }, data: { blockNegativeStock: true } });
    }
  });
});

describe("access", () => {
  it("refuses a manager (no purchases.manage), audited, but lets them view", async () => {
    const a = await product();
    const receipt = await directReceipt([[a.id, 1, 100]]);
    await expectAppError(
      returnDirectReceipt(manager, receipt.id, KEY(), {
        reason: "OTHER",
        lines: [{ goodsReceiptItemId: receipt.lines[0].id, qty: 1 }],
      }),
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
    expect((await getDirectReceipt(manager, receipt.id)).id).toBe(receipt.id);
  });

  it("refuses a shop linked to the inventory system", async () => {
    const a = await product();
    const receipt = await directReceipt([[a.id, 1, 100]]);
    await db.organization.update({ where: { id: orgId }, data: { inventorySource: "EXTERNAL" } });
    try {
      await expectAppError(
        returnDirectReceipt(admin, receipt.id, KEY(), {
          reason: "OTHER",
          lines: [{ goodsReceiptItemId: receipt.lines[0].id, qty: 1 }],
        }),
        409,
        "MANAGED_BY_INVENTORY",
      );
    } finally {
      await db.organization.update({ where: { id: orgId }, data: { inventorySource: "BUILT_IN" } });
    }
    expect(await onHand(a.id)).toBe(1);
  });

  it("hides another branch's and another org's receipt (404), replay included", async () => {
    const a = await product();
    const receipt = await directReceipt([[a.id, 2, 100]]);
    const body = { reason: "OTHER" as const, lines: [{ goodsReceiptItemId: receipt.lines[0].id, qty: 1 }] };
    await expectAppError(returnDirectReceipt(scopedAdminB, receipt.id, KEY(), body), 404);
    const key = KEY();
    const first = await returnDirectReceipt(admin, receipt.id, key, body);
    await expectAppError(returnDirectReceipt(scopedAdminB, receipt.id, key, body), 404);
    await expectAppError(getDirectReceipt(scopedAdminB, receipt.id), 404);
    await expectAppError(getDirectReturn(scopedAdminB, receipt.id, first.returnId), 404);

    const other = await createTenant(db, "Direct receipt returns other");
    const otherAdmin = await createMember(db, other.org.id, "ADMIN");
    await expectAppError(returnDirectReceipt(otherAdmin, receipt.id, KEY(), body), 404);
    await expectAppError(getDirectReturn(otherAdmin, receipt.id, first.returnId), 404);
    await expectAppError(getDirectReturn(admin, receipt.id, randomUUID()), 404);
    expect(await onHand(a.id)).toBe(1);
  });
});

describe("supplier account and reports", () => {
  it("lowers the balance, can be credited, and shows in the purchases report and supplier balances", async () => {
    const s = await createSupplier(admin, { name: `Account ${uniqueCode()}` });
    const a = await product();
    const receipt = await directReceipt([[a.id, 4, 250]], s.id);
    const ret = await returnDirectReceipt(admin, receipt.id, KEY(), {
      reason: "DEFECTIVE",
      lines: [{ goodsReceiptItemId: receipt.lines[0].id, qty: 1 }],
    });
    const number = formatReturnNumber(receipt.number, 1);

    const statement = await getSupplierStatement(admin, s.id);
    expect(statement.balanceMinor).toBe(750);
    expect(statement.entries.find((e) => e.kind === "RETURN")).toMatchObject({
      id: ret.returnId,
      amountMinor: 250,
      number,
      purchaseOrderId: null,
    });

    const open = await listSupplierInvoices(admin, s.id);
    expect(open.uncreditedReturns).toMatchObject([{ id: ret.returnId, number, valueMinor: 250 }]);
    await recordSupplierInvoice(admin, s.id, KEY(), {
      kind: "CREDIT_NOTE",
      number: `CN-${uniqueCode()}`,
      issuedOn: open.today,
      netMinor: 250,
      vatMinor: 35,
      purchaseReturnId: ret.returnId,
    });
    expect((await listSupplierInvoices(admin, s.id)).uncreditedReturns).toEqual([]);
    // The credit note replaces the return's at-cost value with its total, VAT included (I7).
    expect((await getSupplierStatement(admin, s.id)).balanceMinor).toBe(1000 - 285);

    const report = await getReport(owner, "purchases", {});
    expect(report.rows.find((r) => r.supplierId === s.id)).toMatchObject({
      receiptsCount: 1,
      valueMinor: 1000,
      returnedUnits: 1,
      returnedValueMinor: 250,
      netValueMinor: 750,
    });
    const balances = await getReport(owner, "supplier-balances", {
      from: open.today.slice(0, 8) + "01",
      to: open.today,
    });
    expect(balances.rows.find((r) => r.supplierId === s.id)).toMatchObject({
      receivedMinor: 1000,
      returnedMinor: 250,
      closingMinor: 1000 - 285,
    });
  });
});
