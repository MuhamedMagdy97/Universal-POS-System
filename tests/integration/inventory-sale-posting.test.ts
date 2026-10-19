import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { recordMovements } from "@/modules/inventory";
import { getTillOnHand } from "@/modules/inventory/till-stock";
import {
  drainPostings,
  getInventoryLinkStatus,
  listInventoryPostings,
  retryInventoryPosting,
  mapInventoryBranches,
  saveInventoryLink,
  setInventorySource,
} from "@/modules/integrations/inventory-sys";
import { reserveSale } from "@/modules/integrations/inventory-sys/postings";
import { openShift } from "@/modules/registers";
import { createSale, refundSale, voidSale } from "@/modules/sales";
import { POST as runScheduler } from "@/app/api/internal/inventory/run/route";
import { availableOf, fakeFetch, fakeIms, type FakeIms, type FakeProduct } from "../support/fake-ims";
import { createMember, createTenant, expectAppError, testDb } from "./helpers";

/**
 * Phase 13 slice 2: a linked shop's sales reserve in the inventory system before the POS
 * transaction and fulfil after it; refunds and voids go back as IMS returns (or cancelled holds),
 * queued and never blocked; the till shows the IMS's available stock. IMS mocked with fake-ims.
 */

process.env.INTEGRATION_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const CRON_SECRET = randomBytes(24).toString("hex");
process.env.CRON_SECRET ??= CRON_SECRET;

const BASE = "http://127.0.0.1:4998";
const KEY = `ims_${randomUUID()}`;
const WAREHOUSE = randomUUID();
const OTHER_WAREHOUSE = randomUUID();

let db: Db;
let ims: FakeIms;

const simple = (sku: string, price = "10"): FakeProduct => ({
  id: randomUUID(),
  name: `Item ${sku}`,
  type: "simple",
  status: "active",
  isSerialized: false,
  baseUom: "each",
  variants: [
    { id: randomUUID(), sku, barcode: `${sku}-BC`, name: null, status: "active", sellPrice: price, costPrice: "4" },
  ],
});

type Shop = Awaited<ReturnType<typeof linkedShop>>;

/** A shop linked to the fake IMS, its branch A mapped to WAREHOUSE, a shift open, `stock` units of each item. */
async function linkedShop(label: string, count = 3, stock = 10) {
  const tenant = await createTenant(db, label);
  const owner = await createMember(db, tenant.org.id, "OWNER");
  const cashier = await createMember(db, tenant.org.id, "CASHIER");
  const tag = randomUUID().slice(0, 6).toUpperCase();
  ims.products = Array.from({ length: count }, (_, i) => simple(`PS-${tag}-${i}`));
  for (const product of ims.products) ims.stock.set(`${product.variants[0].id}|${WAREHOUSE}`, stock);
  expect(await saveInventoryLink(owner, { baseUrl: BASE, apiKey: KEY })).toEqual({ ok: true });
  expect((await setInventorySource(owner, { source: "EXTERNAL" })).syncError).toBeNull();
  await mapInventoryBranches(owner, { map: [{ branchId: tenant.branchA.id, warehouseId: WAREHOUSE }] });
  await openShift(cashier, { branchId: tenant.branchA.id, registerId: tenant.register.id, openingFloatMinor: 0 });
  const items = await Promise.all(
    ims.products.map(async (product) => {
      const row = await db.product.findFirstOrThrow({
        where: { orgId: tenant.org.id, externalVariantId: product.variants[0].id },
      });
      return { productId: row.id, variantId: product.variants[0].id };
    }),
  );
  return { ...tenant, owner, cashier, items };
}

const saleKey = () => `sale-${randomUUID()}`;

function sale(shop: Shop, lines: [number, number][], paidMinor?: number) {
  const total = lines.reduce((sum, [, qty]) => sum + qty * 1000, 0);
  return {
    branchId: shop.branchA.id,
    registerId: shop.register.id,
    lines: lines.map(([index, qty]) => ({ ref: { productId: shop.items[index].productId, variantId: null }, qty })),
    payments: [{ method: "CASH" as const, amountMinor: paidMinor ?? total }],
  };
}

