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

/** Opening balances (T4.4 / I-5, I-13, I-14). */
let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Inv Opening");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const ref = (productId: string, variantId: string | null = null) => ({ productId, variantId });

describe("recordOpeningBalances", () => {
  it("records each line once and reports the new balances", async () => {
    const a = await createProduct(db, orgId);
    const b = await createProduct(db, orgId);
    const result = await inventory.recordOpeningBalances(admin, {
      branchId,
      lines: [
        { ref: ref(a.id), qty: 5 },
        { ref: ref(b.id), qty: 2 },
      ],
    });
    expect(result.lines).toEqual([
      { ref: ref(a.id), qty: 5 },
      { ref: ref(b.id), qty: 2 },
    ]);
    const rows = await db.inventoryMovement.findMany({ where: { orgId, productId: a.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "OPENING_BALANCE", qtyDelta: 5 });
    await expectReconciled(db, orgId);
  });

  it("rejects a second opening balance for an item at the same branch (I-5)", async () => {
    const product = await createProduct(db, orgId);
    await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty: 3 }] });
    const err = await expectAppError(
      inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty: 4 }] }),
      409,
      "OPENING_BALANCE_EXISTS",
    );
    expect(detailsOf(err).refs).toEqual([ref(product.id)]);
  });

  it("rejects the whole grid when one line already has movements, and writes nothing", async () => {
    const fresh = await createProduct(db, orgId);
    const used = await createProduct(db, orgId);
    await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(used.id), qty: 1 }] });

    await expectAppError(
      inventory.recordOpeningBalances(admin, {
        branchId,
        lines: [
          { ref: ref(fresh.id), qty: 7 },
          { ref: ref(used.id), qty: 1 },
        ],
      }),
      409,
      "OPENING_BALANCE_EXISTS",
    );
    expect(await inventory.getOnHand(db, orgId, branchId, [ref(fresh.id)])).toEqual([0]);
  });

  it("refuses archived items (I-13)", async () => {
    const product = await createProduct(db, orgId);
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    await expectAppError(
      inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty: 1 }] }),
      422,
      "ITEM_NOT_SELLABLE",
    );
  });

  it("refuses a product with variants when no variant is named (I-14)", async () => {
    const product = await createProduct(db, orgId);
    await createVariant(db, orgId, product.id);
    const err = await expectAppError(
      inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty: 1 }] }),
      422,
      "ITEM_NOT_SELLABLE",
    );
    expect(detailsOf(err).cause).toBe("VARIANT_REQUIRED");
  });

  it("refuses the same item twice in one grid (DUPLICATE_LINE)", async () => {
    const product = await createProduct(db, orgId);
    await expectAppError(
      inventory.recordOpeningBalances(admin, {
        branchId,
        lines: [
          { ref: ref(product.id), qty: 1 },
          { ref: ref(product.id), qty: 2 },
        ],
      }),
      422,
      "DUPLICATE_LINE",
    );
  });

  it("denies a cashier with 403 and audits the attempt", async () => {
    const product = await createProduct(db, orgId);
    await expectAppError(
      inventory.recordOpeningBalances(cashier, { branchId, lines: [{ ref: ref(product.id), qty: 1 }] }),
      403,
    );
    const denial = await db.auditEvent.findFirst({
      where: { orgId, action: "inventory.permission.denied", actorUserId: cashier.userId },
    });
    expect(denial).not.toBeNull();
  });
});
