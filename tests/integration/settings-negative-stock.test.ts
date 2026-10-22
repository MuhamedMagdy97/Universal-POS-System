import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { getReceiptSettings, updateReceiptSettings } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { createSale } from "@/modules/sales";
import { createMember, createProduct, createTenant, expectAppError, testDb } from "./helpers";

/** The owner's negative-stock rule on the receipt settings screen drives the till. */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let owner: TenantContext;
let manager: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "NegStock");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  owner = await createMember(db, orgId, "OWNER");
  manager = await createMember(db, orgId, "MANAGER");
  cashier = await createMember(db, orgId, "CASHIER");
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterAll(async () => {
  await db.$disconnect();
});

const KEY = () => `neg-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe("blockNegativeStock setting", () => {
  it("refuses a sale with no stock by default, allows it once the owner turns the rule off, and audits the change", async () => {
    const product = await createProduct(db, orgId);
    const sale = () =>
      createSale(
        cashier,
        {
          branchId,
          registerId,
          lines: [{ ref: { productId: product.id, variantId: null }, qty: 1 }],
          payments: [{ method: "CASH", amountMinor: product.priceMinor }],
        },
        KEY(),
      );

    expect((await getReceiptSettings(owner)).blockNegativeStock).toBe(true);
    await expectAppError(sale(), 409, "INSUFFICIENT_STOCK");

    const saved = await updateReceiptSettings(owner, { blockNegativeStock: false });
    expect(saved.blockNegativeStock).toBe(false);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "settings.receipt.updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.metadata).toMatchObject({ blockNegativeStock: { from: true, to: false } });
    await sale();
    const balance = await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId: product.id } });
    expect(balance.qty).toBe(-1);

    await expectAppError(updateReceiptSettings(manager, { blockNegativeStock: true }), 403);
  });
});
