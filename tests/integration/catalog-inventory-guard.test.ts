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

/** Catalog → inventory guard (T4.5, I-10): a product with unvariant stock cannot gain variants. */
let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Catalog Guard");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const variantSku = () => `GV-${shortUpper()}`;

describe("switching a product to variants (I-10)", () => {
  it("refuses while the product has unvariant stock, and writes no variant", async () => {
    const product = await createProduct(db, orgId);
    await inventory.recordOpeningBalances(admin, {
      branchId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty: 3 }],
    });

    await expectAppError(
      catalog.createVariant(admin, product.id, { sku: variantSku(), name: "Red" }),
      409,
      "PRODUCT_HAS_STOCK",
    );
    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.hasVariants).toBe(false);
    expect(await db.productVariant.count({ where: { productId: product.id } })).toBe(0);
  });

  it("refuses when the unvariant movements net to zero, because history still counts", async () => {
    const product = await createProduct(db, orgId);
    await inventory.recordOpeningBalances(admin, {
      branchId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty: 1 }],
    });
    await inventory.adjustStock(admin, {
      branchId,
      ref: { productId: product.id, variantId: null },
      adjustmentReason: "DAMAGED",
      qtyDelta: -1,
      expectedOnHand: 1,
    });
    await expectAppError(
      catalog.createVariant(admin, product.id, { sku: variantSku(), name: "Blue" }),
      409,
      "PRODUCT_HAS_STOCK",
    );
  });

  it("allows the switch when the product has never been stocked", async () => {
    const product = await createProduct(db, orgId);
    const created = await catalog.createVariant(admin, product.id, { sku: variantSku(), name: "Green" });
    expect(created).toBeDefined();
    const after = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.hasVariants).toBe(true);
  });
});
