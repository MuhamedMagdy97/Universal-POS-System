import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import {
  createOptionGroup,
  getSellableItems,
  listOptionGroups,
  searchSellable,
  setProductOptionGroups,
  updateOptionGroup,
} from "@/modules/catalog";
import { createMember, createProduct, createTenant, expectAppError, testDb } from "./helpers";

/** Option groups in the catalog (restaurant-cafe-spec R7): managed with products.update, audited, on sellable items. */

let db: Db;
let orgId: string;
let owner: TenantContext;
let cashier: TenantContext;
let coffee: string;

const size = {
  name: "Size",
  nameAr: "الحجم",
  minSelect: 1,
  maxSelect: 1,
  choices: [
    { name: "Regular", priceDeltaMinor: 0 },
    { name: "Large", nameAr: "كبير", priceDeltaMinor: 500 },
  ],
};

beforeAll(async () => {
  db = testDb();
  orgId = (await createTenant(db, "Options")).org.id;
  owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  coffee = (await createProduct(db, orgId, "CAPPUCCINO")).id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe("option groups", () => {
  it("creates a group, links it to a product, and the till and checkout see it", async () => {
    const group = await createOptionGroup(owner, size);
    expect(group).toMatchObject({ name: "Size", minSelect: 1, maxSelect: 1, isActive: true, productCount: 0 });
    expect(group.choices.map((choice) => [choice.name, choice.priceDeltaMinor])).toEqual([
      ["Regular", 0],
      ["Large", 500],
    ]);
    await setProductOptionGroups(owner, coffee, [group.id]);

    const [item] = await getSellableItems(db, orgId, [{ productId: coffee, variantId: null }]);
    expect(item.optionGroups).toEqual([
      { id: group.id, name: "Size", nameAr: "الحجم", minSelect: 1, maxSelect: 1, choices: group.choices },
    ]);
    const [found] = await searchSellable(cashier, "CAPPUCCINO");
    expect(found.optionGroups?.[0].choices).toHaveLength(2);
    expect(await db.auditEvent.count({ where: { orgId, action: "catalog.option_group.created" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { orgId, action: "catalog.product.option_groups.set" } })).toBe(1);
  });

  it("updates choices: a kept one keeps its id, a dropped one is deactivated, a new one is added", async () => {
    const [group] = await listOptionGroups(owner);
    const [regular, large] = group.choices;
    const updated = await updateOptionGroup(owner, group.id, {
      ...size,
      choices: [
        { id: large.id, name: "Large", priceDeltaMinor: 600 },
        { name: "Small", priceDeltaMinor: 0 },
      ],
    });
    expect(updated.choices.map((choice) => [choice.name, choice.priceDeltaMinor])).toEqual([
      ["Large", 600],
      ["Small", 0],
    ]);
    expect(updated.choices[0].id).toBe(large.id);
    expect((await db.optionChoice.findUniqueOrThrow({ where: { id: regular.id } })).isActive).toBe(false);

    // An archived group leaves the item.
    await updateOptionGroup(owner, group.id, { ...size, choices: updated.choices, isActive: false });
    const [item] = await getSellableItems(db, orgId, [{ productId: coffee, variantId: null }]);
    expect(item.optionGroups).toBeUndefined();
  });

  it("refuses a cashier, a minimum above the choices, weighed products and products with variants", async () => {
    await expectAppError(createOptionGroup(cashier, size), 403);
    await expect(createOptionGroup(owner, { ...size, minSelect: 3 })).rejects.toThrow();
    await expect(createOptionGroup(owner, { ...size, minSelect: 2, maxSelect: 1 })).rejects.toThrow();
    const group = await createOptionGroup(owner, { ...size, name: "Milk" });

    const rice = (await createProduct(db, orgId)).id;
    await db.product.update({ where: { id: rice }, data: { unitType: "KG" } });
    await expectAppError(setProductOptionGroups(owner, rice, [group.id]), 422);
    const shirt = (await createProduct(db, orgId)).id;
    await db.product.update({ where: { id: shirt }, data: { hasVariants: true } });
    await expectAppError(setProductOptionGroups(owner, shirt, [group.id]), 422);
    await expectAppError(setProductOptionGroups(owner, coffee, [crypto.randomUUID()]), 404);
  });
});
