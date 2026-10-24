import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { updateReceiptSettings } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { getTopItemsToday } from "@/modules/reports";
import { createSale, refundSale } from "@/modules/sales";
import { createMember, createProduct, createTenant, testDb } from "./helpers";

/** Dashboard "Top items today" (business-profiles-spec BP10): best sellers by net quantity, today, in scope. */

let db: Db;
let orgId: string;
let owner: TenantContext;
let cashier: TenantContext;

const KEY = () => `top-${Math.random().toString(36).slice(2)}-${Date.now()}`;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "TopItems");
  orgId = tenant.org.id;
  owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  await updateReceiptSettings(owner, { blockNegativeStock: false });
  await openShift(cashier, { branchId: tenant.branchA.id, registerId: tenant.register.id, openingFloatMinor: 0 });
  const [a, b] = [await createProduct(db, orgId, "TOP-A"), await createProduct(db, orgId, "TOP-B")];
  const sell = async (productId: string, priceMinor: number, qty: number) =>
    (
      await createSale(
        cashier,
        {
          branchId: tenant.branchA.id,
          registerId: tenant.register.id,
          lines: [{ ref: { productId, variantId: null }, qty }],
          payments: [{ method: "CASH", amountMinor: priceMinor * qty }],
        },
        KEY(),
      )
    ).sale;
  await sell(a.id, a.priceMinor, 3);
  await sell(b.id, b.priceMinor, 1);
  const refunded = await sell(b.id, b.priceMinor, 2);
  const line = await db.saleItem.findFirstOrThrow({ where: { orgId, saleId: refunded.id } });
  await refundSale(owner, refunded.id, KEY(), {
    lines: [{ saleItemId: line.id, qty: 1 }],
    method: "CASH",
    reason: "Changed mind",
  });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("top items today", () => {
  it("lists best sellers by net quantity", async () => {
    const top = await getTopItemsToday(owner);
    expect(top?.map((row) => [row.qty, row.sku])).toEqual([
      [3, "TOP-A"],
      [2, "TOP-B"],
    ]);
  });

  it("is null for a role without reports.view", async () => {
    expect(await getTopItemsToday(cashier)).toBeNull();
  });
});
