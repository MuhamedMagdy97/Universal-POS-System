import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { createProduct, createTenant, createUser, testDb } from "./helpers";

/**
 * These tests exercise the real PostgreSQL schema produced by the migrations.
 * They prove invariants hold in the database itself, not just in app code.
 */
let db: Db;
let tenantA: Awaited<ReturnType<typeof createTenant>>;
let tenantB: Awaited<ReturnType<typeof createTenant>>;
let actorId: string;

beforeAll(async () => {
  db = testDb();
  tenantA = await createTenant(db, "Tenant A");
  tenantB = await createTenant(db, "Tenant B");
  actorId = (await createUser(db)).id;
});

afterAll(async () => {
  await db.$disconnect();
});

async function openShift(orgId: string, branchId: string, registerId: string) {
  return db.registerShift.create({
    data: { orgId, branchId, registerId, openedById: actorId, openingFloatMinor: 10_000 },
  });
}

describe("tenant-aware uniqueness", () => {
  it("rejects a duplicate SKU inside one org but allows it in another", async () => {
    const sku = `DUP-${randomUUID().slice(0, 6).toUpperCase()}`;
    await createProduct(db, tenantA.org.id, sku);
    await expect(createProduct(db, tenantA.org.id, sku)).rejects.toThrow();
    await expect(createProduct(db, tenantB.org.id, sku)).resolves.toMatchObject({ sku });
  });

  it("rejects a duplicate barcode inside one org", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const code = `622${Date.now()}`;
    await db.barcode.create({ data: { orgId: tenantA.org.id, code, productId: product.id } });
    await expect(db.barcode.create({ data: { orgId: tenantA.org.id, code, productId: product.id } })).rejects.toThrow();
  });

  it("allows one membership per (org, user)", async () => {
    const user = await createUser(db);
    await db.membership.create({ data: { orgId: tenantA.org.id, userId: user.id, role: "CASHIER" } });
    await expect(
      db.membership.create({ data: { orgId: tenantA.org.id, userId: user.id, role: "ADMIN" } }),
    ).rejects.toThrow();
  });

  it("keeps a single stock balance row for a product without variants", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const data = { orgId: tenantA.org.id, branchId: tenantA.branchA.id, productId: product.id, qty: 5 };
    await db.stockBalance.create({ data });
    // NULL variantId must still collide (NULLS NOT DISTINCT).
    await expect(db.stockBalance.create({ data })).rejects.toThrow();
  });
});

