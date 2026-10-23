import { describe, expect, it } from "vitest";
import type { TillSnapshot } from "@/modules/sales";
import { SaleInput } from "@/modules/sales/schemas";
import { priceSale, settlePayments } from "@/modules/sales/totals";
import {
  buildOfflineSale,
  offlineBlock,
  offlineNumber,
  reach,
  replayOrder,
  replayStep,
  searchSnapshot,
  unreachable,
  type OfflineDevice,
  type QueueEntry,
} from "@/app/(app)/pos/_lib/offline";
import type { CartLine } from "@/app/(app)/pos/_lib/till";

/** Offline till slice 2 (offline-till-spec §3, unit): limits, numbering, replay decisions, search, offline totals. */

const NOW = new Date("2026-10-23T12:00:00Z");
const HOUR = 60 * 60_000;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const device: OfflineDevice = {
  deviceId: ID(1),
  deviceSecret: "s".repeat(43),
  registerId: ID(2),
  offlineCode: "T1",
  lastOfflineSaleNo: 44,
};

function snapshot(over: Partial<TillSnapshot> = {}): TillSnapshot {
  return {
    version: 1,
    snapshotAt: new Date(NOW.getTime() - HOUR).toISOString(),
    orgId: ID(3),
    branchId: ID(4),
    allowOfflineSales: true,
    register: { id: ID(2), name: "Till 1", offlineCode: "T1", deviceId: ID(1) },
    shift: { id: ID(5), openedAt: new Date(NOW.getTime() - 3 * HOUR).toISOString() },
    user: { id: ID(6), name: "Cashier", role: "CASHIER" },
    sessionExpiresAt: new Date(NOW.getTime() + 10 * HOUR).toISOString(),
    settings: { currency: "EGP", vatRateBp: 1400, pricesIncludeVat: true, maxCashierDiscountBp: 1000 },
    shop: {
      name: "Shop",
      branchName: "Main",
      address: null,
      phone: null,
      taxNumber: null,
      header: null,
      footer: null,
    },
    timeZone: "Africa/Cairo",
    zatcaVatNumber: null,
    items: [
      {
        productId: ID(10),
        variantId: null,
        sku: "TEA-1",
        name: "Tea",
        nameAr: "شاي",
        unitType: "PIECE",
        unitPriceMinor: 1250,
        vatCategory: "STANDARD",
        vatApplicable: true,
        barcodes: ["6221234567890"],
      },
      {
        productId: ID(11),
        variantId: null,
        sku: "COF-1",
        name: "Coffee",
        nameAr: null,
        unitType: "PIECE",
        unitPriceMinor: 3000,
        vatCategory: "STANDARD",
        vatApplicable: true,
        barcodes: [],
      },
    ],
    ...over,
  } as TillSnapshot;
}

const base = {
  device,
  userId: ID(6),
  lastContactAt: new Date(NOW.getTime() - HOUR).toISOString(),
  queued: 0,
  now: NOW,
};

describe("offlineBlock (OF5, OF7, OF16, OF17, OF19)", () => {
  it("allows a fresh, enrolled device with an open shift", () => {
    expect(offlineBlock({ ...base, snapshot: snapshot() })).toBeNull();
  });

  it.each([
    ["NOT_ENABLED", { snapshot: null }],
    ["NOT_ENABLED", { snapshot: snapshot({ allowOfflineSales: false }) }],
    ["NO_DEVICE", { snapshot: snapshot(), device: null }],
    [
      "NO_DEVICE",
      { snapshot: snapshot({ register: { id: ID(2), name: "Till 1", offlineCode: "T1", deviceId: ID(9) } }) },
    ],
    ["OTHER_USER", { snapshot: snapshot(), userId: ID(7) }],
    ["NO_SHIFT", { snapshot: snapshot({ shift: null }) }],
    ["STALE_SNAPSHOT", { snapshot: snapshot({ snapshotAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() }) }],
    ["SESSION_EXPIRED", { snapshot: snapshot({ sessionExpiresAt: NOW.toISOString() }) }],
    ["CONTACT_LIMIT", { snapshot: snapshot(), lastContactAt: new Date(NOW.getTime() - 13 * HOUR).toISOString() }],
    ["QUEUE_FULL", { snapshot: snapshot(), queued: 300 }],
  ] as const)("%s", (expected, over) => {
    expect(offlineBlock({ ...base, ...over } as Parameters<typeof offlineBlock>[0])).toBe(expected);
  });
});

