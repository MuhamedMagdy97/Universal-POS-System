import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { createProduct, createTenant, createUser, testDb } from "./helpers";

/**
 * Inventory invariants enforced by the database itself (inventory-data-model.md §3).
 * Rows are written with raw SQL so a missing column or a wrong enum fails loudly as a
 * SQL error, and each rejection is matched to the constraint's name — a Prisma client
 * validation error can never make these tests pass by accident.
 */
let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let actorId: string;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Inv Constraints");
  other = await createTenant(db, "Inv Constraints Other");
  actorId = (await createUser(db)).id;
});

afterAll(async () => {
  await db.$disconnect();
});

type MovementRow = {
  orgId?: string;
  branchId?: string;
  productId: string;
  variantId?: string | null;
  qtyDelta: number;
  reason: string;
  adjustmentReason?: string | null;
  note?: string | null;
  transferGroupId?: string | null;
};

/** Inserts one ledger row for `tenant`'s branch A unless overridden. */
function insertMovement(row: MovementRow) {
  return db.$executeRaw`
    INSERT INTO "InventoryMovement"
      ("id", "orgId", "branchId", "productId", "variantId", "qtyDelta", "reason",
       "adjustmentReason", "note", "transferGroupId", "actorUserId", "createdAt")
    VALUES (
      gen_random_uuid(),
      ${row.orgId ?? tenant.org.id}::uuid,
      ${row.branchId ?? tenant.branchA.id}::uuid,
      ${row.productId}::uuid,
      ${row.variantId ?? null}::uuid,
      ${row.qtyDelta},
      ${row.reason}::"MovementReason",
      ${row.adjustmentReason ?? null}::"AdjustmentReason",
      ${row.note ?? null},
      ${row.transferGroupId ?? null}::uuid,
      ${actorId}::uuid,
      now()
    )`;
}

const newProductId = async () => (await createProduct(db, tenant.org.id)).id;

describe("adjustment sub-reasons", () => {
  it("accepts a valid decrease and a valid count correction in either direction", async () => {
    const productId = await newProductId();
    await expect(
      insertMovement({ productId, qtyDelta: -1, reason: "ADJUSTMENT", adjustmentReason: "DAMAGED" }),
    ).resolves.toBe(1);
    await expect(
      insertMovement({ productId, qtyDelta: 2, reason: "ADJUSTMENT", adjustmentReason: "COUNT_CORRECTION" }),
    ).resolves.toBe(1);
    await expect(
      insertMovement({ productId, qtyDelta: -2, reason: "ADJUSTMENT", adjustmentReason: "COUNT_CORRECTION" }),
    ).resolves.toBe(1);
  });

  it("requires a sub-reason on every ADJUSTMENT row", async () => {
    const productId = await newProductId();
    await expect(
      insertMovement({ productId, qtyDelta: 1, reason: "ADJUSTMENT", adjustmentReason: null }),
    ).rejects.toThrow(/InventoryMovement_adjustment_reason_present/);
  });

  it("forbids a sub-reason on non-adjustment rows", async () => {
    const productId = await newProductId();
    await expect(
      insertMovement({ productId, qtyDelta: 1, reason: "OPENING_BALANCE", adjustmentReason: "FOUND" }),
    ).rejects.toThrow(/InventoryMovement_adjustment_reason_present/);
  });

  it.each([
    ["DAMAGED", 1],
    ["EXPIRED", 1],
    ["LOST_OR_STOLEN", 1],
    ["FOUND", -1],
  ])("rejects %s with the wrong sign (delta %i)", async (adjustmentReason, qtyDelta) => {
    const productId = await newProductId();
    await expect(insertMovement({ productId, qtyDelta, reason: "ADJUSTMENT", adjustmentReason })).rejects.toThrow(
      /InventoryMovement_adjustment_direction/,
    );
  });

  it("requires a non-blank note for OTHER", async () => {
    const productId = await newProductId();
    await expect(
      insertMovement({ productId, qtyDelta: 1, reason: "ADJUSTMENT", adjustmentReason: "OTHER", note: null }),
    ).rejects.toThrow(/InventoryMovement_other_needs_note/);
    await expect(
      insertMovement({ productId, qtyDelta: 1, reason: "ADJUSTMENT", adjustmentReason: "OTHER", note: "   " }),
    ).rejects.toThrow(/InventoryMovement_other_needs_note/);
  });

  it("caps the note at 500 characters", async () => {
    const productId = await newProductId();
    await expect(
      insertMovement({
        productId,
        qtyDelta: 1,
        reason: "ADJUSTMENT",
        adjustmentReason: "COUNT_CORRECTION",
        note: "x".repeat(501),
      }),
    ).rejects.toThrow(/InventoryMovement_note_length/);
  });
});

describe("movement direction per reason", () => {
  it("rejects a positive SALE and a negative OPENING_BALANCE", async () => {
    const productId = await newProductId();
    await expect(insertMovement({ productId, qtyDelta: 1, reason: "SALE" })).rejects.toThrow(
      /InventoryMovement_reason_direction/,
    );
    await expect(insertMovement({ productId, qtyDelta: -1, reason: "OPENING_BALANCE" })).rejects.toThrow(
      /InventoryMovement_reason_direction/,
    );
  });

  it("rejects a transfer group on a non-transfer row", async () => {
    const productId = await newProductId();
    await expect(
      insertMovement({ productId, qtyDelta: -1, reason: "SALE", transferGroupId: randomUUID() }),
    ).rejects.toThrow(/InventoryMovement_group_only_on_transfer/);
  });
});

describe("opening balance and transfer uniqueness", () => {
  it("allows one opening balance per item and branch, including NULL variants", async () => {
    const productId = await newProductId();
    await insertMovement({ productId, qtyDelta: 5, reason: "OPENING_BALANCE" });
    await expect(insertMovement({ productId, qtyDelta: 3, reason: "OPENING_BALANCE" })).rejects.toThrow(
      /InventoryMovement_one_opening_balance/,
    );
  });

  it("allows an opening balance for the same item at a second branch", async () => {
    const productId = await newProductId();
    await insertMovement({ productId, qtyDelta: 5, reason: "OPENING_BALANCE" });
    await expect(
      insertMovement({ productId, qtyDelta: 3, reason: "OPENING_BALANCE", branchId: tenant.branchB.id }),
    ).resolves.toBe(1);
  });

  it("rejects the same item twice on one side of one transfer", async () => {
    const productId = await newProductId();
    const transferGroupId = randomUUID();
    await insertMovement({ productId, qtyDelta: -2, reason: "TRANSFER_OUT", transferGroupId });
    await expect(insertMovement({ productId, qtyDelta: -1, reason: "TRANSFER_OUT", transferGroupId })).rejects.toThrow(
      /InventoryMovement_transfer_line_once/,
    );
  });
});

describe("cross-tenant references on stock tables", () => {
  it("cannot write a stock balance for another tenant's product", async () => {
    const otherProduct = await createProduct(db, other.org.id);
    await expect(
      db.stockBalance.create({
        data: { orgId: tenant.org.id, branchId: tenant.branchA.id, productId: otherProduct.id, qty: 1 },
      }),
    ).rejects.toThrow(/StockBalance_orgId_productId_fkey/);
  });
});
