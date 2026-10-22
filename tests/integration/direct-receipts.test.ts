import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { getOnHand } from "@/modules/inventory";
import {
  archiveSupplier,
  createSupplier,
  listDirectReceipts,
  listSupplierInvoices,
  receiveWithoutPo,
  recordSupplierInvoice,
} from "@/modules/purchasing";
import { formatDirectReceiptNumber } from "@/modules/purchasing/rules";
import { getReport } from "@/modules/reports";
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

/** Receiving without a PO (docs/planning/purchasing-direct-receipt/direct-receipt-spec.md). */

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let manager: TenantContext;
let scopedManager: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Direct receipts");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
  cashier = await createMember(db, orgId, "CASHIER");
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

const KEY = () => `drc-${uniqueCode()}`;

async function product(costMinor = 100) {
  const p = await createProduct(db, orgId);
  await db.product.update({ where: { id: p.id }, data: { costMinor } });
  return p;
}

async function onHand(productId: string, variantId: string | null = null, branch = branchId) {
  const [qty] = await getOnHand(db, orgId, branch, [{ productId, variantId }]);
  return qty;
}

describe("direct receipts", () => {
  it("adds stock through the ledger, sets last cost and audits, in one receipt with no PO", async () => {
    const s = await createSupplier(admin, { name: `Direct ${uniqueCode()}` });
    const a = await product(100);
    const p = await product(100);
    const v = await createVariant(db, orgId, p.id);
    const result = await receiveWithoutPo(manager, KEY(), {
      branchId,
      supplierId: s.id,
      note: "Walk-in delivery",
      lines: [
        { ref: { productId: a.id }, qty: 5, unitCostMinor: 130 },
        { ref: { productId: p.id, variantId: v.id }, qty: 2, unitCostMinor: 40 },
        // Repeated item: merged, later cost kept (P8).
        { ref: { productId: a.id }, qty: 1, unitCostMinor: 135 },
      ],
    });
    expect(result.created).toBe(true);

    const receipt = await db.goodsReceipt.findUniqueOrThrow({
      where: { id: result.receiptId },
      include: { items: true },
    });
    expect(receipt).toMatchObject({ purchaseOrderId: null, supplierId: s.id, branchId, note: "Walk-in delivery" });
    expect(receipt.items).toHaveLength(2);
    expect(receipt.items.every((item) => item.poItemId === null)).toBe(true);

    expect(await onHand(a.id)).toBe(6);
    expect(await onHand(p.id, v.id)).toBe(2);
    const ledger = await db.inventoryMovement.findMany({ where: { orgId, refId: result.receiptId } });
    expect(ledger).toHaveLength(2);
    expect(ledger.every((m) => m.reason === "PURCHASE_RECEIPT" && m.refType === "GoodsReceipt")).toBe(true);

    expect((await db.product.findUniqueOrThrow({ where: { id: a.id } })).costMinor).toBe(135);
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: v.id } })).costMinor).toBe(40);
    expect(await db.auditEvent.count({ where: { orgId, action: "catalog.cost.received", entityId: a.id } })).toBe(1);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "purchasing.receipt.created", entityId: result.receiptId },
    });
    expect(event.metadata).toMatchObject({ direct: true, supplierId: s.id, branchId, lineCount: 2, units: 8 });

    const list = await listDirectReceipts(manager);
    expect(list.rows[0]).toMatchObject({
      id: result.receiptId,
      number: formatDirectReceiptNumber(result.receiptId),
      supplier: { id: s.id },
      units: 8,
      valueMinor: 6 * 135 + 2 * 40,
    });
  });

  it("replays the same key and body, and refuses the key with another body", async () => {
    const s = await createSupplier(admin, { name: `Replay ${uniqueCode()}` });
    const a = await product();
    const key = KEY();
    const body = { branchId, supplierId: s.id, lines: [{ ref: { productId: a.id }, qty: 3, unitCostMinor: 90 }] };
    const first = await receiveWithoutPo(manager, key, body);
    const again = await receiveWithoutPo(manager, key, body);
    expect(again).toEqual({ receiptId: first.receiptId, created: false });
    expect(await onHand(a.id)).toBe(3);
    await expectAppError(
      receiveWithoutPo(manager, key, { ...body, lines: [{ ref: { productId: a.id }, qty: 4, unitCostMinor: 90 }] }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    // Concurrent duplicates: one receipt only.
    const raceKey = KEY();
    const [x, y] = await Promise.all([
      receiveWithoutPo(manager, raceKey, body),
      receiveWithoutPo(manager, raceKey, body),
    ]);
    expect(x.receiptId).toBe(y.receiptId);
    expect(await onHand(a.id)).toBe(6);
  });

  it("refuses a cashier (audited), an archived supplier, and a branch out of scope", async () => {
    const s = await createSupplier(admin, { name: `Refuse ${uniqueCode()}` });
    const a = await product();
    const body = { branchId, supplierId: s.id, lines: [{ ref: { productId: a.id }, qty: 1, unitCostMinor: 1 }] };
    await expectAppError(receiveWithoutPo(cashier, KEY(), body), 403);
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
    await expectAppError(receiveWithoutPo(scopedManager, KEY(), body), 404);
    await archiveSupplier(admin, s.id);
    await expectAppError(receiveWithoutPo(manager, KEY(), body), 409, "SUPPLIER_INACTIVE");
    expect(await onHand(a.id)).toBe(0);
  });

  it("keeps tenants apart: another org's supplier, item and receipts stay invisible", async () => {
    const other = await createTenant(db, "Direct other");
    const otherOwner = await createMember(db, other.org.id, "OWNER");
    const otherSupplier = await createSupplier(otherOwner, { name: `Other ${uniqueCode()}` });
    const otherProduct = await createProduct(db, other.org.id);
    const mine = await createSupplier(admin, { name: `Mine ${uniqueCode()}` });
    const a = await product();
    await expectAppError(
      receiveWithoutPo(manager, KEY(), {
        branchId,
        supplierId: otherSupplier.id,
        lines: [{ ref: { productId: a.id }, qty: 1, unitCostMinor: 1 }],
      }),
      404,
    );
    await expectAppError(
      receiveWithoutPo(manager, KEY(), {
        branchId,
        supplierId: mine.id,
        lines: [{ ref: { productId: otherProduct.id }, qty: 1, unitCostMinor: 1 }],
      }),
      404,
    );
    await expectAppError(
      receiveWithoutPo(otherOwner, KEY(), {
        branchId,
        supplierId: otherSupplier.id,
        lines: [{ ref: { productId: otherProduct.id }, qty: 1, unitCostMinor: 1 }],
      }),
      404,
    );
    const theirs = await receiveWithoutPo(otherOwner, KEY(), {
      branchId: other.branchA.id,
      supplierId: otherSupplier.id,
      lines: [{ ref: { productId: otherProduct.id }, qty: 1, unitCostMinor: 1 }],
    });
    expect((await listDirectReceipts(admin)).rows.map((r) => r.id)).not.toContain(theirs.receiptId);
  });

  it("is refused when the shop's stock comes from the inventory system", async () => {
    const linked = await createTenant(db, "Direct linked");
    const owner = await createMember(db, linked.org.id, "OWNER");
    const s = await createSupplier(owner, { name: `Linked ${uniqueCode()}` });
    const p = await createProduct(db, linked.org.id);
    await db.organization.update({ where: { id: linked.org.id }, data: { inventorySource: "EXTERNAL" } });
    await expectAppError(
      receiveWithoutPo(owner, KEY(), {
        branchId: linked.branchA.id,
        supplierId: s.id,
        lines: [{ ref: { productId: p.id }, qty: 1, unitCostMinor: 1 }],
      }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    expect(await db.goodsReceipt.count({ where: { orgId: linked.org.id } })).toBe(0);
  });

  it("counts in the purchases report, the supplier account and can be invoiced", async () => {
    const s = await createSupplier(admin, { name: `Report ${uniqueCode()}` });
    const a = await product();
    const { receiptId } = await receiveWithoutPo(manager, KEY(), {
      branchId,
      supplierId: s.id,
      lines: [{ ref: { productId: a.id }, qty: 4, unitCostMinor: 250 }],
    });
    const report = await getReport(admin, "purchases", {});
    const row = report.rows.find((r) => r.supplierId === s.id);
    expect(row).toMatchObject({ receiptsCount: 1, units: 4, valueMinor: 1000 });

    const before = await listSupplierInvoices(admin, s.id);
    expect(before.uninvoicedReceipts.map((r) => r.id)).toContain(receiptId);
    await recordSupplierInvoice(admin, s.id, KEY(), {
      kind: "INVOICE",
      number: `INV-${uniqueCode()}`,
      issuedOn: before.today,
      netMinor: 1000,
      vatMinor: 0,
      goodsReceiptIds: [receiptId],
    });
    const after = await listSupplierInvoices(admin, s.id);
    expect(after.uninvoicedReceipts.map((r) => r.id)).not.toContain(receiptId);
  });
});
