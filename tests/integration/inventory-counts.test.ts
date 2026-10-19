import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import {
  createCategory,
  createMember,
  createProduct,
  createTenant,
  createVariant,
  expectAppError,
  expectReconciled,
  testDb,
} from "./helpers";

/** Stock counts (docs/planning/stock-counts/stock-counts-spec.md). */
let db: Db;
let orgId: string;
let branchA: string;
let branchB: string;
let admin: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Inv Counts");
  orgId = tenant.org.id;
  branchA = tenant.branchA.id;
  branchB = tenant.branchB.id;
  admin = await createMember(db, orgId, "ADMIN");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

const ref = (productId: string, variantId: string | null = null) => ({ productId, variantId });

async function stocked(qty: number, branchId = branchA, categoryId?: string) {
  const product = await createProduct(db, orgId);
  if (categoryId) await db.product.update({ where: { id: product.id }, data: { categoryId } });
  await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(product.id), qty }] });
  return product;
}

async function onHand(productId: string, branchId = branchA) {
  const [qty] = await inventory.getOnHand(db, orgId, branchId, [ref(productId)]);
  return qty;
}

/** Each test gets its own branch: only one count may be open per branch (C3). */
async function freshBranch() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const branch = await db.branch.create({ data: { orgId, name: `Count ${suffix}`, code: `C-${suffix}` } });
  return branch.id;
}

async function counting(branchId: string, scope: "FULL" | "CATEGORY" | "ITEMS" = "FULL", categoryId?: string) {
  const { id } = await inventory.createCount(admin, { branchId, scope, categoryId });
  return id;
}