describe("offline numbers and replay", () => {
  it("numbers T1-000045", () => expect(offlineNumber("T1", 45)).toBe("T1-000045"));

  it("treats only no answer or a down database as unreachable", () => {
    expect(unreachable("UNREACHABLE")).toBe(true);
    expect(unreachable({ ok: false, error: { code: "DB_UNAVAILABLE", message: "", details: null } })).toBe(true);
    expect(unreachable({ ok: false, error: { code: "VALIDATION_FAILED", message: "", details: null } })).toBe(false);
    expect(unreachable({ ok: true, data: null })).toBe(false);
  });

  it("deletes on success, waits on outages, rejects hard refusals", () => {
    const err = (code: string, reason?: string) =>
      ({ ok: false, error: { code, message: "", details: reason ? { reason } : null } }) as never;
    expect(replayStep({ ok: true, data: null })).toBe("DONE");
    expect(replayStep("UNREACHABLE")).toBe("STOP");
    for (const code of ["DB_UNAVAILABLE", "RATE_LIMITED", "UNAUTHENTICATED", "INTERNAL"]) {
      expect(replayStep(err(code))).toBe("STOP");
    }
    expect(replayStep(err("FORBIDDEN"))).toBe("STOP");
    expect(replayStep(err("FORBIDDEN", "DEVICE_REVOKED"))).toBe("REJECT");
    expect(replayStep(err("FORBIDDEN", "DEVICE_NOT_ENROLLED"))).toBe("REJECT");
    for (const code of ["VALIDATION_FAILED", "NOT_FOUND", "IDEMPOTENCY_CONFLICT", "CONFLICT"]) {
      expect(replayStep(err(code))).toBe("REJECT");
    }
  });

  it("replays oldest first", () => {
    const entry = (number: string, soldAt: string) => ({ number, soldAt }) as QueueEntry;
    const order = replayOrder([
      entry("T1-000003", "2026-10-23T10:02:00Z"),
      entry("T1-000001", "2026-10-23T10:00:00Z"),
      entry("T1-000002", "2026-10-23T10:00:00Z"),
    ]);
    expect(order.map((e) => e.number)).toEqual(["T1-000001", "T1-000002", "T1-000003"]);
  });

  it("reach turns a throw or a timeout into UNREACHABLE and passes answers through", async () => {
    expect(await reach(() => Promise.reject(new TypeError("fetch failed")))).toBe("UNREACHABLE");
    expect(await reach(() => new Promise(() => undefined), 10)).toBe("UNREACHABLE");
    expect(await reach(() => Promise.resolve({ ok: true as const, data: 1 }))).toEqual({ ok: true, data: 1 });
  });
});

describe("searchSnapshot", () => {
  const items = snapshot().items;
  it("finds an exact barcode or SKU only", () => {
    expect(searchSnapshot(items, "6221234567890").map((i) => i.sku)).toEqual(["TEA-1"]);
    expect(searchSnapshot(items, "cof-1").map((i) => i.sku)).toEqual(["COF-1"]);
  });
  it("falls back to name, SKU and Arabic name matches", () => {
    expect(searchSnapshot(items, "co").map((i) => i.sku)).toEqual(["COF-1"]);
    expect(searchSnapshot(items, "شاي").map((i) => i.sku)).toEqual(["TEA-1"]);
    expect(searchSnapshot(items, "  ")).toEqual([]);
  });
});

describe("buildOfflineSale (OF9, OF11)", () => {
  const tea = {
    ...searchSnapshot(snapshot().items, "TEA-1")[0],
    qty: 3,
    discount: { kind: "PERCENT", percentBp: 1000 },
  };
  const coffee = { ...searchSnapshot(snapshot().items, "COF-1")[0], qty: 1 };
  const cart = [tea, coffee] as CartLine[];
  const saleDiscount = { kind: "AMOUNT" as const, amountMinor: 500 };
  const priced = priceSale(
    cart.map((l) => ({ unitPriceMinor: l.unitPriceMinor, qty: l.qty, vatApplicable: true, discount: l.discount })),
    saleDiscount,
    1400,
    true,
  );
  const body = {
    branchId: ID(4),
    registerId: ID(2),
    lines: cart.map((l) => ({
      ref: { productId: l.productId, variantId: null },
      qty: l.qty,
      discount: l.discount ?? undefined,
    })),
    discount: saleDiscount,
    payments: [
      { method: "CARD_MANUAL" as const, amountMinor: 2000, reference: "1234" },
      { method: "CASH" as const, amountMinor: 10_000 },
    ],
  };
  const built = buildOfflineSale({
    body,
    cart,
    saleDiscount,
    plan: { payments: body.payments, changeMinor: 0 },
    snapshot: snapshot(),
    device,
    seq: 45,
    soldAt: NOW,
  });

  it("carries the device's totals, equal to the server's priceSale for the same cart", () => {
    const offline = built.body.offline;
    if (!offline) throw new Error("no offline block");
    expect(offline.number).toBe("T1-000045");
    expect(offline.totalMinor).toBe(priced.totalMinor);
    expect(offline.vatMinor).toBe(priced.vatMinor);
    expect(offline.subtotalMinor).toBe(priced.subtotalMinor);
    expect(offline.lines.map((l) => l.lineTotalMinor)).toEqual(priced.lines.map((l) => l.lineTotalMinor));
    expect(offline.lines.map((l) => l.discountMinor)).toEqual(priced.lines.map((l) => l.discountMinor));
    expect(offline).toMatchObject({ shiftId: ID(5), cashierId: ID(6), soldAt: NOW.toISOString(), snapshotVersion: 1 });
  });

  it("is a body the server accepts", () => {
    expect(SaleInput.safeParse(built.body).success).toBe(true);
  });

  it("prints what the server will store: split, change, number and the offline mark", () => {
    const settled = settlePayments(priced.totalMinor, body.payments);
    expect(built.receipt).toMatchObject({
      saleNumber: "T1-000045",
      offline: true,
      totalMinor: priced.totalMinor,
      changeMinor: settled.changeMinor,
      payments: settled.payments.map((p) => ({ method: p.method, amountMinor: p.amountMinor })),
      vatRatesBp: [1400],
      zatca: null,
    });
  });

  it("adds the phase-1 QR for a Saudi shop", () => {
    const sa = buildOfflineSale({
      body,
      cart,
      saleDiscount,
      plan: { payments: body.payments, changeMinor: 0 },
      snapshot: snapshot({ zatcaVatNumber: "300000000000003" }),
      device,
      seq: 46,
      soldAt: NOW,
    });
    expect(sa.receipt.zatca?.tlv).toBeTruthy();
  });
});
