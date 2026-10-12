import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { createProduct, createTenant, createUser, testDb } from "./helpers";

/** DB rules from the purchasing migration (purchasing-data-model-and-api.md §1). */
let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let actorId: string;

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Purchasing DB");
  actorId = (await createUser(db)).id;
});

afterAll(async () => {
  await db.$disconnect();
});

async function supplier(name = `Supplier ${randomUUID().slice(0, 8)}`) {
  return db.supplier.create({ data: { orgId: tenant.org.id, name } });
}

async function po(status: "DRAFT" | "ORDERED" = "DRAFT") {
  const s = await supplier();
  return db.purchaseOrder.create({
    data: {
      orgId: tenant.org.id,
      branchId: tenant.branchA.id,
      supplierId: s.id,
      number: `PO-T${randomUUID().slice(0, 8)}`,
      status,
      createdById: actorId,
      orderedAt: status === "ORDERED" ? new Date() : null,
    },
  });
}

describe("suppliers", () => {
  it("rejects a duplicate name ignoring case", async () => {
    const name = `Nile Foods ${randomUUID().slice(0, 6)}`;
    await supplier(name);
    await expect(supplier(name.toUpperCase())).rejects.toThrow();
  });

  it("rejects a blank name", async () => {
    await expect(supplier("   ")).rejects.toThrow();
  });
});

describe("purchase orders", () => {
  it("rejects a draft with orderedAt or an ordered PO without it", async () => {
    const order = await po("DRAFT");
    await expect(
      db.purchaseOrder.update({ where: { id: order.id }, data: { orderedAt: new Date() } }),
    ).rejects.toThrow();
    await expect(db.purchaseOrder.update({ where: { id: order.id }, data: { status: "ORDERED" } })).rejects.toThrow();
  });

  it("requires closedAt exactly for closed states", async () => {
    const order = await po("ORDERED");
    await expect(db.purchaseOrder.update({ where: { id: order.id }, data: { status: "RECEIVED" } })).rejects.toThrow();
    await expect(
      db.purchaseOrder.update({ where: { id: order.id }, data: { closedAt: new Date() } }),
    ).rejects.toThrow();
    await expect(
      db.purchaseOrder.update({ where: { id: order.id }, data: { status: "CANCELLED", closedAt: new Date() } }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("allows one line per item, variant or not", async () => {
    const order = await po();
    const product = await createProduct(db, tenant.org.id);
    const line = {
      orgId: tenant.org.id,
      purchaseOrderId: order.id,
      productId: product.id,
      qtyOrdered: 1,
      unitCostMinor: 5,
    };
    await db.pOItem.create({ data: line });
    await expect(db.pOItem.create({ data: line })).rejects.toThrow();
  });

  it("never receives more than ordered", async () => {
    const order = await po();
    const product = await createProduct(db, tenant.org.id);
    await expect(
      db.pOItem.create({
        data: {
          orgId: tenant.org.id,
          purchaseOrderId: order.id,
          productId: product.id,
          qtyOrdered: 2,
          qtyReceived: 3,
          unitCostMinor: 5,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("goods receipts", () => {
  it("are append-only", async () => {
    const order = await po("ORDERED");
    const receipt = await db.goodsReceipt.create({
      data: {
        orgId: tenant.org.id,
        branchId: tenant.branchA.id,
        purchaseOrderId: order.id,
        idempotencyKey: randomUUID(),
        requestHash: "x",
        receivedById: actorId,
      },
    });
    await expect(db.goodsReceipt.update({ where: { id: receipt.id }, data: { note: "edit" } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db.goodsReceipt.delete({ where: { id: receipt.id } })).rejects.toThrow(/append-only/);
  });
});
