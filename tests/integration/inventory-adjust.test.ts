import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import {
  createMember,
  createProduct,
  createTenant,
  detailsOf,
  expectAppError,
  expectReconciled,
  testDb,
} from "./helpers";

/** Adjustments (T4.4 / I-2, I-6, I-11, I-12, I-13). */
let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Inv Adjust");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const ref = (productId: string) => ({ productId, variantId: null });

/** Creates a product with `qty` on hand through the real opening-balance service. */
async function stocked(qty: number) {
  const product = await createProduct(db, orgId);
  await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty }] });
  return product;
}

describe("adjustStock", () => {
  it("applies a decrease and records the sub-reason and actor", async () => {
    const product = await stocked(5);
    const result = await inventory.adjustStock(admin, {
      branchId,
      ref: ref(product.id),
      adjustmentReason: "DAMAGED",
      qtyDelta: -2,
      expectedOnHand: 5,
    });
    expect(result).toEqual({ qty: 3 });
    const row = await db.inventoryMovement.findFirst({ where: { orgId, productId: product.id, reason: "ADJUSTMENT" } });
    expect(row).toMatchObject({ adjustmentReason: "DAMAGED", qtyDelta: -2, actorUserId: admin.userId });
  });

  it("blocks a decrease below zero even when the org allows negative stock (I-2)", async () => {
    await db.organization.update({ where: { id: orgId }, data: { blockNegativeStock: false } });
    try {
      const product = await stocked(1);
      await expectAppError(
        inventory.adjustStock(admin, {
          branchId,
          ref: ref(product.id),
          adjustmentReason: "LOST_OR_STOLEN",
          qtyDelta: -2,
          expectedOnHand: 1,
        }),
        409,
        "INSUFFICIENT_STOCK",
      );
    } finally {
      await db.organization.update({ where: { id: orgId }, data: { blockNegativeStock: true } });
    }
  });

  it("rejects a sub-reason with the wrong direction (I-6)", async () => {
    const product = await stocked(2);
    const err = await expectAppError(
      inventory.adjustStock(admin, {
        branchId,
        ref: ref(product.id),
        adjustmentReason: "FOUND",
        qtyDelta: -1,
        expectedOnHand: 2,
      }),
      422,
      "ADJUSTMENT_DIRECTION",
    );
    expect(detailsOf(err).reason).toBe("ADJUSTMENT_DIRECTION");
  });

  it("requires a note for OTHER", async () => {
    const product = await stocked(2);
    await expect(
      inventory.adjustStock(admin, {
        branchId,
        ref: ref(product.id),
        adjustmentReason: "OTHER",
        qtyDelta: 1,
        expectedOnHand: 2,
      }),
    ).rejects.toThrow();
  });

  it("turns a counted quantity into a delta under the lock (I-11)", async () => {
    const product = await stocked(4);
    const result = await inventory.adjustStock(admin, {
      branchId,
      ref: ref(product.id),
      adjustmentReason: "COUNT_CORRECTION",
      countedQty: 7,
      expectedOnHand: 4,
    });
    expect(result).toEqual({ qty: 7 });
    const row = await db.inventoryMovement.findFirst({ where: { orgId, productId: product.id, reason: "ADJUSTMENT" } });
    expect(row?.qtyDelta).toBe(3);
  });

  it("answers NO_CHANGE when the counted quantity equals on-hand (I-11)", async () => {
    const product = await stocked(4);
    await expectAppError(
      inventory.adjustStock(admin, {
        branchId,
        ref: ref(product.id),
        adjustmentReason: "COUNT_CORRECTION",
        countedQty: 4,
        expectedOnHand: 4,
      }),
      422,
      "NO_CHANGE",
    );
  });

  it("answers STALE_STOCK with the current on-hand when expectedOnHand is out of date (I-12)", async () => {
    const product = await stocked(5);
    const err = await expectAppError(
      inventory.adjustStock(admin, {
        branchId,
        ref: ref(product.id),
        adjustmentReason: "FOUND",
        qtyDelta: 1,
        expectedOnHand: 3,
      }),
      409,
      "STALE_STOCK",
    );
    expect(detailsOf(err).onHand).toBe(5);
  });

  it("lets an archived item's stock be written off (I-13, archived change)", async () => {
    const product = await stocked(2);
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    const result = await inventory.adjustStock(admin, {
      branchId,
      ref: ref(product.id),
      adjustmentReason: "DAMAGED",
      qtyDelta: -1,
      expectedOnHand: 2,
    });
    expect(result).toEqual({ qty: 1 });
  });

  it("lets a counted quantity bring an archived item down to zero", async () => {
    const product = await stocked(3);
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    const result = await inventory.adjustStock(admin, {
      branchId,
      ref: ref(product.id),
      adjustmentReason: "COUNT_CORRECTION",
      countedQty: 0,
      expectedOnHand: 3,
    });
    expect(result).toEqual({ qty: 0 });
  });

  it("refuses to add stock to an archived item (I-13)", async () => {
    const product = await stocked(2);
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    const err = await expectAppError(
      inventory.adjustStock(admin, {
        branchId,
        ref: ref(product.id),
        adjustmentReason: "FOUND",
        qtyDelta: 1,
        expectedOnHand: 2,
      }),
      422,
      "ITEM_NOT_SELLABLE",
    );
    expect(detailsOf(err).cause).toBe("PRODUCT_ARCHIVED");
  });

  it("answers 404 for an unknown product or another org's product", async () => {
    const foreign = await createProduct(db, (await createTenant(db, "Inv Adjust Foreign")).org.id);
    for (const productId of [randomUUID(), foreign.id]) {
      await expectAppError(
        inventory.adjustStock(admin, {
          branchId,
          ref: ref(productId),
          adjustmentReason: "FOUND",
          qtyDelta: 1,
          expectedOnHand: 0,
        }),
        404,
      );
    }
  });
});
