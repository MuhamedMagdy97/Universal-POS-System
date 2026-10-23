import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { enrolOfflineDevice, reportOfflineQueue, revokeOfflineDevice, updateOfflineSettings } from "@/modules/org";
import { closeShift, openShift } from "@/modules/registers";
import { createSale, getReceipt, getTillSnapshot } from "@/modules/sales";
import { buildOfflineSale, searchSnapshot } from "@/app/(app)/pos/_lib/offline";
import type { CartLine } from "@/app/(app)/pos/_lib/till";
import { createMember, createProduct, createTenant, expectAppError, expectReconciled, testDb } from "./helpers";

/**
 * Offline till slice 2 (offline-till-spec OF7, OF9, OF11): the register's snapshot, and a sale the device builds from
 * it is recorded as sold with no review flag, and its reprint says "Offline sale".
 */

let db: Db;
let orgId: string;
let branchId: string;
let otherBranchId: string;
let registerId: string;
let owner: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "OfflineSnap");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  otherBranchId = tenant.branchB.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("till snapshot", () => {
  it("lists sellable items with barcodes and no cost, the shop, the user and no device before enrolment", async () => {
    const tea = await createProduct(db, orgId);
    await db.product.update({ where: { id: tea.id }, data: { costMinor: 400, priceMinor: 1250 } });
    await db.barcode.create({ data: { orgId, productId: tea.id, code: "6221234567890", isPrimary: true } });
    const archived = await createProduct(db, orgId);
    await db.product.update({ where: { id: archived.id }, data: { isActive: false } });

    const expires = new Date(Date.now() + 3_600_000);
    const snap = await getTillSnapshot(cashier, branchId, registerId, expires);
    expect(snap).toMatchObject({
      version: 1,
      branchId,
      allowOfflineSales: false,
      register: { id: registerId, name: "Till 1", offlineCode: null, deviceId: null },
      shift: null,
      user: { id: cashier.userId, role: "CASHIER" },
      sessionExpiresAt: expires.toISOString(),
      settings: { currency: "EGP", vatRateBp: 1400, pricesIncludeVat: true },
      timeZone: "Africa/Cairo",
      zatcaVatNumber: null,
    });
    const item = snap.items.find((i) => i.productId === tea.id);
    expect(item).toMatchObject({ unitPriceMinor: 1250, barcodes: ["6221234567890"] });
    expect(item).not.toHaveProperty("costMinor");
    expect(snap.items.some((i) => i.productId === archived.id)).toBe(false);
  });

  it("refuses a register of another branch and an unknown one", async () => {
    await expectAppError(getTillSnapshot(cashier, otherBranchId, registerId, null), 404);
    await expectAppError(getTillSnapshot(cashier, branchId, "00000000-0000-4000-8000-000000000000", null), 404);
  });
});

describe("a sale built on the device", () => {
  it("is recorded as sold with no flag, and its reprint is marked offline", async () => {
    await updateOfflineSettings(owner, { allowOfflineSales: true });
    const enrolled = await enrolOfflineDevice(owner, registerId);
    await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
    const product = await createProduct(db, orgId);
    await db.product.update({ where: { id: product.id }, data: { priceMinor: 1999 } });
    await inventory.recordOpeningBalances(owner, {
      branchId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty: 10 }],
    });

    const snap = await getTillSnapshot(cashier, branchId, registerId, null);
    expect(snap).toMatchObject({
      allowOfflineSales: true,
      register: { offlineCode: "T1", deviceId: enrolled.deviceId },
    });
    const [found] = searchSnapshot(snap.items, product.sku);
    const cart: CartLine[] = [{ ...found, qty: 3, discount: { kind: "PERCENT", percentBp: 500 } }];
    const body = {
      branchId,
      registerId,
      lines: [
        {
          ref: { productId: product.id, variantId: null },
          qty: 3,
          discount: { kind: "PERCENT" as const, percentBp: 500 },
        },
      ],
      payments: [{ method: "CASH" as const, amountMinor: 10_000 }],
    };
    const built = buildOfflineSale({
      body,
      cart,
      saleDiscount: null,
      plan: { payments: body.payments, changeMinor: 0 },
      snapshot: snap,
      device: enrolled,
      seq: enrolled.lastOfflineSaleNo + 1,
      soldAt: new Date(),
    });

    const { sale } = await createSale(cashier, built.body, `snap-${Date.now()}`);
    expect(sale).toMatchObject({ number: "T1-000001", totalMinor: built.receipt.totalMinor });
    expect(sale.changeMinor).toBe(built.receipt.changeMinor);
    const row = await db.sale.findUniqueOrThrow({ where: { id: sale.id }, select: { offlineFlags: true } });
    expect(row.offlineFlags).toEqual([]);

    const reprint = await getReceipt(cashier, sale.id, { kind: "SALE", copy: false });
    expect(reprint).toMatchObject({
      offline: true,
      saleNumber: "T1-000001",
      totalMinor: built.receipt.totalMinor,
      vatMinor: built.receipt.vatMinor,
      payments: built.receipt.payments,
      changeMinor: built.receipt.changeMinor,
    });
  });
});

describe("unsynced offline sales at shift close (OF14)", () => {
  it("stores the enrolled device's report, and refuses a forged or revoked one", async () => {
    const register = await db.register.create({ data: { orgId, branchId, name: "Till R" } });
    const device = await enrolOfflineDevice(owner, register.id);
    const report = {
      registerId: register.id,
      deviceId: device.deviceId,
      deviceSecret: device.deviceSecret,
      queued: 3,
      oldestAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await reportOfflineQueue(cashier, report);
    const row = await db.registerDevice.findUniqueOrThrow({ where: { id: device.deviceId } });
    expect(row).toMatchObject({ reportedQueued: 3, reportedOldestAt: new Date(report.oldestAt) });
    expect(row.reportedAt).not.toBeNull();

    await expectAppError(reportOfflineQueue(cashier, { ...report, deviceSecret: "x".repeat(43) }), 403);
    await expectAppError(reportOfflineQueue(cashier, { ...report, registerId }), 403);
    await revokeOfflineDevice(owner, register.id);
    await expectAppError(reportOfflineQueue(cashier, report), 403, "DEVICE_REVOKED");
  });

  it("asks for a note to close while the device reports unsynced sales, and records it", async () => {
    const register = await db.register.create({ data: { orgId, branchId, name: "Till C" } });
    const device = await enrolOfflineDevice(owner, register.id);
    const shift = await openShift(cashier, { branchId, registerId: register.id, openingFloatMinor: 0 });
    const report = { registerId: register.id, deviceId: device.deviceId, deviceSecret: device.deviceSecret };
    await reportOfflineQueue(cashier, { ...report, queued: 2, oldestAt: new Date().toISOString() });

    await expectAppError(closeShift(owner, shift.id, { countedCashMinor: 0 }), 409, "OFFLINE_SALES_UNSYNCED");
    const closed = await closeShift(owner, shift.id, { countedCashMinor: 0, unsyncedNote: "Till 3 is offline" });
    expect(closed.status).toBe("CLOSED");
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "shift.closed", entityId: shift.id },
    });
    expect(audit.metadata).toMatchObject({ unsyncedOffline: { queued: 2, note: "Till 3 is offline" } });

    // Once the device reports an empty queue, the next close needs no note.
    await reportOfflineQueue(cashier, { ...report, queued: 0, oldestAt: null });
    const next = await openShift(cashier, { branchId, registerId: register.id, openingFloatMinor: 0 });
    expect((await closeShift(owner, next.id, { countedCashMinor: 0 })).status).toBe("CLOSED");
  });
});