const reserveCalls = () => ims.calls.filter((call) => call === "POST /api/reservations").length;
const available = (shop: Shop, index: number) => availableOf(ims, shop.items[index].variantId, WAREHOUSE);
const onHandIms = (shop: Shop, index: number) => ims.stock.get(`${shop.items[index].variantId}|${WAREHOUSE}`);
const postingsOf = (orgId: string) =>
  db.externalStockPosting.findMany({ where: { orgId }, orderBy: { lineNo: "asc" } });

beforeAll(() => {
  db = testDb();
});

beforeEach(() => {
  ims = fakeIms(KEY);
  ims.warehouses = [
    { id: WAREHOUSE, code: "W1", name: "Main warehouse", status: "active" },
    { id: OTHER_WAREHOUSE, code: "W2", name: "Second warehouse", status: "active" },
  ];
  vi.stubGlobal("fetch", fakeFetch(ims));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("discounts on a linked till (discounts-spec DC16)", () => {
  it("sells at the discounted price and fulfils the full quantity", async () => {
    const shop = await linkedShop("Post Discount");
    const body = { ...sale(shop, [[0, 2]], 1800), discount: { kind: "PERCENT" as const, percentBp: 1000 } };
    const { sale: made } = await createSale(shop.cashier, body, saleKey());
    expect(made).toMatchObject({ totalMinor: 1800, discountMinor: 200 });
    expect(onHandIms(shop, 0)).toBe(8);
    const rows = await postingsOf(shop.org.id);
    expect(rows.map((r) => [r.kind, r.status, r.qty])).toEqual([["FULFIL", "DONE", 2]]);
  });

  it("refuses a cashier over the limit before holding anything in the inventory system", async () => {
    const shop = await linkedShop("Post Discount Limit");
    const body = { ...sale(shop, [[0, 1]], 500), discount: { kind: "PERCENT" as const, percentBp: 5000 } };
    await expectAppError(createSale(shop.cashier, body, saleKey()), 403, "DISCOUNT_LIMIT");
    expect(reserveCalls()).toBe(0);
    expect(available(shop, 0)).toBe(10);
  });
});

describe("a sale on a linked till (spec I12, I13)", () => {
  it("reserves every line, commits without POS stock, fulfils once, and replays without new IMS calls", async () => {
    const shop = await linkedShop("Post Sale");
    const key = saleKey();
    const body = sale(shop, [
      [0, 2],
      [1, 1],
      [2, 3],
    ]);
    const { sale: made, created } = await createSale(shop.cashier, body, key);
    expect(created).toBe(true);
    expect(reserveCalls()).toBe(3);
    expect([onHandIms(shop, 0), onHandIms(shop, 1), onHandIms(shop, 2)]).toEqual([8, 9, 7]);
    expect([...ims.reservations.values()].every((r) => r.status === "fulfilled")).toBe(true);

    const rows = await postingsOf(shop.org.id);
    expect(rows.map((r) => [r.kind, r.status, r.lineNo, r.qty])).toEqual([
      ["FULFIL", "DONE", 1, 2],
      ["FULFIL", "DONE", 2, 1],
      ["FULFIL", "DONE", 3, 3],
    ]);
    expect(rows.every((r) => r.idempotencyKey.startsWith(`pos:${key}:0:f:`))).toBe(true);
    expect(await db.inventoryMovement.count({ where: { orgId: shop.org.id } })).toBe(0);
    expect(await db.stockBalance.count({ where: { orgId: shop.org.id } })).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { orgId: shop.org.id, action: "sale.created" } });
    expect((audit.metadata as { inventoryReservationIds: string[] }).inventoryReservationIds).toHaveLength(3);

    // The till sends it again (double click, lost answer): the same sale, nothing new in the IMS.
    const again = await createSale(shop.cashier, body, key);
    expect(again).toMatchObject({ created: false, sale: { id: made.id } });
    expect(reserveCalls()).toBe(3);
    expect(ims.reservations.size).toBe(3);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("reuses the same reservations when the POS crashed between reserve and commit", async () => {
    const shop = await linkedShop("Post Crash");
    const key = saleKey();
    const body = sale(shop, [
      [0, 2],
      [1, 1],
    ]);
    // The first try held the stock, then the POS died before its transaction.
    await reserveSale(shop.org.id, shop.branchA.id, key, [
      { ref: { productId: shop.items[0].productId, variantId: null }, qty: 2 },
      { ref: { productId: shop.items[1].productId, variantId: null }, qty: 1 },
    ]);
    expect(available(shop, 0)).toBe(8);

    await createSale(shop.cashier, body, key);
    expect(ims.reservations.size).toBe(2); // replayed, not held twice
    expect([onHandIms(shop, 0), onHandIms(shop, 1)]).toEqual([8, 9]);
    expect([available(shop, 0), available(shop, 1)]).toEqual([8, 9]);
  });

  it("refuses the whole sale when a line is short, holds nothing, and sells on retry once stock arrives", async () => {
    const shop = await linkedShop("Post Short", 3, 2);
    const key = saleKey();
    const body = sale(shop, [
      [0, 1],
      [1, 5],
      [2, 1],
    ]);
    const err = await expectAppError(createSale(shop.cashier, body, key), 409, "INSUFFICIENT_STOCK");
    expect((err.details as { lines: unknown[] }).lines).toEqual([
      { productId: shop.items[1].productId, variantId: null, branchId: shop.branchA.id, onHand: 2, requested: 5 },
    ]);
    expect(await db.sale.count({ where: { orgId: shop.org.id } })).toBe(0);
    expect([available(shop, 0), available(shop, 1), available(shop, 2)]).toEqual([2, 2, 2]);
    expect([...ims.reservations.values()].map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(await db.externalStockPosting.findMany({ where: { orgId: shop.org.id } })).toEqual([
      expect.objectContaining({ kind: "CANCEL", sourceType: "SaleAttempt", lineNo: 0, status: "DONE" }),
    ]);

    // Same cart, same till key: a new attempt reserves afresh rather than replaying cancelled holds.
    ims.stock.set(`${shop.items[1].variantId}|${WAREHOUSE}`, 5);
    const { created } = await createSale(shop.cashier, body, key);
    expect(created).toBe(true);
    expect([onHandIms(shop, 0), onHandIms(shop, 1), onHandIms(shop, 2)]).toEqual([1, 0, 1]);
    const fulfils = await db.externalStockPosting.findMany({ where: { orgId: shop.org.id, kind: "FULFIL" } });
    expect(fulfils.map((r) => r.status)).toEqual(["DONE", "DONE", "DONE"]);
    expect(fulfils.every((r) => r.idempotencyKey.startsWith(`pos:${key}:1:`))).toBe(true);
  });

  it("blocks the sale with INVENTORY_UNAVAILABLE when the IMS is down, and sells once it is back", async () => {
    const shop = await linkedShop("Post Down", 2);
    const key = saleKey();
    const body = sale(shop, [
      [0, 1],
      [1, 1],
    ]);
    ims.down = "network";
    const err = await expectAppError(createSale(shop.cashier, body, key), 503, "INVENTORY_UNAVAILABLE");
    expect(err.code).toBe("INVENTORY_UNAVAILABLE");
    ims.down = "503";
    await expectAppError(createSale(shop.cashier, body, key), 503, "INVENTORY_UNAVAILABLE");
    // One line refused by an outage: the other line's hold is cancelled.
    ims.down = false;
    ims.intercept = (method, path, sent) =>
      path === "/api/reservations" && (sent as { variantId: string }).variantId === shop.items[1].variantId
        ? { status: 409, body: { code: "conflict", message: "Unexpected error", details: null } }
        : undefined;
    await expectAppError(createSale(shop.cashier, body, key), 503, "INVENTORY_UNAVAILABLE");
    expect(available(shop, 0)).toBe(10);
    expect(await db.sale.count({ where: { orgId: shop.org.id } })).toBe(0);

    ims.intercept = undefined;
    expect((await createSale(shop.cashier, body, key)).created).toBe(true);
    expect([onHandIms(shop, 0), onHandIms(shop, 1)]).toEqual([9, 9]);
  });

  it("answers INVENTORY_LINK_BROKEN for a refused key and INVENTORY_BRANCH_UNMAPPED with no IMS call", async () => {
    const shop = await linkedShop("Post Broken", 1);
    const body = sale(shop, [[0, 1]]);
    ims.apiKey = "rotated-key";
    await expectAppError(createSale(shop.cashier, body, saleKey()), 409, "INVENTORY_LINK_BROKEN");
    ims.apiKey = KEY;

    await mapInventoryBranches(shop.owner, { map: [{ branchId: shop.branchA.id, warehouseId: null }] });
    const before = ims.calls.length;
    await expectAppError(createSale(shop.cashier, body, saleKey()), 409, "INVENTORY_BRANCH_UNMAPPED");
    expect(ims.calls.length).toBe(before);
  });

  it("cancels the holds when the POS transaction fails after reserving", async () => {
    const shop = await linkedShop("Post Rollback", 2);
    await expectAppError(
      createSale(
        shop.cashier,
        sale(
          shop,
          [
            [0, 1],
            [1, 1],
          ],
          1,
        ),
        saleKey(),
      ),
      422,
      "PAYMENT_MISMATCH",
    );
    expect(ims.reservations.size).toBe(2);
    expect([...ims.reservations.values()].every((r) => r.status === "cancelled")).toBe(true);
    expect(await db.sale.count({ where: { orgId: shop.org.id } })).toBe(0);
  });

  it("keeps a fulfil that failed PENDING and sends it on the next drain", async () => {
    const shop = await linkedShop("Post Pending", 1);
    ims.intercept = (method, path) => (path.endsWith("/fulfil") ? "network" : undefined);
    const { sale: made } = await createSale(shop.cashier, sale(shop, [[0, 2]]), saleKey());
    const [row] = await postingsOf(shop.org.id);
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastErrorCode: "INVENTORY_UNAVAILABLE" });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(onHandIms(shop, 0)).toBe(10);
    expect(available(shop, 0)).toBe(8); // still held by the reservation
    expect((await getInventoryLinkStatus(shop.owner)).postings).toEqual({ pending: 1, failed: 0, stale: 0 });

    ims.intercept = undefined;
    await drainPostings({ orgId: shop.org.id, sourceIds: [made.id] });
    expect((await postingsOf(shop.org.id))[0].status).toBe("DONE");
    expect(onHandIms(shop, 0)).toBe(8);
  });

  it("never writes POS stock for a linked shop", async () => {
    const shop = await linkedShop("Post Guard", 1);
    await expectAppError(
      db.$transaction((tx) =>
        recordMovements(tx, shop.owner, {
          branchId: shop.branchA.id,
          reason: "SALE",
          refType: "Sale",
          refId: randomUUID(),
          policy: "allow",
          lines: [{ ref: { productId: shop.items[0].productId, variantId: null }, qty: 1 }],
        }),
      ),
      409,
      "MANAGED_BY_INVENTORY",
    );
  });
});

describe("refunds and voids (spec I14, I15)", () => {
  const refund = (ctx: TenantContext, saleId: string, saleItemId: string, qty: number) =>
    refundSale(ctx, saleId, `refund-${randomUUID()}`, {
      lines: [{ saleItemId, qty }],
      method: "CASH",
      reason: "Changed mind",
    });

  it("queues a refund as an IMS sales return, and sends it after an outage", async () => {
    const shop = await linkedShop("Post Refund", 2);
    const { sale: made } = await createSale(
      shop.cashier,
      sale(shop, [
        [0, 2],
        [1, 1],
      ]),
      saleKey(),
    );
    const items = await db.saleItem.findMany({ where: { saleId: made.id }, orderBy: { skuSnapshot: "asc" } });
    const first = items.find((item) => item.productId === shop.items[0].productId) as (typeof items)[number];
    const reservationOf = async (saleItemId: string) =>
      (await db.externalStockPosting.findFirstOrThrow({ where: { saleItemId } })).reservationId;

    const { refund: done } = await refund(shop.owner, made.id, first.id, 1);
    expect(ims.returns).toEqual([
      {
        id: expect.any(String),
        reasonCode: "pos_refund",
        note: `POS refund of sale ${made.number}`,
        lines: [{ reservationId: await reservationOf(first.id), qty: 1 }],
      },
    ]);
    const row = await db.externalStockPosting.findFirstOrThrow({ where: { sourceId: done.id } });
    expect(row).toMatchObject({ kind: "RETURN", status: "DONE", externalReturnId: ims.returns[0].id });
    expect(await db.inventoryMovement.count({ where: { orgId: shop.org.id } })).toBe(0);

    // The IMS is down: the refund is still paid, and its return goes out later.
    ims.down = "network";
    const { refund: queued, created } = await refund(shop.owner, made.id, first.id, 1);
    expect(created).toBe(true);
    expect(await db.externalStockPosting.findFirstOrThrow({ where: { sourceId: queued.id } })).toMatchObject({
      status: "PENDING",
      attempts: 1,
    });
    ims.down = false;
    await drainPostings({ orgId: shop.org.id, sourceIds: [queued.id] });
    expect(ims.returns).toHaveLength(2);
    expect(await db.externalStockPosting.findFirstOrThrow({ where: { sourceId: queued.id } })).toMatchObject({
      status: "DONE",
    });
  });

  it("sends a refund's return only after the sale's fulfil went out", async () => {
    const shop = await linkedShop("Post Order", 1);
    ims.intercept = (method, path) => (path.endsWith("/fulfil") ? "network" : undefined);
    const { sale: made } = await createSale(shop.cashier, sale(shop, [[0, 2]]), saleKey());
    const [item] = await db.saleItem.findMany({ where: { saleId: made.id } });
    const { refund: queued } = await refund(shop.owner, made.id, item.id, 1);
    expect(ims.returns).toHaveLength(0);
    expect(await db.externalStockPosting.findFirstOrThrow({ where: { sourceId: queued.id } })).toMatchObject({
      status: "PENDING",
      attempts: 0,
    });

    ims.intercept = undefined;
    await drainPostings({ orgId: shop.org.id, sourceIds: [made.id, queued.id] });
    expect(onHandIms(shop, 0)).toBe(8);
    expect(ims.returns.map((r) => r.lines[0].qty)).toEqual([1]);
  });

  it("returns a fulfilled sale on void, and cancels the holds of a sale not yet fulfilled", async () => {
    const shop = await linkedShop("Post Void", 2);
    const { sale: fulfilled } = await createSale(shop.cashier, sale(shop, [[0, 2]]), saleKey());
    await voidSale(shop.owner, fulfilled.id, { reason: "Wrong items" });
    expect(ims.returns).toEqual([
      expect.objectContaining({ reasonCode: "pos_void", note: `POS void of sale ${fulfilled.number}` }),
    ]);
    expect(ims.returns[0].lines).toEqual([{ reservationId: expect.any(String), qty: 2 }]);

    ims.intercept = (method, path) => (path.endsWith("/fulfil") ? "network" : undefined);
    const { sale: held } = await createSale(shop.cashier, sale(shop, [[1, 3]]), saleKey());
    ims.intercept = undefined;
    expect(available(shop, 1)).toBe(7);
    await voidSale(shop.owner, held.id, { reason: "Customer left" });
    expect(available(shop, 1)).toBe(10);
    expect(onHandIms(shop, 1)).toBe(10);
    expect(ims.returns).toHaveLength(1);
    const rows = await db.externalStockPosting.findMany({ where: { sourceId: held.id }, orderBy: { kind: "asc" } });
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ["CANCEL", "DONE"],
      ["RETURN", "DONE"],
    ]);
  });
});

