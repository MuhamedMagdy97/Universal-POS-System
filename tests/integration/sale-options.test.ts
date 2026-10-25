import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { createOptionGroup, setProductOptionGroups, type OptionGroupDetail } from "@/modules/catalog";
import * as inventory from "@/modules/inventory";
import { enrolOfflineDevice, updateOfflineSettings } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { buildOfflineSale, searchSnapshot } from "@/app/(app)/pos/_lib/offline";
import { addToCart } from "@/app/(app)/pos/_lib/till";
import { resolveOptions } from "@/modules/sales/options";
import { createSale, getReceipt, getSaleForReturns, getTillSnapshot, refundSale } from "@/modules/sales";
import { createMember, createProduct, createTenant, expectAppError, expectReconciled, testDb } from "./helpers";

/**
 * Options and notes on sale lines (restaurant-cafe-spec R7–R9). Cappuccino 30.00 with Size (exactly one: Regular
 * 0.00, Large 5.00) and Extras (up to two: Extra shot 3.00); croissant 20.00 with no options. VAT included, 14 %.
 */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let owner: TenantContext;
let cashier: TenantContext;
let coffee: string;
let croissant: string;
let size: OptionGroupDetail;
let extras: OptionGroupDetail;

const KEY = () => `opt-${crypto.randomUUID()}`;
const ref = (productId: string) => ({ productId, variantId: null });
const choice = (group: OptionGroupDetail, name: string) => group.choices.find((c) => c.name === name)?.id ?? "";
const onHand = async (productId: string) =>
  (await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId, variantId: null } })).qty;
const sell = (lines: unknown[], amountMinor: number) =>
  createSale(cashier, { branchId, registerId, lines, payments: [{ method: "CASH", amountMinor }] }, KEY());

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Cafe");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  coffee = (await createProduct(db, orgId, "OPT-COFFEE")).id;
  croissant = (await createProduct(db, orgId, "OPT-CROISSANT")).id;
  await db.product.update({ where: { id: coffee }, data: { name: "Cappuccino", priceMinor: 3_000 } });
  await db.product.update({ where: { id: croissant }, data: { name: "Croissant", priceMinor: 2_000 } });
  size = await createOptionGroup(owner, {
    name: "Size",
    minSelect: 1,
    maxSelect: 1,
    choices: [
      { name: "Regular", priceDeltaMinor: 0 },
      { name: "Large", nameAr: "كبير", priceDeltaMinor: 500 },
    ],
  });
  extras = await createOptionGroup(owner, {
    name: "Extras",
    minSelect: 0,
    maxSelect: 2,
    choices: [{ name: "Extra shot", priceDeltaMinor: 300 }],
  });
  await setProductOptionGroups(owner, coffee, [size.id, extras.id]);
  await inventory.recordOpeningBalances(owner, {
    branchId,
    lines: [
      { ref: ref(coffee), qty: 50 },
      { ref: ref(croissant), qty: 50 },
    ],
  });
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("options on a sale", () => {
  it("keeps a large cappuccino with a shot apart from a regular one, and moves stock once", async () => {
    const large = [choice(size, "Large"), choice(extras, "Extra shot")];
    const { sale } = await sell(
      [
        { ref: ref(coffee), qty: 1, options: large },
        { ref: ref(coffee), qty: 1, options: [choice(size, "Regular")] },
        // The same options in another order are the same line.
        { ref: ref(coffee), qty: 1, options: [...large].reverse() },
      ],
      10_600,
    );
    expect(sale.totalMinor).toBe(3_800 * 2 + 3_000);
    expect(sale.lines.map((line) => [line.qty, line.unitPriceMinor, line.options.map((o) => o.name)])).toEqual(
      expect.arrayContaining([
        [2, 3_800, ["Large", "Extra shot"]],
        [1, 3_000, ["Regular"]],
      ]),
    );
    expect(await onHand(coffee)).toBe(47);
    const movements = await db.inventoryMovement.findMany({ where: { orgId, refId: sale.id } });
    expect(movements.map((movement) => movement.qtyDelta)).toEqual([-3]);

    const receipt = await getReceipt(cashier, sale.id, { kind: "SALE", copy: false });
    expect(
      receipt.lines
        .find((line) => line.lineTotalMinor === 7_600)
        ?.options?.map((option) => [option.name, option.nameAr]),
    ).toEqual([
      ["Large", "كبير"],
      ["Extra shot", null],
    ]);

    // Refund the regular one: only that line.
    const view = await getSaleForReturns(owner, sale.number);
    const regular = view.lines.find((line) => line.options[0]?.name === "Regular");
    const { refund } = await refundSale(owner, sale.id, KEY(), {
      lines: [{ saleItemId: regular?.saleItemId ?? "", qty: 1 }],
      method: "CASH",
      reason: "Spilled",
    });
    expect(refund.totalMinor).toBe(3_000);
    expect(await onHand(coffee)).toBe(48);
  });

  it("keeps a note on its own line, merges the same note, and refuses options that do not fit", async () => {
    const { sale } = await sell(
      [
        { ref: ref(croissant), qty: 1, note: "  warm it  " },
        { ref: ref(croissant), qty: 1 },
        { ref: ref(croissant), qty: 1, note: "warm it" },
      ],
      6_000,
    );
    expect(sale.lines.map((line) => [line.qty, line.note])).toEqual(
      expect.arrayContaining([
        [2, "warm it"],
        [1, null],
      ]),
    );

    await expectAppError(sell([{ ref: ref(coffee), qty: 1 }], 3_000), 422, "OPTIONS_INVALID");
    await expectAppError(
      sell([{ ref: ref(croissant), qty: 1, options: [choice(size, "Large")] }], 2_500),
      422,
      "OPTIONS_INVALID",
    );
    await expect(sell([{ ref: ref(croissant), qty: 1, note: "x".repeat(141) }], 2_000)).rejects.toThrow();
  });
});

