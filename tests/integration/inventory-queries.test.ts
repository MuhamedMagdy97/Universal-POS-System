import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import {
  createMember,
  createProduct,
  createTenant,
  createVariant,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/** Stock list and item history (T4.4 / I-17, I-18). */
let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Inv Queries");
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

describe("listStock", () => {
  it("lists stockable items with zero for items that have never moved, and never returns cost", async () => {
    const product = await createProduct(db, orgId, `LST-${uniqueCode().slice(-6)}`);
    await db.product.update({ where: { id: product.id }, data: { costMinor: 500 } });
    const page = await inventory.listStock(admin, { branchId, q: product.sku, filter: "all", limit: 25 });
    expect(page.rows).toEqual([
      expect.objectContaining({ productId: product.id, variantId: null, qty: 0, archived: false }),
    ]);
    expect(JSON.stringify(page)).not.toContain("costMinor");
  });

  it("filters to negative balances and flags archived items that still hold stock (I-18, I-4)", async () => {
    const product = await createProduct(db, orgId, `NEG-${uniqueCode().slice(-6)}`);
    await db.$transaction((tx) =>
      inventory.recordMovements(tx, admin, {
        branchId,
        reason: "SALE",
        refType: "Sale",
        refId: null,
        lines: [{ ref: ref(product.id), qty: 2 }],
        policy: "allow",
      }),
    );
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    const page = await inventory.listStock(admin, { branchId, q: product.sku, filter: "negative", limit: 25 });
    expect(page.rows).toEqual([expect.objectContaining({ productId: product.id, qty: -2, archived: true })]);
  });

  it("lists items with no movements at the branch under the unopened filter (opening grid)", async () => {
    const tag = `UNO${uniqueCode().slice(-5)}`;
    const fresh = await createProduct(db, orgId, `${tag}-A`);
    const used = await createProduct(db, orgId, `${tag}-B`);
    await inventory.recordOpeningBalances(admin, {
      branchId,
      lines: [{ ref: ref(used.id), qty: 1 }],
    });
    const page = await inventory.listStock(admin, { branchId, q: tag, filter: "unopened", limit: 25 });
    expect(page.rows.map((row) => row.productId)).toEqual([fresh.id]);
  });

  it("matches a barcode exactly", async () => {
    const product = await createProduct(db, orgId, `BC-${uniqueCode().slice(-6)}`);
    const code = uniqueCode();
    await db.barcode.create({ data: { orgId, code, productId: product.id } });
    const page = await inventory.listStock(admin, { branchId, q: code, filter: "all", limit: 25 });
    expect(page.rows.map((row) => row.productId)).toEqual([product.id]);
  });

  it("pages with an opaque cursor that never repeats or skips a row", async () => {
    const tag = `PG${uniqueCode().slice(-5)}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await createProduct(db, orgId, `${tag}-${i}`)).id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await inventory.listStock(admin, { branchId, q: tag, filter: "all", limit: 2, cursor });
      seen.push(...page.rows.map((row) => row.productId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it("lists each variant of a product as its own row", async () => {
    const product = await createProduct(db, orgId, `VAR-${uniqueCode().slice(-6)}`);
    const variant = await createVariant(db, orgId, product.id);
    const page = await inventory.listStock(admin, { branchId, q: product.sku, filter: "all", limit: 25 });
    expect(page.rows).toEqual([expect.objectContaining({ productId: product.id, variantId: variant.id })]);
  });

  it("is refused to a cashier (403)", async () => {
    await expect(inventory.listStock(cashier, { branchId, filter: "all", limit: 25 })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("getItemLedger (I-17)", () => {
  it("returns the header balance and a running balance on every row, newest first", async () => {
    const product = await createProduct(db, orgId);
    await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty: 10 }] });
    await inventory.adjustStock(admin, {
      branchId,
      ref: ref(product.id),
      adjustmentReason: "DAMAGED",
      qtyDelta: -3,
      expectedOnHand: 10,
    });
    await inventory.adjustStock(admin, {
      branchId,
      ref: ref(product.id),
      adjustmentReason: "FOUND",
      qtyDelta: 2,
      expectedOnHand: 7,
    });

    const history = await inventory.getItemLedger(admin, { branchId, productId: product.id, limit: 25 });
    expect(history.qty).toBe(9);
    expect(history.rows.map((row) => [row.reason, row.balanceAfter])).toEqual([
      ["ADJUSTMENT", 9],
      ["ADJUSTMENT", 7],
      ["OPENING_BALANCE", 10],
    ]);
    expect(history.rows[0].actor).toEqual({ id: admin.userId, name: expect.any(String) });
    expect(history.rows[0].adjustmentReason).toBe("FOUND");
    expect(JSON.stringify(history)).not.toContain("costMinor");
  });
});