describe("stock at the till (spec I16, as changed)", () => {
  it("shows the IMS's available quantity, and nothing when it cannot be read", async () => {
    const shop = await linkedShop("Post Till", 2, 4);
    const refs = shop.items.map((item) => ({ productId: item.productId, variantId: null }));
    await createSale(shop.cashier, sale(shop, [[0, 1]]), saleKey());
    expect(await getTillOnHand(shop.cashier, { branchId: shop.branchA.id, refs })).toEqual([3, 4]);
    ims.down = "503";
    expect(await getTillOnHand(shop.cashier, { branchId: shop.branchA.id, refs })).toEqual([null, null]);
  });
});

describe("branch map and unlinking (spec I5, I21)", () => {
  it("maps branches to active warehouses, owner only, never two on one", async () => {
    const shop = await linkedShop("Post Map", 1);
    const admin = await createMember(db, shop.org.id, "ADMIN");
    const branchB = shop.branchB.id;
    await expectAppError(
      mapInventoryBranches(admin, { map: [{ branchId: branchB, warehouseId: OTHER_WAREHOUSE }] }),
      403,
    );
    await expectAppError(
      mapInventoryBranches(shop.owner, { map: [{ branchId: branchB, warehouseId: randomUUID() }] }),
      422,
      "WAREHOUSE_UNKNOWN",
    );
    await expectAppError(
      mapInventoryBranches(shop.owner, { map: [{ branchId: branchB, warehouseId: WAREHOUSE }] }),
      409,
      "WAREHOUSE_TAKEN",
    );
    // A swap in one save is fine.
    const branches = await mapInventoryBranches(shop.owner, {
      map: [
        { branchId: shop.branchA.id, warehouseId: OTHER_WAREHOUSE },
        { branchId: branchB, warehouseId: WAREHOUSE },
      ],
    });
    expect(branches.map((b) => b.warehouseId).sort()).toEqual([OTHER_WAREHOUSE, WAREHOUSE].sort());
    expect((await getInventoryLinkStatus(admin)).branches).toEqual(branches);
    // The set-up map and the swap; the refused saves wrote nothing.
    expect(
      await db.auditEvent.count({ where: { orgId: shop.org.id, action: "integration.inventory.branch_mapped" } }),
    ).toBe(2);
  });

  it("refuses to unlink while postings are pending", async () => {
    const tenant = await createTenant(db, "Post Unlink");
    const owner = await createMember(db, tenant.org.id, "OWNER");
    await saveInventoryLink(owner, { baseUrl: BASE, apiKey: KEY });
    await setInventorySource(owner, { source: "EXTERNAL" });
    await db.externalStockPosting.create({
      data: { orgId: tenant.org.id, kind: "RETURN", sourceType: "Refund", sourceId: randomUUID(), idempotencyKey: "k" },
    });
    await expectAppError(setInventorySource(owner, { source: "BUILT_IN" }), 409, "PENDING_POSTINGS");
    await db.externalStockPosting.updateMany({ where: { orgId: tenant.org.id }, data: { status: "DONE" } });
    expect((await setInventorySource(owner, { source: "BUILT_IN" })).source).toBe("BUILT_IN");
  });
});

