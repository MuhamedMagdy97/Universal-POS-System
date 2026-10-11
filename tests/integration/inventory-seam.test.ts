import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import {
  createMember,
  createProduct,
  createTenant,
  createVariant,
  detailsOf,
  expectAppError,
  expectReconciled,
  testDb,
} from "./helpers";

/** Inventory seam (T4.3): recordMovements, getOnHand, reconcile and ledger invariants. */
let db: Db;
let orgId: string;
let branchId: string;
let branchB: string;
let manager: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Inv Seam");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  branchB = tenant.branchB.id;
  manager = await createMember(db, orgId, "MANAGER");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

/** Receives `qty` units without any sale rules, so tests start from known stock. */
async function receive(productId: string, qty: number, at = branchId) {
  return db.$transaction((tx) =>
    inventory.recordMovements(tx, manager, {
      branchId: at,
      reason: "PURCHASE_RECEIPT",
      refType: null,
      refId: null,
      lines: [{ ref: { productId, variantId: null }, qty }],
      policy: "block",
    }),
  );
}

function sell(productId: string, qty: number, policy: "block" | "allow", variantId: string | null = null) {
  return db.$transaction((tx) =>
    inventory.recordMovements(tx, manager, {
      branchId,
      reason: "SALE",
      refType: "Sale",
      refId: "00000000-0000-4000-8000-000000000001",
      lines: [{ ref: { productId, variantId }, qty }],
      policy,
    }),
  );
}

describe("recordMovements writes one ledger row and one balance per line (I-1)", () => {
  it("moves the balance and keeps the ledger in step", async () => {
    const product = await createProduct(db, orgId);
    const result = await receive(product.id, 5);
    expect(result).toEqual([{ ref: { productId: product.id, variantId: null }, qty: 5 }]);

    await sell(product.id, 2, "block");
    const onHand = await inventory.getOnHand(db, orgId, branchId, [{ productId: product.id, variantId: null }]);
    expect(onHand).toEqual([3]);

    const rows = await db.inventoryMovement.findMany({ where: { orgId, productId: product.id } });
    expect(rows.map((row) => row.qtyDelta).sort((a, b) => a - b)).toEqual([-2, 5]);
    expect(rows.every((row) => row.actorUserId === manager.userId)).toBe(true);
    await expectReconciled(db, orgId);
  });
});

describe("oversell protection under concurrency (I-3)", () => {
  it("lets exactly one of two concurrent sales take the last unit", async () => {
    const product = await createProduct(db, orgId);
    await receive(product.id, 1);

    const results = await Promise.allSettled([sell(product.id, 1, "block"), sell(product.id, 1, "block")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = rejected[0].reason as { status: number; code: string; details: unknown };
    expect(err.status).toBe(409);
    expect(err.code).toBe("CONFLICT");
    expect(detailsOf(err as never).reason).toBe("INSUFFICIENT_STOCK");

    const onHand = await inventory.getOnHand(db, orgId, branchId, [{ productId: product.id, variantId: null }]);
    expect(onHand).toEqual([0]);
    await expectReconciled(db, orgId);
  });
});

describe("policy allow (I-4)", () => {
  it("lets a sale go negative and reconciles", async () => {
    const product = await createProduct(db, orgId);
    await sell(product.id, 1, "allow");
    const onHand = await inventory.getOnHand(db, orgId, branchId, [{ productId: product.id, variantId: null }]);
    expect(onHand).toEqual([-1]);
    await expectReconciled(db, orgId);
  });

  it("rejects an insufficient block sale and reports the line", async () => {
    const product = await createProduct(db, orgId);
    const err = await expectAppError(sell(product.id, 1, "block"), 409, "INSUFFICIENT_STOCK");
    expect(detailsOf(err).lines).toEqual([expect.objectContaining({ onHand: 0, requested: 1, branchId })]);
  });
});

describe("archived items and refunds (I-13)", () => {
  it("rejects a sale of an archived item but lets a refund return stock", async () => {
    const product = await createProduct(db, orgId);
    await receive(product.id, 1);
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });

    await expectAppError(sell(product.id, 1, "allow"), 422, "ITEM_NOT_SELLABLE");

    await db.$transaction((tx) =>
      inventory.recordMovements(tx, manager, {
        branchId,
        reason: "REFUND",
        refType: "Refund",
        refId: "00000000-0000-4000-8000-000000000002",
        lines: [{ ref: { productId: product.id, variantId: null }, qty: 1 }],
        policy: "block",
      }),
    );
    const onHand = await inventory.getOnHand(db, orgId, branchId, [{ productId: product.id, variantId: null }]);
    expect(onHand).toEqual([2]);
    await expectReconciled(db, orgId);
  });
});

describe("variant rule (I-14)", () => {
  it("requires a variant when the product has variants", async () => {
    const product = await createProduct(db, orgId);
    await createVariant(db, orgId, product.id);
    const err = await expectAppError(sell(product.id, 1, "allow", null), 422, "ITEM_NOT_SELLABLE");
    expect(detailsOf(err).cause).toBe("VARIANT_REQUIRED");
  });

  it("answers 404 for a refund of an unknown product, instead of a database error", async () => {
    await expectAppError(
      db.$transaction((tx) =>
        inventory.recordMovements(tx, manager, {
          branchId,
          reason: "REFUND",
          refType: "Refund",
          refId: null,
          lines: [{ ref: { productId: "00000000-0000-4000-8000-0000000000ff", variantId: null }, qty: 1 }],
          policy: "block",
        }),
      ),
      404,
    );
  });
});

describe("the ledger is append-only (I-16)", () => {
  it("rejects UPDATE on a movement row", async () => {
    const product = await createProduct(db, orgId);
    await receive(product.id, 1);
    await expect(
      db.$executeRaw`UPDATE "InventoryMovement" SET "qtyDelta" = 99 WHERE "productId" = ${product.id}::uuid`,
    ).rejects.toThrow(/append-only/);
  });
});

describe("getOnHand (I-19)", () => {
  it("returns quantities in input order, 0 for an item with no balance row", async () => {
    const a = await createProduct(db, orgId);
    const b = await createProduct(db, orgId);
    const missing = await createProduct(db, orgId);
    await receive(a.id, 4, branchB);
    await receive(b.id, 2, branchB);

    const refs = [
      { productId: a.id, variantId: null },
      { productId: missing.id, variantId: null },
      { productId: b.id, variantId: null },
    ];
    expect(await inventory.getOnHand(db, orgId, branchB, refs)).toEqual([4, 0, 2]);
    expect(await db.$transaction((tx) => inventory.getOnHand(tx, orgId, branchB, refs))).toEqual([4, 0, 2]);
  });
});