describe("options on an offline sale", () => {
  it("are on the snapshot, priced on the device and the same on replay", async () => {
    await updateOfflineSettings(owner, { allowOfflineSales: true });
    const enrolled = await enrolOfflineDevice(owner, registerId);
    const snap = await getTillSnapshot(cashier, branchId, registerId, null);
    const [found] = searchSnapshot(snap.items, "OPT-COFFEE");
    expect(found.optionGroups?.map((group) => group.name)).toEqual(["Size", "Extras"]);
    const options = [choice(size, "Large")];
    const { unitPriceMinor, snapshot } = resolveOptions(found, options);
    const cart = addToCart([], found, 2, undefined, { options, labels: snapshot, unitPriceMinor });
    const body = {
      branchId,
      registerId,
      lines: [{ ref: ref(coffee), qty: 2, options, note: "to go" }],
      payments: [{ method: "CASH" as const, amountMinor: 7_000 }],
    };
    const built = buildOfflineSale({
      body,
      cart: cart.map((line) => ({ ...line, note: "to go" })),
      saleDiscount: null,
      plan: { payments: body.payments, changeMinor: 0 },
      snapshot: snap,
      device: enrolled,
      seq: enrolled.lastOfflineSaleNo + 1,
      soldAt: new Date(),
    });
    expect(built.receipt.totalMinor).toBe(7_000);
    expect(built.receipt.lines[0]).toMatchObject({ note: "to go", options: [{ name: "Large" }] });
    const { sale } = await createSale(cashier, built.body, KEY());
    expect(sale.lines).toMatchObject([{ qty: 2, unitPriceMinor: 3_500, note: "to go" }]);
    const row = await db.sale.findUniqueOrThrow({ where: { id: sale.id }, select: { offlineFlags: true } });
    expect(row.offlineFlags).toEqual([]);
  });
});
