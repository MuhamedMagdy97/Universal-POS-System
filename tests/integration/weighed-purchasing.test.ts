import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import {
  createPurchaseOrder,
  createSupplier,
  getPurchaseReturn,
  getSupplierStatement,
  orderPurchaseOrder,
  receivePurchaseOrder,
  returnToSupplier,
} from "@/modules/purchasing";
import { getReport } from "@/modules/reports";
import { createMember, createProduct, createTenant, expectReconciled, testDb, uniqueCode } from "./helpers";

/**
 * Purchasing in kg (weighed-selling-spec W2, W3, W7): 12.5 kg of rice at EGP 40.00 per kg is EGP 500.00, not
 * 500,000.00. Quantities are grams; the cost is per kg.
 */

let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let owner: TenantContext;
let rice: string;
let pens: string;

const KEY = () => `kgp-${uniqueCode()}`;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "WeighedBuy");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  owner = await createMember(db, orgId, "OWNER");
  rice = (await createProduct(db, orgId)).id;
  await db.product.update({ where: { id: rice }, data: { unitType: "KG", name: "Rice" } });
  pens = (await createProduct(db, orgId)).id;
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("a purchase order in kg", () => {
  it("values, receives and returns a weighed line per kg", async () => {
    const supplier = await createSupplier(admin, { name: `Mill ${uniqueCode()}` });
    const draft = await createPurchaseOrder(admin, {
      branchId,
      supplierId: supplier.id,
      lines: [
        { ref: { productId: rice }, qty: 12_500, unitCostMinor: 4_000 },
        { ref: { productId: pens }, qty: 3, unitCostMinor: 150 },
      ],
    });
    const riceLine = draft.lines.find((line) => line.productId === rice);
    expect(riceLine).toMatchObject({ unitType: "KG", lineTotalMinor: 50_000 });
    expect(draft.totals.totalMinor).toBe(50_450);

    const po = await orderPurchaseOrder(admin, draft.id);
    const { po: received } = await receivePurchaseOrder(admin, po.id, KEY(), {
      lines: po.lines.map((line) => ({ poItemId: line.id, qty: line.qtyOrdered })),
    });
    expect(received.receipts[0].valueMinor).toBe(50_450);
    const balance = await db.stockBalance.findFirstOrThrow({ where: { orgId, branchId, productId: rice } });
    expect(balance.qty).toBe(12_500);
    expect((await db.product.findUniqueOrThrow({ where: { id: rice } })).costMinor).toBe(4_000);

    const ricePoLine = received.lines.find((line) => line.productId === rice);
    const { po: afterReturn, returnId } = await returnToSupplier(admin, po.id, KEY(), {
      reason: "DAMAGED",
      lines: [{ poItemId: ricePoLine?.id ?? "", qty: 2_000 }],
    });
    expect(afterReturn.returns[0].valueMinor).toBe(8_000);
    const detail = await getPurchaseReturn(admin, po.id, returnId);
    expect(detail.lines[0].lineTotalMinor).toBe(8_000);

    // Supplier account and the purchases report value the same lines per kg.
    expect((await getSupplierStatement(admin, supplier.id)).balanceMinor).toBe(50_450 - 8_000);
    const report = await getReport(owner, "purchases", {});
    expect(report.rows.find((row) => row.supplierId === supplier.id)).toMatchObject({
      valueMinor: 50_450,
      returnedValueMinor: 8_000,
    });
  });
});
