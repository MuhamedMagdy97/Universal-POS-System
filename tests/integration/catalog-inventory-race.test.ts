import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import * as inventory from "@/modules/inventory";
import {
  createMember,
  createProduct,
  createTenant,
  expectAppError,
  expectReconciled,
  shortUpper,
  testDb,
} from "./helpers";

/**
 * Variant-switch race (checkout R1, carried from Phase 7). A sale that is still uncommitted
 * when a product is switched to variants must not leave an orphaned variant-null balance: the
 * switch waits for the sale, then sees its stock and refuses.
 */
let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Variant Race");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const variantSku = () => `RV-${shortUpper()}`;

describe("variant switch against an uncommitted sale (R1)", () => {
  it("waits for the sale to commit, then refuses with PRODUCT_HAS_STOCK", async () => {
    const product = await createProduct(db, orgId);
    const ref = { productId: product.id, variantId: null };

    let saleReady!: () => void;
    const started = new Promise<void>((resolve) => (saleReady = resolve));
    let commitSale!: () => void;
    const gate = new Promise<void>((resolve) => (commitSale = resolve));

    // "allow" lets the sale take the item below zero, so the sale leaves a visible variant-null row.
    const sale = db.$transaction(async (tx) => {
      await inventory.recordMovements(tx, admin, {
        branchId,
        reason: "SALE",
        refType: "Sale",
        refId: null,
        policy: "allow",
        lines: [{ ref, qty: 1 }],
      });
      saleReady();
      await gate;
    });
    await started;

    const switching = catalog.createVariant(admin, product.id, { sku: variantSku(), name: "Race" });
    const settled = await Promise.race([
      switching.then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 300)),
    ]);
    expect(settled).toBe("waiting");

    commitSale();
    await sale;
    await expectAppError(switching, 409, "PRODUCT_HAS_STOCK");

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.hasVariants).toBe(false);
    expect(await db.productVariant.count({ where: { productId: product.id } })).toBe(0);
  });
});
