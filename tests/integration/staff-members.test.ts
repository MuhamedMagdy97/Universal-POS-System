import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { listStaffMembers, saveStaffMember } from "@/modules/org";
import { createMember, createTenant, expectAppError, testDb } from "./helpers";

/** Staff members (salon-spec S3): saved by Owner and Admin with branches and commission, audited; deactivated, kept. */

let db: Db;
let orgId: string;
let branchA: string;
let branchB: string;
let admin: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Team");
  orgId = tenant.org.id;
  branchA = tenant.branchA.id;
  branchB = tenant.branchB.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
});

afterAll(async () => {
  await db.$disconnect();
});

describe("staff members", () => {
  it("are saved with branches and a commission, listed per branch, and deactivated", async () => {
    const sara = await saveStaffMember(admin, {
      name: "Sara",
      nameAr: "سارة",
      commissionBp: 4_000,
      branchIds: [branchA],
    });
    const omar = await saveStaffMember(admin, { name: "Omar", commissionBp: 3_000, branchIds: [branchA, branchB] });
    expect((await listStaffMembers(cashier, branchB)).map((row) => row.name)).toEqual(["Omar"]);
    expect((await listStaffMembers(cashier, branchA)).map((row) => row.name)).toEqual(["Omar", "Sara"]);

    const raised = await saveStaffMember(admin, { ...sara, id: sara.id, commissionBp: 4_500, nameAr: "سارة" });
    expect(raised).toMatchObject({ commissionBp: 4_500, branchIds: [branchA] });
    await saveStaffMember(admin, { ...omar, id: omar.id, isActive: false });
    expect((await listStaffMembers(cashier, branchA)).map((row) => row.name)).toEqual(["Sara"]);
    expect((await listStaffMembers(admin)).map((row) => [row.name, row.isActive])).toEqual([
      ["Sara", true],
      ["Omar", false],
    ]);
    expect(await db.auditEvent.count({ where: { orgId, action: "settings.staff_member.saved" } })).toBe(4);
  });

  it("refuses a cashier, a commission over 100 % and no branch", async () => {
    await expectAppError(saveStaffMember(cashier, { name: "X", commissionBp: 0, branchIds: [branchA] }), 403);
    await expect(saveStaffMember(admin, { name: "X", commissionBp: 10_001, branchIds: [branchA] })).rejects.toThrow();
    await expect(saveStaffMember(admin, { name: "X", commissionBp: 0, branchIds: [] })).rejects.toThrow();
  });
});
