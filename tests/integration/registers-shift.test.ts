import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { openShift } from "@/modules/registers";
import { createMember, createTenant, expectAppError, testDb } from "./helpers";

/** Opening a shift (T6, Q1): one OPEN shift per register, in the caller's branch scope. */

let db: Db;
let orgId: string;
let branchId: string;
let registerId: string;
let cashier: TenantContext;
let reporting: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Shifts");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  registerId = tenant.register.id;
  cashier = await createMember(db, orgId, "CASHIER");
  reporting = await createMember(db, orgId, "REPORTING");
});

afterAll(async () => {
  await db.$disconnect();
});

describe("opening a shift", () => {
  it("opens one shift with the opening float and audits it", async () => {
    const shift = await openShift(cashier, { branchId, registerId, openingFloatMinor: 5000 });
    expect(shift).toMatchObject({ branchId, registerId, status: "OPEN", openingFloatMinor: 5000 });

    const audit = await db.auditEvent.findFirst({ where: { orgId, action: "shift.opened", entityId: shift.id } });
    expect(audit).not.toBeNull();
  });

  it("refuses a second open shift on the same register", async () => {
    await expectAppError(openShift(cashier, { branchId, registerId, openingFloatMinor: 0 }), 409, "SHIFT_ALREADY_OPEN");
  });

  it("refuses a user without registers.open", async () => {
    await expectAppError(openShift(reporting, { branchId, registerId, openingFloatMinor: 0 }), 403);
  });

  it("refuses a negative opening float", async () => {
    const other = await createTenant(db, "Negative Float");
    const member = await createMember(db, other.org.id, "CASHIER");
    // Validation errors surface as ZodError here; the route maps them to 422 VALIDATION_FAILED.
    await expect(
      openShift(member, { branchId: other.branchA.id, registerId: other.register.id, openingFloatMinor: -1 }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