describe("a full count", () => {
  it("snapshots expected, sums scans, replaces on a typed quantity and posts the differences", async () => {
    const branchId = await freshBranch();
    const short = await stocked(10, branchId);
    const extra = await stocked(3, branchId);
    const exact = await stocked(5, branchId);
    const id = await counting(branchId);
    await inventory.startCount(admin, id);

    await inventory.recordCountEntry(admin, id, { ref: ref(short.id), add: 1 });
    await inventory.recordCountEntry(admin, id, { ref: ref(short.id), add: 1 });
    expect(await inventory.recordCountEntry(admin, id, { ref: ref(short.id), set: 8 })).toEqual({ countedQty: 8 });
    await inventory.recordCountEntry(admin, id, { ref: ref(extra.id), set: 4 });
    await inventory.recordCountEntry(admin, id, { ref: ref(exact.id), set: 5 });

    const detail = await inventory.getCount(admin, id);
    expect(detail.status).toBe("COUNTING");
    expect(detail.lines.find((l) => l.ref.productId === short.id)).toMatchObject({
      countedQty: 8,
      expectedQty: 10,
      qtyDelta: -2,
    });

    const result = await inventory.postCount(admin, id);
    expect(result).toEqual({ lines: 2, totalDelta: -1, replayed: false });
    expect(await onHand(short.id, branchId)).toBe(8);
    expect(await onHand(extra.id, branchId)).toBe(4);
    expect(await onHand(exact.id, branchId)).toBe(5);

    const rows = await db.inventoryMovement.findMany({ where: { orgId, refType: "StockCount", refId: id } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ reason: "ADJUSTMENT", adjustmentReason: "COUNT_CORRECTION", branchId });
    }
    const audit = await db.auditEvent.findFirst({ where: { orgId, action: "inventory.count.posted", entityId: id } });
    expect(audit?.metadata).toMatchObject({ totalDelta: -1, counted: 3 });

    const posted = await inventory.getCount(admin, id);
    expect(posted.status).toBe("POSTED");
    expect(posted.lines.find((l) => l.ref.productId === short.id)).toMatchObject({ onHand: 10, qtyDelta: -2 });
  });

  it("keeps a sale made while counting: the difference is applied to live on-hand (C6)", async () => {
    const branchId = await freshBranch();
    const product = await stocked(10, branchId);
    const id = await counting(branchId);
    await inventory.startCount(admin, id);
    // Counted 9 on the shelf while the system said 10: one unit is missing.
    await inventory.recordCountEntry(admin, id, { ref: ref(product.id), set: 9 });

    // A till sells 2 before the manager posts.
    await db.$transaction((tx) =>
      inventory.recordMovements(tx, admin, {
        branchId,
        reason: "SALE",
        refType: null,
        refId: null,
        policy: "block",
        lines: [{ ref: ref(product.id), qty: 2 }],
      }),
    );
    expect(await onHand(product.id, branchId)).toBe(8);
    const review = await inventory.getCount(admin, id);
    expect(review.lines[0]).toMatchObject({ expectedQty: 10, onHand: 8, countedQty: 9, qtyDelta: -1 });

    await inventory.postCount(admin, id);
    expect(await onHand(product.id, branchId)).toBe(7);
  });

  it("counts variants and tells how many in-scope items were not counted (C7)", async () => {
    const branchId = await freshBranch();
    const parent = await createProduct(db, orgId);
    const variant = await createVariant(db, orgId, parent.id);
    await inventory.recordOpeningBalances(admin, { branchId, lines: [{ ref: ref(parent.id, variant.id), qty: 2 }] });
    const id = await counting(branchId);
    await inventory.startCount(admin, id);
    await expectAppError(inventory.recordCountEntry(admin, id, { ref: ref(parent.id), add: 1 }), 422);
    await inventory.recordCountEntry(admin, id, { ref: ref(parent.id, variant.id), add: 1 });
    const before = await inventory.getCount(admin, id);
    expect(before.uncounted).toBeGreaterThan(0);
    await inventory.recordCountEntry(admin, id, { ref: ref(parent.id, variant.id), set: null });
    const cleared = await inventory.getCount(admin, id);
    expect(cleared.lines[0]).toMatchObject({ countedQty: null, expectedQty: null, qtyDelta: null });
    expect(cleared.uncounted).toBe(before.uncounted + 1);
    await inventory.cancelCount(admin, id);
  });

  it("replays a second post without writing again (C10)", async () => {
    const branchId = await freshBranch();
    const product = await stocked(4, branchId);
    const id = await counting(branchId);
    await inventory.startCount(admin, id);
    await inventory.recordCountEntry(admin, id, { ref: ref(product.id), set: 1 });
    const [first, second] = await Promise.all([inventory.postCount(admin, id), inventory.postCount(admin, id)]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(second.totalDelta).toBe(-3);
    expect(await onHand(product.id, branchId)).toBe(1);
    expect(await db.inventoryMovement.count({ where: { orgId, refId: id } })).toBe(1);
    await expectAppError(inventory.recordCountEntry(admin, id, { ref: ref(product.id), add: 1 }), 409, "COUNT_STATE");
    await expectAppError(inventory.cancelCount(admin, id), 409, "COUNT_STATE");
  });

  it("refuses a post that would take stock below zero and writes nothing (C9)", async () => {
    const branchId = await freshBranch();
    const product = await stocked(5, branchId);
    const id = await counting(branchId);
    await inventory.startCount(admin, id);
    await inventory.recordCountEntry(admin, id, { ref: ref(product.id), set: 0 });
    await db.organization.update({ where: { id: orgId }, data: { blockNegativeStock: false } });
    try {
      await db.$transaction((tx) =>
        inventory.recordMovements(tx, admin, {
          branchId,
          reason: "SALE",
          refType: null,
          refId: null,
          policy: "allow",
          lines: [{ ref: ref(product.id), qty: 3 }],
        }),
      );
    } finally {
      await db.organization.update({ where: { id: orgId }, data: { blockNegativeStock: true } });
    }
    // Snapshot 5, counted 0 ⇒ −5 against on-hand 2 ⇒ −3: blocked.
    await expectAppError(inventory.postCount(admin, id), 409, "INSUFFICIENT_STOCK");
    expect((await db.stockCount.findUniqueOrThrow({ where: { id } })).status).toBe("COUNTING");
    // Clear and recount: the new snapshot is 2.
    await inventory.recordCountEntry(admin, id, { ref: ref(product.id), set: null });
    await inventory.recordCountEntry(admin, id, { ref: ref(product.id), set: 0 });
    await inventory.postCount(admin, id);
    expect(await onHand(product.id, branchId)).toBe(0);
  });
});