describe("cross-tenant references are rejected by composite foreign keys", () => {
  it("cannot attach a register to another tenant's branch", async () => {
    await expect(
      db.register.create({ data: { orgId: tenantA.org.id, branchId: tenantB.branchA.id, name: "Rogue till" } }),
    ).rejects.toThrow();
  });

  it("cannot record a barcode for another tenant's product", async () => {
    const foreignProduct = await createProduct(db, tenantB.org.id);
    await expect(
      db.barcode.create({ data: { orgId: tenantA.org.id, code: `X${Date.now()}`, productId: foreignProduct.id } }),
    ).rejects.toThrow();
  });

  it("cannot write an inventory movement against another tenant's branch", async () => {
    const product = await createProduct(db, tenantA.org.id);
    await expect(
      db.inventoryMovement.create({
        data: {
          orgId: tenantA.org.id,
          branchId: tenantB.branchA.id,
          productId: product.id,
          qtyDelta: 1,
          reason: "ADJUSTMENT",
          actorUserId: actorId,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("append-only ledger and audit", () => {
  it("rejects UPDATE and DELETE on inventory movements", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const movement = await db.inventoryMovement.create({
      data: {
        orgId: tenantA.org.id,
        branchId: tenantA.branchA.id,
        productId: product.id,
        qtyDelta: 10,
        reason: "OPENING_BALANCE",
        actorUserId: actorId,
      },
    });
    await expect(db.inventoryMovement.update({ where: { id: movement.id }, data: { qtyDelta: 99 } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db.inventoryMovement.delete({ where: { id: movement.id } })).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`TRUNCATE "InventoryMovement"`)).rejects.toThrow(/append-only/);
  });

  it("rejects zero-quantity movements and unpaired transfers", async () => {
    const product = await createProduct(db, tenantA.org.id);
    const base = { orgId: tenantA.org.id, branchId: tenantA.branchA.id, productId: product.id, actorUserId: actorId };
    await expect(
      db.inventoryMovement.create({ data: { ...base, qtyDelta: 0, reason: "ADJUSTMENT" } }),
    ).rejects.toThrow();
    await expect(
      db.inventoryMovement.create({ data: { ...base, qtyDelta: -1, reason: "TRANSFER_OUT" } }),
    ).rejects.toThrow();
  });

  it("rejects UPDATE and DELETE on audit events", async () => {
    const event = await db.auditEvent.create({
      data: { orgId: tenantA.org.id, actorUserId: actorId, action: "test.created", entityType: "Test" },
    });
    await expect(db.auditEvent.update({ where: { id: event.id }, data: { action: "tampered" } })).rejects.toThrow(
      /append-only/,
    );
    await expect(db.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/);
  });
});

describe("money columns", () => {
  it("rejects negative prices", async () => {
    await expect(
      db.product.create({ data: { orgId: tenantA.org.id, sku: `NEG-${Date.now()}`, name: "Bad", priceMinor: -1 } }),
    ).rejects.toThrow();
  });

  it("rejects a VAT rate above 100%", async () => {
    await expect(
      db.organization.create({
        data: { name: "Bad VAT", businessType: "RETAIL", countryCode: "SA", currency: "SAR", vatRateBp: 10_001 },
      }),
    ).rejects.toThrow();
  });
});

describe("register shifts", () => {
  it("allows only one open shift per register", async () => {
    const register = await db.register.create({
      data: { orgId: tenantA.org.id, branchId: tenantA.branchA.id, name: `Till ${randomUUID().slice(0, 4)}` },
    });
    await openShift(tenantA.org.id, tenantA.branchA.id, register.id);
    await expect(openShift(tenantA.org.id, tenantA.branchA.id, register.id)).rejects.toThrow();
  });

  it("requires a note to close with a discrepancy, then freezes the shift", async () => {
    const register = await db.register.create({
      data: { orgId: tenantA.org.id, branchId: tenantA.branchA.id, name: `Till ${randomUUID().slice(0, 4)}` },
    });
    const shift = await openShift(tenantA.org.id, tenantA.branchA.id, register.id);
    const close = {
      status: "CLOSED" as const,
      closedAt: new Date(),
      closedById: actorId,
      expectedCashMinor: 10_000,
      countedCashMinor: 9_500,
      discrepancyMinor: -500,
    };
    await expect(db.registerShift.update({ where: { id: shift.id }, data: close })).rejects.toThrow();
    await expect(
      db.registerShift.update({
        where: { id: shift.id },
        data: { ...close, discrepancyMinor: -400, discrepancyNote: "x" },
      }),
    ).rejects.toThrow(); // discrepancy must equal counted − expected
    await db.registerShift.update({ where: { id: shift.id }, data: { ...close, discrepancyNote: "Short by 5 EGP" } });

    await expect(
      db.registerShift.update({ where: { id: shift.id }, data: { countedCashMinor: 10_000 } }),
    ).rejects.toThrow(/closed and immutable/);
    await expect(db.registerShift.delete({ where: { id: shift.id } })).rejects.toThrow();
  });
});

describe("sales", () => {
  async function createSale(idempotencyKey: string) {
    const register = await db.register.create({
      data: { orgId: tenantA.org.id, branchId: tenantA.branchA.id, name: `Till ${randomUUID().slice(0, 4)}` },
    });
    const shift = await openShift(tenantA.org.id, tenantA.branchA.id, register.id);
    return db.sale.create({
      data: {
        orgId: tenantA.org.id,
        branchId: tenantA.branchA.id,
        registerId: register.id,
        shiftId: shift.id,
        cashierId: actorId,
        number: `S-${randomUUID().slice(0, 8)}`,
        idempotencyKey,
        currency: "EGP",
        subtotalMinor: 1000,
        vatMinor: 140,
        totalMinor: 1140,
      },
    });
  }

  it("enforces one sale per idempotency key per org", async () => {
    const key = randomUUID();
    const sale = await createSale(key);
    await expect(
      db.sale.create({ data: { ...sale, id: randomUUID(), number: `S-${randomUUID()}` } }),
    ).rejects.toThrow();
  });

  it("keeps financial fields immutable and only allows COMPLETED → VOIDED", async () => {
    const sale = await createSale(randomUUID());
    await expect(db.sale.update({ where: { id: sale.id }, data: { totalMinor: 1 } })).rejects.toThrow(/immutable/);
    await expect(db.sale.update({ where: { id: sale.id }, data: { status: "VOIDED" } })).rejects.toThrow(); // void fields required
    await db.sale.update({
      where: { id: sale.id },
      data: { status: "VOIDED", voidedAt: new Date(), voidedById: actorId, voidReason: "Customer changed mind" },
    });
    await expect(db.sale.update({ where: { id: sale.id }, data: { voidReason: "edited later" } })).rejects.toThrow(
      /immutable/,
    );
    await expect(db.sale.delete({ where: { id: sale.id } })).rejects.toThrow();
  });
});