describe("the scheduler route (spec I19)", () => {
  it("refuses without the secret and drains due postings with it", async () => {
    const shop = await linkedShop("Post Cron", 1);
    ims.intercept = (method, path) => (path.endsWith("/fulfil") ? "network" : undefined);
    await createSale(shop.cashier, sale(shop, [[0, 1]]), saleKey());
    ims.intercept = undefined;
    await db.externalStockPosting.updateMany({ where: { orgId: shop.org.id }, data: { nextAttemptAt: new Date(0) } });

    const call = (secret?: string) =>
      runScheduler(
        new Request("http://localhost/api/internal/inventory/run", {
          method: "POST",
          headers: secret ? { "x-cron-secret": secret } : {},
        }),
        undefined,
      );
    expect((await call()).status).toBe(401);
    expect((await call("x".repeat(48))).status).toBe(401);
    const ok = await call(process.env.CRON_SECRET);
    expect(ok.status).toBe(200);
    expect((await postingsOf(shop.org.id))[0].status).toBe("DONE");
    expect(onHandIms(shop, 0)).toBe(9);
  });
});

describe("slice 4: the scheduled sync, the postings list and Retry (spec I19, I22)", () => {
  const runCron = async () => {
    const res = await runScheduler(
      new Request("http://localhost/api/internal/inventory/run", {
        method: "POST",
        headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { sent: number; synced: number; failed: number; stale: number };
  };
  /** Only `orgId`'s link may be due for a sync: shops of other tests (and earlier runs) are left alone. */
  const onlyDue = async (orgId: string, startedAt: Date | null) => {
    await db.inventoryLink.updateMany({ where: { orgId: { not: orgId } }, data: { lastSyncStartedAt: new Date() } });
    await db.inventoryLink.update({ where: { orgId }, data: { lastSyncStartedAt: startedAt } });
  };
  const listCalls = () => ims.calls.filter((call) => call.startsWith("/api/products?")).length;
  const auditsOf = (orgId: string, action: string) =>
    db.auditEvent.findMany({ where: { orgId, action }, orderBy: { createdAt: "asc" } });

  it("syncs a linked shop's catalog when its last sync is older than 15 minutes, with no actor", async () => {
    const shop = await linkedShop("Cron Sync", 1);
    ims.products[0].variants[0].sellPrice = "12.5";

    await onlyDue(shop.org.id, new Date(Date.now() - 5 * 60_000));
    const before = listCalls();
    expect((await runCron()).synced).toBe(0);
    expect(listCalls()).toBe(before);

    await onlyDue(shop.org.id, new Date(Date.now() - 16 * 60_000));
    expect(await runCron()).toMatchObject({ synced: 1, failed: 0 });
    const product = await db.product.findUniqueOrThrow({ where: { id: shop.items[0].productId } });
    expect(product.priceMinor).toBe(1250);
    const [completed] = (await auditsOf(shop.org.id, "integration.inventory.sync.completed")).slice(-1);
    expect(completed.actorUserId).toBeNull();
    expect((await runCron()).synced).toBe(0); // just synced
  });

  it("leaves a shop whose sync is running alone, and records an outage as a failed sync", async () => {
    const shop = await linkedShop("Cron Claim", 1);
    await onlyDue(shop.org.id, null);
    await db.inventoryLink.update({
      where: { orgId: shop.org.id },
      data: { syncLockedUntil: new Date(Date.now() + 60_000) },
    });
    expect(await runCron()).toMatchObject({ synced: 0, failed: 0 });

    await db.inventoryLink.update({ where: { orgId: shop.org.id }, data: { syncLockedUntil: null } });
    ims.down = "503";
    expect(await runCron()).toMatchObject({ synced: 0, failed: 1 });
    const link = await db.inventoryLink.findUniqueOrThrow({ where: { orgId: shop.org.id } });
    expect(link).toMatchObject({ lastSyncOk: false, syncLockedUntil: null });
    expect(await auditsOf(shop.org.id, "integration.inventory.sync.failed")).toHaveLength(1);
  });

  it("flags postings pending for over 10 minutes", async () => {
    const shop = await linkedShop("Cron Stale", 1);
    ims.intercept = (method, path) => (path.endsWith("/fulfil") ? "network" : undefined);
    await createSale(shop.cashier, sale(shop, [[0, 1]]), saleKey());
    expect((await getInventoryLinkStatus(shop.owner)).postings.stale).toBe(0);
    await db.externalStockPosting.updateMany({
      where: { orgId: shop.org.id },
      data: { createdAt: new Date(Date.now() - 11 * 60_000) },
    });
    expect((await getInventoryLinkStatus(shop.owner)).postings).toEqual({ pending: 1, failed: 0, stale: 1 });
    expect((await listInventoryPostings(shop.owner)).items[0].stale).toBe(true);
    await onlyDue(shop.org.id, new Date());
    expect((await runCron()).stale).toBeGreaterThanOrEqual(1);
  });

  it("audits .posting.failed after the first retry fails and .posting.resolved once it is sent", async () => {
    const shop = await linkedShop("Audit Retry", 1);
    ims.intercept = (method, path) => (path.endsWith("/fulfil") ? "network" : undefined);
    const { sale: made } = await createSale(shop.cashier, sale(shop, [[0, 1]]), saleKey());
    expect(await auditsOf(shop.org.id, "integration.inventory.posting.failed")).toHaveLength(0);

    await drainPostings({ orgId: shop.org.id, sourceIds: [made.id] });
    await drainPostings({ orgId: shop.org.id, sourceIds: [made.id] });
    const [row] = await postingsOf(shop.org.id);
    expect(row).toMatchObject({ status: "PENDING", attempts: 3 });
    const failed = await auditsOf(shop.org.id, "integration.inventory.posting.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actorUserId: null, entityType: "ExternalStockPosting", entityId: row.id });
    expect(failed[0].metadata).toMatchObject({ kind: "FULFIL", attempts: 2, code: "INVENTORY_UNAVAILABLE" });

    ims.intercept = undefined;
    await drainPostings({ orgId: shop.org.id, sourceIds: [made.id] });
    expect((await postingsOf(shop.org.id))[0].status).toBe("DONE");
    expect(await auditsOf(shop.org.id, "integration.inventory.posting.resolved")).toHaveLength(1);
  });

  it("lists a refused posting and lets the owner or an admin retry it, tenant-scoped", async () => {
    const shop = await linkedShop("Retry List", 1);
    const admin = await createMember(db, shop.org.id, "ADMIN");
    ims.intercept = (method, path) =>
      path.endsWith("/fulfil")
        ? { status: 422, body: { code: "validation_failed", message: "no", details: null } }
        : undefined;
    const { sale: made } = await createSale(shop.cashier, sale(shop, [[0, 2]]), saleKey());
    const [row] = await postingsOf(shop.org.id);
    expect(row).toMatchObject({ status: "FAILED", attempts: 1, lastErrorCode: "validation_failed" });
    expect(await auditsOf(shop.org.id, "integration.inventory.posting.failed")).toHaveLength(1);

    const listed = await listInventoryPostings(admin);
    expect(listed).toMatchObject({ page: 1, hasMore: false });
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: row.id,
        kind: "FULFIL",
        status: "FAILED",
        document: "SALE",
        saleNumber: made.number,
        attempts: 1,
        lastErrorCode: "validation_failed",
      }),
    ]);
    await expectAppError(listInventoryPostings(shop.cashier), 403);
    await expectAppError(retryInventoryPosting(shop.cashier, row.id), 403);
    const other = await linkedShop("Retry Other", 1);
    expect((await listInventoryPostings(other.owner)).items).toHaveLength(0);
    await expectAppError(retryInventoryPosting(other.owner, row.id), 404);

    // Refused again: stays FAILED.
    expect(await retryInventoryPosting(admin, row.id)).toEqual({ status: "FAILED" });

    ims.intercept = undefined;
    expect(await retryInventoryPosting(admin, row.id)).toEqual({ status: "DONE" });
    expect(onHandIms(shop, 0)).toBe(8);
    const retried = await auditsOf(shop.org.id, "integration.inventory.posting.retried");
    expect(retried.map((event) => event.actorUserId)).toEqual([admin.userId, admin.userId]);
    expect(await auditsOf(shop.org.id, "integration.inventory.posting.resolved")).toHaveLength(1);
    expect((await listInventoryPostings(shop.owner)).items).toHaveLength(0);
    await expectAppError(retryInventoryPosting(shop.owner, row.id), 404);
    await expectAppError(retryInventoryPosting(shop.owner, "not-a-uuid"), 404);
  });

  it("pages the list 20 at a time, oldest first", async () => {
    const shop = await linkedShop("Retry Pages", 1);
    const start = Date.now() - 60_000;
    await db.externalStockPosting.createMany({
      data: Array.from({ length: 21 }, (_, i) => ({
        orgId: shop.org.id,
        kind: "CANCEL" as const,
        sourceType: "SaleAttempt",
        sourceId: `attempt-${i}`,
        idempotencyKey: `pos:test-${i}:cancel`,
        externalOrderRefId: randomUUID(),
        nextAttemptAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(start + i * 1000),
      })),
    });
    const first = await listInventoryPostings(shop.owner, 1);
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).toMatchObject({ document: "REFUSED_SALE", saleNumber: null, kind: "CANCEL" });
    const second = await listInventoryPostings(shop.owner, 2);
    expect(second).toMatchObject({ page: 2, hasMore: false });
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(21);
    expect((await listInventoryPostings(shop.owner, -3)).page).toBe(1);
  });
});
