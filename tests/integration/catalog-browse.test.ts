import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { browseSellable } from "@/modules/catalog";
import { getTillSnapshot } from "@/modules/sales";
import { createCategory, createMember, createProduct, createTenant, createVariant, testDb } from "./helpers";

/** Till tiles (business-profiles-spec BP8): sellable items by category, and categories in the till snapshot. */

let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let cashier: TenantContext;
let outsider: TenantContext;
let drinks: string;
let pastries: string;
let otherCategory: string;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Browse");
  const other = await createTenant(db, "Browse other");
  const orgId = tenant.org.id;
  cashier = await createMember(db, orgId, "CASHIER");
  outsider = await createMember(db, other.org.id, "CASHIER");
  drinks = (await createCategory(db, orgId, "Drinks")).id;
  pastries = (await createCategory(db, orgId, "Pastries")).id;
  otherCategory = (await createCategory(db, other.org.id, "Theirs")).id;

  const product = async (sku: string, categoryId: string | null, isActive = true) => {
    const p = await createProduct(db, orgId, sku);
    return db.product.update({ where: { id: p.id }, data: { categoryId, isActive, name: sku } });
  };
  await product("B-LATTE", drinks);
  await product("B-TEA", drinks);
  await product("B-OLD", drinks, false);
  await product("B-CROISSANT", pastries);
  await product("B-LOOSE", null);
  const sized = await product("B-JUICE", drinks);
  await createVariant(db, orgId, sized.id, "B-JUICE-S");
  await createVariant(db, orgId, sized.id, "B-JUICE-L");
});

afterAll(async () => {
  await db.$disconnect();
});

describe("browseSellable", () => {
  it("lists a category's active items by name, variants expanded, with their category", async () => {
    const items = await browseSellable(cashier, { categoryId: drinks });
    expect(items.map((i) => i.sku)).toEqual(["B-JUICE-L", "B-JUICE-S", "B-LATTE", "B-TEA"]);
    expect(new Set(items.map((i) => i.categoryId))).toEqual(new Set([drinks]));
  });

  it("lists every active item without a category filter, capped by limit", async () => {
    const all = await browseSellable(cashier, {});
    expect(all.map((i) => i.sku)).toContain("B-LOOSE");
    expect(all.map((i) => i.sku)).not.toContain("B-OLD");
    expect(await browseSellable(cashier, { limit: 2 })).toHaveLength(2);
  });

  it("shows nothing from another shop's category and refuses a bad limit", async () => {
    expect(await browseSellable(cashier, { categoryId: otherCategory })).toEqual([]);
    expect(await browseSellable(outsider, { categoryId: drinks })).toEqual([]);
    await expect(browseSellable(cashier, { limit: 61 })).rejects.toThrow();
  });
});

describe("till snapshot", () => {
  it("carries the categories and each item's category", async () => {
    const snap = await getTillSnapshot(cashier, tenant.branchA.id, tenant.register.id, null);
    expect(snap.categories?.map((c) => c.name)).toEqual(expect.arrayContaining(["Drinks", "Pastries"]));
    expect(snap.items.find((i) => i.sku === "B-CROISSANT")?.categoryId).toBe(pastries);
  });
});