describe("scope and lifecycle", () => {
  it("allows only one open count per branch (C3)", async () => {
    const branchId = await freshBranch();
    const id = await counting(branchId);
    await expectAppError(inventory.createCount(admin, { branchId, scope: "FULL" }), 409, "COUNT_OPEN");
    await inventory.cancelCount(admin, id);
    const next = await counting(branchId);
    await inventory.cancelCount(admin, next);
  });

  it("refuses counting before start, and items outside a category (C2)", async () => {
    const branchId = await freshBranch();
    const parentCat = await createCategory(db, orgId);
    const childCat = await createCategory(db, orgId, undefined, parentCat.id);
    const inChild = await stocked(1, branchId, childCat.id);
    const outside = await stocked(1, branchId);
    const id = await counting(branchId, "CATEGORY", parentCat.id);
    await expectAppError(inventory.recordCountEntry(admin, id, { ref: ref(inChild.id), add: 1 }), 409, "COUNT_STATE");
    await inventory.startCount(admin, id);
    await inventory.recordCountEntry(admin, id, { ref: ref(inChild.id), add: 1 });
    await expectAppError(
      inventory.recordCountEntry(admin, id, { ref: ref(outside.id), add: 1 }),
      422,
      "ITEM_NOT_IN_COUNT",
    );
    expect((await inventory.getCount(admin, id)).uncounted).toBe(0);
    await inventory.cancelCount(admin, id);
  });

  it("uses the chosen list for an items count", async () => {
    const branchId = await freshBranch();
    const chosen = await stocked(2, branchId);
    const other = await stocked(2, branchId);
    const id = await counting(branchId, "ITEMS");
    await expectAppError(inventory.startCount(admin, id), 422, "COUNT_EMPTY");
    await inventory.addCountItems(admin, id, { refs: [ref(chosen.id), ref(other.id)] });
    await inventory.removeCountItem(admin, id, { ref: ref(other.id) });
    await inventory.startCount(admin, id);
    await expectAppError(inventory.addCountItems(admin, id, { refs: [ref(other.id)] }), 409, "COUNT_STATE");
    await expectAppError(
      inventory.recordCountEntry(admin, id, { ref: ref(other.id), add: 1 }),
      422,
      "ITEM_NOT_IN_COUNT",
    );
    expect((await inventory.getCount(admin, id)).uncounted).toBe(1);
    await inventory.recordCountEntry(admin, id, { ref: ref(chosen.id), set: 2 });
    expect(await inventory.postCount(admin, id)).toEqual({ lines: 0, totalDelta: 0, replayed: false });
  });

  it("validates the category rule", async () => {
    const branchId = await freshBranch();
    // Schema errors surface as ZodError (422 at the route).
    await expect(inventory.createCount(admin, { branchId, scope: "CATEGORY" })).rejects.toThrow(/categoryId/);
    await expectAppError(
      inventory.createCount(admin, { branchId, scope: "CATEGORY", categoryId: crypto.randomUUID() }),
      404,
    );
  });
});

describe("access", () => {
  it("lets a reporting user read but not write, and audit-logs the denial (C11)", async () => {
    const branchId = await freshBranch();
    const id = await counting(branchId);
    const reporter = await createMember(db, orgId, "REPORTING");
    expect((await inventory.listCounts(reporter, { branchId })).map((c) => c.id)).toContain(id);
    await expectAppError(inventory.startCount(reporter, id), 403);
    const cashier = await createMember(db, orgId, "CASHIER");
    await expectAppError(inventory.getCount(cashier, id), 403);
    const denied = await db.auditEvent.findFirst({
      where: { orgId, actorUserId: reporter.userId, action: "inventory.permission.denied" },
    });
    expect(denied).not.toBeNull();
    await inventory.cancelCount(admin, id);
  });

  it("hides another org's count and an out-of-scope branch (C14)", async () => {
    const other = await createTenant(db, "Inv Counts Other");
    const outsider = await createMember(db, other.org.id, "ADMIN");
    const branchId = await freshBranch();
    const id = await counting(branchId);
    await expectAppError(inventory.getCount(outsider, id), 404);
    await expectAppError(inventory.postCount(outsider, id), 404);
    await expectAppError(inventory.createCount(outsider, { branchId, scope: "FULL" }), 404);

    const user = await db.user.create({ data: { name: "Scoped", email: `scoped-${id}@example.test` } });
    const membership = await db.membership.create({
      data: { orgId, userId: user.id, role: "MANAGER", allBranches: false },
    });
    await db.membershipBranch.create({ data: { orgId, membershipId: membership.id, branchId: branchB } });
    const scoped: TenantContext = {
      userId: user.id,
      orgId,
      membershipId: membership.id,
      role: "MANAGER",
      branchId: null,
    };
    await expectAppError(inventory.getCount(scoped, id), 404);
    await expectAppError(inventory.listCounts(scoped, { branchId }), 404);
    await inventory.cancelCount(admin, id);
  });

  it("refuses every count write for a shop linked to the inventory system (C12)", async () => {
    const shop = await createTenant(db, "Inv Counts Linked");
    const owner = await createMember(db, shop.org.id, "OWNER");
    const { id } = await inventory.createCount(owner, { branchId: shop.branchA.id, scope: "FULL" });
    await inventory.startCount(owner, id);
    await db.organization.update({ where: { id: shop.org.id }, data: { inventorySource: "EXTERNAL" } });
    await expectAppError(inventory.postCount(owner, id), 409, "MANAGED_BY_INVENTORY");
    await expectAppError(
      inventory.createCount(owner, { branchId: shop.branchB.id, scope: "FULL" }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    expect((await inventory.getCount(owner, id)).status).toBe("COUNTING");
  });
});

describe("database rules", () => {
  it("rejects a counted line without its expected snapshot", async () => {
    const branchId = await freshBranch();
    const product = await stocked(1, branchId);
    const id = await counting(branchId);
    await expect(
      db.stockCountLine.create({ data: { orgId, countId: id, productId: product.id, countedQty: 1 } }),
    ).rejects.toThrow();
    await inventory.cancelCount(admin, id);
  });
});
