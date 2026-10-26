import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { bookAppointment, getAppointment } from "@/modules/appointments";
import * as catalog from "@/modules/catalog";
import * as inventory from "@/modules/inventory";
import { saveStaffMember } from "@/modules/org";
import { openShift } from "@/modules/registers";
import { createSale } from "@/modules/sales";
import { appointmentForTill } from "@/app/(app)/pos/_lib/appointment";
import {
  createMember,
  createProduct,
  createTenant,
  expectAppError,
  expectReconciled,
  testDb,
  uniqueCode,
} from "./helpers";

/** Checking out an appointment (salon-spec S7): an ordinary sale that marks it DONE, once. */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let cashier: TenantContext;
let haircut: string;
let shampoo: string;
let saraId: string;

const KEY = () => `apt-${crypto.randomUUID()}`;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Checkout");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  const owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  haircut = (
    await catalog.createProductAggregate(owner, {
      sku: `CUT-${uniqueCode()}`,
      name: "Haircut",
      priceMinor: 15_000,
      isService: true,
      durationMin: 45,
    })
  ).id;
  shampoo = (await createProduct(db, orgId)).id;
  await inventory.recordOpeningBalances(owner, {
    branchId,
    lines: [{ ref: { productId: shampoo, variantId: null }, qty: 5 }],
  });
  saraId = (await saveStaffMember(owner, { name: "Sara", commissionBp: 4_000, branchIds: [branchId] })).id;
  await openShift(cashier, { branchId, registerId, openingFloatMinor: 0 });
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("checking out an appointment", () => {
  it("sells its services and anything added, marks it done and links the sale, once", async () => {
    const appointment = await bookAppointment(cashier, {
      branchId,
      day: "2026-11-05",
      startMin: 600,
      staffMemberId: saraId,
      customerName: "Mona",
      customerPhone: "01001234567",
      serviceIds: [haircut],
    });
    const forTill = await appointmentForTill(cashier, appointment.id, branchId, "en");
    expect(forTill).toMatchObject({ customerName: "Mona", staff: { name: "Sara" }, items: [{ productId: haircut }] });
    const body = {
      branchId,
      registerId,
      appointmentId: appointment.id,
      lines: [
        { ref: { productId: haircut, variantId: null }, qty: 1, staffMemberId: saraId },
        { ref: { productId: shampoo, variantId: null }, qty: 1 },
      ],
      payments: [{ method: "CASH" as const, amountMinor: 16_000 }],
    };
    const { sale } = await createSale(cashier, body, KEY());
    expect(sale.appointmentId).toBe(appointment.id);
    expect(await getAppointment(cashier, appointment.id)).toMatchObject({ status: "DONE", saleId: sale.id });
    await expectAppError(createSale(cashier, body, KEY()), 409, "APPOINTMENT_CLOSED");
  });
});
