import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { getTillOnHand } from "@/modules/inventory/till-stock";
import { createMember, createProduct, createTenant, expectReconciled, testDb, uniqueCode } from "./helpers";

/** On-hand at the till: read-only, for anyone who may sell, scoped to the caller's org. */
let db: Db;
let orgId: string;
let branchId: string;
let otherOrgBranchId: string;
let admin: TenantContext;
let cashier: TenantContext;
let reporting: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Till Stock");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  otherOrgBranchId = (await createTenant(db, "Till Stock Other")).branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
  reporting = await createMember(db, orgId, "REPORTING");
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("getTillOnHand", () => {
  it("gives a cashier the branch's on-hand in request order, 0 for never-moved and negative as is", async () => {
    const stocked = await createProduct(db, orgId, `TS-${uniqueCode().slice(-6)}`);
    const fresh = await createProduct(db, orgId, `TS-${uniqueCode().slice(-6)}`);
    const sold = await createProduct(db, orgId, `TS-${uniqueCode().slice(-6)}`);
    await inventory.recordOpeningBalances(admin, {
      branchId,
      lines: [{ ref: { productId: stocked.id, variantId: null }, qty: 4 }],
    });
    await db.$transaction((tx) =>
      inventory.recordMovements(tx, admin, {
        branchId,
        reason: "SALE",
        refType: "Sale",
        refId: null,
        lines: [{ ref: { productId: sold.id, variantId: null }, qty: 2 }],
        policy: "allow",
      }),
    );
    const refs = [stocked, fresh, sold].map((p) => ({ productId: p.id, variantId: null }));
    expect(await getTillOnHand(cashier, { branchId, refs })).toEqual([4, 0, -2]);
  });

  it("refuses a role that cannot sell, and a branch of another org", async () => {
    await expect(getTillOnHand(reporting, { branchId, refs: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getTillOnHand(cashier, { branchId: otherOrgBranchId, refs: [] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
