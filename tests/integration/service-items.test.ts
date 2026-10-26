import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import * as inventory from "@/modules/inventory";
import { createPurchaseOrder, createSupplier } from "@/modules/purchasing";
import { openShift } from "@/modules/registers";
import { createSale, refundSale, voidSale } from "@/modules/sales";
import {
  createMember,
  createProduct,
  createTenant,
  expectAppError,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/**
 * Service items (salon-spec S2): a haircut holds no stock. Selling, refunding or voiding it moves none; every stock
 * write refuses it; stock lists leave it out. Haircut 150.00 (45 minutes), shampoo 10.00 (stocked).
 */

let db: Db;
let orgId: string;
let branchId: string;
let otherBranchId: string;
let registerId: string;
let owner: TenantContext;
let cashier: TenantContext;
let haircut: string;
let shampoo: string;

const KEY = () => `svc-${crypto.randomUUID()}`;
const ref = (productId: string) => ({ productId, variantId: null });
const onHand = async (productId: string) =>
  (await db.stockBalance.findFirst({ where: { orgId, branchId, productId, variantId: null } }))?.qty ?? null;
const sellBoth = () =>
  createSale(
    cashier,
    {
      branchId,
      registerId,
      lines: [
        { ref: ref(haircut), qty: 1 },
        { ref: ref(shampoo), qty: 1 },
      ],
      payments: [{ method: "CASH", amountMinor: 16_000 }],
    },
    KEY(),
  );

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Salon");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  otherBranchId = tenant.branchB.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  const created = await catalog.createProductAggregate(owner, {
    sku: `CUT-${uniqueCode()}`,
    name: "Haircut",
    priceMinor: 15_000,
    isService: true,
    durationMin: 45,
  });
  haircut = created.id;
  shampoo = (await createProduct(db, orgId, "SVC-SHAMPOO")).id;
  await inventory.recordOpeningBalances(owner, { branchId, lines: [{ ref: ref(shampoo), qty: 10 }] });
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("service items", () => {
  it("are created with a duration and sold, refunded and voided without moving stock", async () => {
    expect(await catalog.getProduct(owner, haircut)).toMatchObject({ isService: true, durationMin: 45 });
    const { sale } = await sellBoth();
    expect(sale.totalMinor).toBe(16_000);
    expect(await onHand(shampoo)).toBe(9);
    expect(await onHand(haircut)).toBeNull();
    const movements = await db.inventoryMovement.findMany({ where: { orgId, refId: sale.id } });
    expect(movements.map((movement) => movement.productId)).toEqual([shampoo]);

    const lines = await db.saleItem.findMany({ where: { orgId, saleId: sale.id } });
    await refundSale(owner, sale.id, KEY(), {
      lines: lines.map((line) => ({ saleItemId: line.id, qty: 1 })),
      method: "CASH",
      reason: "Unhappy",
    });
    expect(await onHand(shampoo)).toBe(10);

    const second = (await sellBoth()).sale;
    await voidSale(owner, second.id, { reason: "Rang twice" });
    expect(await onHand(shampoo)).toBe(10);
    expect(await onHand(haircut)).toBeNull();
  });

  it("are refused by every stock write and left out of stock lists", async () => {
    await expectAppError(
      inventory.recordOpeningBalances(owner, { branchId, lines: [{ ref: ref(haircut), qty: 1 }] }),
      422,
      "ITEM_NOT_STOCKED",
    );
    await expectAppError(
      inventory.adjustStock(owner, {
        branchId,
        ref: ref(haircut),
        adjustmentReason: "DAMAGED",
        qtyDelta: -1,
        expectedOnHand: 0,
      }),
      422,
      "ITEM_NOT_STOCKED",
    );
    await expectAppError(
      inventory.transferStock(owner, {
        transferId: crypto.randomUUID(),
        fromBranchId: branchId,
        toBranchId: otherBranchId,
        lines: [{ ref: ref(haircut), qty: 1 }],
      }),
      422,
      "ITEM_NOT_STOCKED",
    );
    const supplier = await createSupplier(owner, { name: `Supplies ${uniqueCode()}` });
    await expectAppError(
      createPurchaseOrder(owner, {
        branchId,
        supplierId: supplier.id,
        lines: [{ ref: { productId: haircut }, qty: 1, unitCostMinor: 100 }],
      }),
      422,
      "ITEM_NOT_STOCKED",
    );
    const stock = await inventory.listStock(owner, { branchId, limit: 100 });
    expect(stock.rows.some((row) => row.productId === haircut)).toBe(false);
  });

  it("cannot be sold by weight or have variants", async () => {
    await expect(
      catalog.createProductAggregate(owner, {
        sku: `KG-${uniqueCode()}`,
        name: "Weighed service",
        priceMinor: 100,
        unitType: "KG",
        isService: true,
      }),
    ).rejects.toThrow(/SERVICE_NOT_SUPPORTED/);
    await expectAppError(catalog.createVariant(owner, haircut, { sku: `V-${uniqueCode()}`, name: "Long" }), 422);
  });
});
