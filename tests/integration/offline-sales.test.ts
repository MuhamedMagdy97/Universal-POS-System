import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { setInventorySource } from "@/modules/integrations/inventory-sys";
import * as inventory from "@/modules/inventory";
import { enrolOfflineDevice, getOfflineSettings, revokeOfflineDevice, updateOfflineSettings } from "@/modules/org";
import { closeShift, getZReport, openShift } from "@/modules/registers";
import { createSale, requestHashOf } from "@/modules/sales";
import { priceSale, type Discount } from "@/modules/sales/totals";
import { createMember, createProduct, createTenant, expectAppError, expectReconciled, testDb } from "./helpers";

/**
 * Offline till slice 1 (docs/planning/offline-till/offline-till-spec.md §3, integration): the shop setting, device
 * enrolment and revoke, the per-register series, and offline sales accepted as sold with their review flags.
 */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let shiftId: string;
let owner: TenantContext;
let admin: TenantContext;
let manager: TenantContext;
let cashier: TenantContext;
let device: { deviceId: string; deviceSecret: string; offlineCode: string };

const KEY = () => `off-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const HOUR = 60 * 60_000;
let seq = 0;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Offline");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  admin = await createMember(db, orgId, "ADMIN");
  manager = await createMember(db, orgId, "MANAGER");
  cashier = await createMember(db, orgId, "CASHIER");
  shiftId = (await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 })).id;
  // Opened well before the test sales' soldAt, so only the clock-skew test is before the shift.
  await db.registerShift.update({ where: { id: shiftId }, data: { openedAt: new Date(Date.now() - 2 * HOUR) } });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

async function stocked(qty: number, priceMinor = 1000) {
  const product = await createProduct(db, orgId);
  await db.product.update({ where: { id: product.id }, data: { priceMinor } });
  if (qty > 0) {
    await inventory.recordOpeningBalances(owner, {
      branchId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty }],
    });
  }
  return product;
}

type Cart = {
  items: { productId: string; qty: number; priceMinor: number; discount?: Discount }[];
  discount?: Discount;
  vatRateBp?: number;
};

/** The body the till would send: totals from the shared totals.ts, as the device computes them. */
function offlineBody(
  cart: Cart,
  over: Partial<{
    registerId: string;
    shiftId: string;
    number: string;
    soldAt: Date;
    snapshotAt: Date;
    deviceId: string;
    deviceSecret: string;
    cashierId: string;
  }> = {},
) {
  const priced = priceSale(
    cart.items.map((item) => ({
      unitPriceMinor: item.priceMinor,
      qty: item.qty,
      vatApplicable: true,
      discount: item.discount,
    })),
    cart.discount,
    cart.vatRateBp ?? 1400,
    true,
  );
  const soldAt = over.soldAt ?? new Date(Date.now() - 60_000);

  return {
    branchId,
    registerId: over.registerId ?? registerId,
    lines: cart.items.map((item) => ({
      ref: { productId: item.productId, variantId: null },
      qty: item.qty,
      ...(item.discount && { discount: item.discount }),
    })),
    ...(cart.discount && { discount: cart.discount }),
    payments: [{ method: "CASH" as const, amountMinor: priced.totalMinor }],
    offline: {
      deviceId: over.deviceId ?? device.deviceId,
      deviceSecret: over.deviceSecret ?? device.deviceSecret,
      number: over.number ?? `${device.offlineCode}-${String(++seq).padStart(6, "0")}`,
      soldAt: soldAt.toISOString(),
      snapshotAt: (over.snapshotAt ?? new Date(soldAt.getTime() - HOUR)).toISOString(),
      snapshotVersion: 1,
      shiftId: over.shiftId ?? shiftId,
      cashierId: over.cashierId ?? cashier.userId,
      lines: cart.items.map((item, index) => ({
        unitPriceMinor: item.priceMinor,
        discountMinor: priced.lines[index].discountMinor,
        lineTotalMinor: priced.lines[index].lineTotalMinor,
      })),
      subtotalMinor: priced.subtotalMinor,
      vatMinor: priced.vatMinor,
      totalMinor: priced.totalMinor,
    },
  };
}

const flagsOf = async (saleId: string) =>
  (await db.sale.findUniqueOrThrow({ where: { id: saleId }, select: { offlineFlags: true } })).offlineFlags;

const flaggedRows = (saleId: string) =>
  db.auditEvent.findMany({ where: { orgId, action: "sale.offline.flagged", entityId: saleId } });

describe("offline settings and devices", () => {
  it("is off by default, Owner only, and audited", async () => {
    expect((await getOfflineSettings(admin)).allowOfflineSales).toBe(false);
    await expectAppError(enrolOfflineDevice(owner, registerId), 409, "OFFLINE_DISABLED");
    await expectAppError(updateOfflineSettings(admin, { allowOfflineSales: true }), 403);
    await expectAppError(updateOfflineSettings(manager, { allowOfflineSales: true }), 403);

    await updateOfflineSettings(owner, { allowOfflineSales: true });
    const event = await db.auditEvent.findFirstOrThrow({ where: { orgId, action: "settings.offline.updated" } });
    expect(event.metadata).toMatchObject({ allowOfflineSales: { from: false, to: true } });
  });

  it("enrols one device per register, gives each register its own series code, and stores only a hash", async () => {
    await expectAppError(enrolOfflineDevice(admin, registerId), 403);
    device = await enrolOfflineDevice(owner, registerId);
    expect(device).toMatchObject({ registerId, offlineCode: "T1", lastOfflineSaleNo: 0 });
    const row = await db.registerDevice.findUniqueOrThrow({ where: { id: device.deviceId } });
    expect(row.secretHash).not.toContain(device.deviceSecret);
    await expectAppError(enrolOfflineDevice(owner, registerId), 409, "DEVICE_ALREADY_ENROLLED");

    const second = await db.register.create({ data: { orgId, branchId, name: "Till 2" } });
    expect((await enrolOfflineDevice(owner, second.id)).offlineCode).toBe("T2");
    const settings = await getOfflineSettings(admin);
    expect(settings.canManage).toBe(false);
    expect(settings.registers.find((r) => r.id === registerId)?.device?.id).toBe(device.deviceId);
  });

  it("refuses linking to the inventory system while offline is on", async () => {
    await expectAppError(setInventorySource(owner, { source: "EXTERNAL" }), 409, "OFFLINE_ENABLED");
  });

  it("refuses offline for a linked shop", async () => {
    const other = await createTenant(db, "OfflineLinked");
    const otherOwner = await createMember(db, other.org.id, "OWNER");
    await db.organization.update({ where: { id: other.org.id }, data: { inventorySource: "EXTERNAL" } });
    await expectAppError(updateOfflineSettings(otherOwner, { allowOfflineSales: true }), 409, "INVENTORY_LINKED");
  });
});

describe("offline sales", () => {
  it("records the sale as sold: device number, soldAt, cashier; the replayer is the audit actor", async () => {
    const product = await stocked(5);
    const before = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { lastSaleNo: true } });
    const body = offlineBody({ items: [{ productId: product.id, qty: 2, priceMinor: 1000 }] });
    const { sale, created } = await createSale(manager, body, KEY());

    expect(created).toBe(true);
    expect(sale).toMatchObject({ number: body.offline.number, totalMinor: 2000, vatMinor: 246, shiftId });
    const row = await db.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.cashierId).toBe(cashier.userId);
    expect(row.createdAt.toISOString()).toBe(body.offline.soldAt);
    expect(row.receivedAt).not.toBeNull();
    expect(row.offlineFlags).toEqual([]);
    // The org series is untouched; the register's moves.
    const after = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { lastSaleNo: true } });
    expect(after.lastSaleNo).toBe(before.lastSaleNo);
    expect((await db.register.findUniqueOrThrow({ where: { id: registerId } })).lastOfflineSaleNo).toBe(seq);
    expect((await db.stockBalance.findFirstOrThrow({ where: { orgId, productId: product.id } })).qty).toBe(3);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { orgId, action: "sale.created", entityId: sale.id } });
    expect(audit.actorUserId).toBe(manager.userId);
    expect(audit.metadata).toMatchObject({ offline: { deviceId: device.deviceId, cashierId: cashier.userId } });
    expect(JSON.stringify(audit.metadata)).not.toContain(device.deviceSecret);
  });

  it("replays the same key and body as one sale, and refuses the key with another body", async () => {
    const product = await stocked(5);
    const body = offlineBody({ items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] });
    const key = KEY();
    const first = await createSale(cashier, body, key);
    const again = await createSale(cashier, body, key);
    expect(again).toMatchObject({ created: false, sale: { id: first.sale.id } });
    expect(await db.sale.count({ where: { orgId, number: body.offline.number } })).toBe(1);
    const other = { ...body, offline: { ...body.offline, soldAt: new Date().toISOString() } };
    await expectAppError(createSale(cashier, other, key), 409, "IDEMPOTENCY_CONFLICT");
  });

  it("keeps online sales hashing as before (no offline block)", async () => {
    const product = await stocked(1);
    const body = {
      branchId,
      registerId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty: 1 }],
      payments: [{ method: "CASH", amountMinor: 1000 }],
    };
    const { sale } = await createSale(cashier, body, KEY());
    const row = await db.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.requestHash).toBe(
      requestHashOf({ ...body, payments: [{ method: "CASH", amountMinor: 1000, reference: null }] }),
    );
    expect(row.receivedAt).toBeNull();
  });

  it("flags a changed price and keeps the device price", async () => {
    const product = await stocked(5, 1200);
    const body = offlineBody({ items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] });
    const { sale } = await createSale(cashier, body, KEY());
    expect(sale.lines[0]).toMatchObject({ unitPriceMinor: 1000, lineTotalMinor: 1000 });
    expect(await flagsOf(sale.id)).toEqual(["PRICE_CHANGED"]);
    const [row] = await flaggedRows(sale.id);
    expect(row.metadata).toMatchObject({
      flag: "PRICE_CHANGED",
      lines: [{ sku: product.sku, soldMinor: 1000, currentMinor: 1200 }],
    });
  });

  it("sells an archived item and flags it", async () => {
    const product = await stocked(5);
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    const { sale } = await createSale(
      cashier,
      offlineBody({ items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] }),
      KEY(),
    );
    expect(await flagsOf(sale.id)).toEqual(["ITEM_ARCHIVED"]);
  });

  it("takes stock below zero even with the negative-stock rule on, and flags it", async () => {
    const product = await stocked(0);
    const { sale } = await createSale(
      cashier,
      offlineBody({ items: [{ productId: product.id, qty: 2, priceMinor: 1000 }] }),
      KEY(),
    );
    expect(await flagsOf(sale.id)).toEqual(["STOCK_NEGATIVE"]);
    expect((await db.stockBalance.findFirstOrThrow({ where: { orgId, productId: product.id } })).qty).toBe(-2);
    const [row] = await flaggedRows(sale.id);
    expect(row.metadata).toMatchObject({ lines: [{ sku: product.sku, qty: -2 }] });
  });

  it("records a discount over the cashier's limit without a denial row, and flags it", async () => {
    const product = await stocked(5);
    const denied = await db.auditEvent.count({ where: { orgId, action: "sales.discount.denied" } });
    const { sale } = await createSale(
      cashier,
      offlineBody({
        items: [{ productId: product.id, qty: 1, priceMinor: 1000 }],
        discount: { kind: "PERCENT", percentBp: 2000 },
      }),
      KEY(),
    );
    expect(sale.discountMinor).toBe(200);
    expect(await flagsOf(sale.id)).toEqual(["DISCOUNT_OVER_LIMIT"]);
    expect(await db.auditEvent.count({ where: { orgId, action: "sales.discount.denied" } })).toBe(denied);
  });

  it("attaches a late sale to its closed shift, flags it, and the shift report counts it", async () => {
    const till = await db.register.create({ data: { orgId, branchId, name: `Late ${seq}` } });
    const enrolled = await enrolOfflineDevice(owner, till.id);
    const shift = await openShift(cashier, { branchId, registerId: till.id, openingFloatMinor: 0 });
    await closeShift(cashier, shift.id, { countedCashMinor: 0 });
    const product = await stocked(5);
    const { sale } = await createSale(
      cashier,
      offlineBody(
        { items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] },
        {
          registerId: till.id,
          shiftId: shift.id,
          deviceId: enrolled.deviceId,
          deviceSecret: enrolled.deviceSecret,
          number: `${enrolled.offlineCode}-000001`,
          soldAt: new Date(),
          snapshotAt: new Date(Date.now() - HOUR),
        },
      ),
      KEY(),
    );
    expect(sale.shiftId).toBe(shift.id);
    expect(await flagsOf(sale.id)).toEqual(["LATE_FOR_CLOSED_SHIFT"]);
    const report = await getZReport(manager, shift.id);
    // Cash sales now include the late sale; the stored close figures are not rewritten (OF13, risks).
    expect(report).toMatchObject({ cashSalesMinor: 1000, expectedCashMinor: 0, countedCashMinor: 0 });
  });

  it("flags a snapshot over 24 h old at sale time, and a soldAt in the future", async () => {
    const product = await stocked(5);
    const stale = await createSale(
      cashier,
      offlineBody(
        { items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] },
        { snapshotAt: new Date(Date.now() - 26 * HOUR) },
      ),
      KEY(),
    );
    expect(await flagsOf(stale.sale.id)).toEqual(["STALE_SNAPSHOT"]);
    const future = await createSale(
      cashier,
      offlineBody(
        { items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] },
        { soldAt: new Date(Date.now() + HOUR) },
      ),
      KEY(),
    );
    expect(await flagsOf(future.sale.id)).toEqual(["CLOCK_SKEW"]);
  });

  it("keeps the device's totals when the VAT rate changed since the snapshot, and flags it", async () => {
    const product = await stocked(5, 1150);
    const body = offlineBody({ items: [{ productId: product.id, qty: 1, priceMinor: 1150 }], vatRateBp: 1500 });
    const { sale } = await createSale(cashier, body, KEY());
    expect(sale).toMatchObject({ totalMinor: 1150, vatMinor: body.offline.vatMinor });
    expect(sale.lines[0].vatMinor).toBe(body.offline.vatMinor);
    expect(await flagsOf(sale.id)).toEqual(["TOTALS_DIFFER"]);
  });

  it("keeps the series gap-free and unique per register", async () => {
    const product = await stocked(5);
    const body = offlineBody({ items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] });
    await createSale(cashier, body, KEY());
    // Same number, other sale: refused, nothing written.
    const clash = offlineBody(
      { items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] },
      { number: body.offline.number },
    );
    await expectAppError(createSale(cashier, clash, KEY()), 409, "OFFLINE_NUMBER_TAKEN");
    const numbers = (
      await db.sale.findMany({ where: { orgId, registerId, number: { startsWith: "T1-" } }, select: { number: true } })
    )
      .map((s) => Number(s.number.slice(3)))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    expect((await db.register.findUniqueOrThrow({ where: { id: registerId } })).lastOfflineSaleNo).toBe(numbers.length);
  });
});

describe("offline hard refusals", () => {
  it("refuses malformed bodies, unknown items, wrong register or shift, and an unknown device", async () => {
    const product = await stocked(5);
    const cart = { items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] };
    const count = () => db.sale.count({ where: { orgId } });
    const before = await count();

    const bad = offlineBody(cart);
    await expectAppError(
      createSale(cashier, { ...bad, offline: { ...bad.offline, totalMinor: 999 } }, KEY()),
      422,
      "OFFLINE_SALE_INVALID",
    );
    // Walk-in only offline (OF3).
    await expect(
      createSale(cashier, { ...offlineBody(cart), customerId: crypto.randomUUID() }, KEY()),
    ).rejects.toBeInstanceOf(ZodError);
    await expectAppError(
      createSale(cashier, offlineBody({ items: [{ ...cart.items[0], productId: crypto.randomUUID() }] }), KEY()),
      404,
    );
    await expectAppError(
      createSale(cashier, offlineBody(cart, { number: "T9-000001" }), KEY()),
      422,
      "OFFLINE_SALE_INVALID",
    );
    await expectAppError(createSale(cashier, offlineBody(cart, { shiftId: crypto.randomUUID() }), KEY()), 404);
    await expectAppError(
      createSale(cashier, offlineBody(cart, { deviceSecret: "x".repeat(43) }), KEY()),
      403,
      "DEVICE_NOT_ENROLLED",
    );
    await expectAppError(
      createSale(cashier, offlineBody(cart, { deviceId: crypto.randomUUID() }), KEY()),
      403,
      "DEVICE_NOT_ENROLLED",
    );
    const till2 = await db.register.findFirstOrThrow({ where: { orgId, name: "Till 2" } });
    await expectAppError(
      createSale(cashier, offlineBody(cart, { registerId: till2.id }), KEY()),
      403,
      "DEVICE_NOT_ENROLLED",
    );
    expect(await count()).toBe(before);
  });

  it("refuses a revoked device; re-enrolment continues the register's series", async () => {
    const product = await stocked(5);
    const last = (await db.register.findUniqueOrThrow({ where: { id: registerId } })).lastOfflineSaleNo;
    await expectAppError(revokeOfflineDevice(manager, registerId), 403);
    await revokeOfflineDevice(owner, registerId);
    await expectAppError(
      createSale(cashier, offlineBody({ items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] }), KEY()),
      403,
      "DEVICE_REVOKED",
    );
    const again = await enrolOfflineDevice(owner, registerId);
    expect(again).toMatchObject({ offlineCode: "T1", lastOfflineSaleNo: last });
    expect(
      await db.auditEvent.count({
        where: { orgId, action: { in: ["register.offline.enrolled", "register.offline.revoked"] } },
      }),
    ).toBeGreaterThanOrEqual(4);
  });

  it("refuses an offline sale for a shop that got linked", async () => {
    const other = await createTenant(db, "OfflineLater");
    const otherOwner = await createMember(db, other.org.id, "OWNER");
    const otherCashier = await createMember(db, other.org.id, "CASHIER");
    await updateOfflineSettings(otherOwner, { allowOfflineSales: true });
    const enrolled = await enrolOfflineDevice(otherOwner, other.register.id);
    const shift = await openShift(otherCashier, {
      branchId: other.branchA.id,
      registerId: other.register.id,
      openingFloatMinor: 0,
    });
    const product = await createProduct(db, other.org.id);
    await db.organization.update({ where: { id: other.org.id }, data: { inventorySource: "EXTERNAL" } });
    const body = offlineBody(
      { items: [{ productId: product.id, qty: 1, priceMinor: 1000 }] },
      {
        registerId: other.register.id,
        shiftId: shift.id,
        deviceId: enrolled.deviceId,
        deviceSecret: enrolled.deviceSecret,
        cashierId: otherCashier.userId,
        number: `${enrolled.offlineCode}-000001`,
      },
    );
    await expectAppError(
      createSale(otherCashier, { ...body, branchId: other.branchA.id }, KEY()),
      409,
      "OFFLINE_NOT_ALLOWED",
    );
  });
});
