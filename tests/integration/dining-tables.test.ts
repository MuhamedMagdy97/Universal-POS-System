import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { listTables, saveTables } from "@/modules/org";
import { openTicket } from "@/modules/sales";
import { createMember, createTenant, expectAppError, testDb } from "./helpers";

/** A branch's tables (restaurant-cafe-spec R3): Owner and Admin save them, audited; a dropped table is deactivated. */

let db: Db;
let orgId: string;
let branchId: string;
let otherBranchId: string;
let admin: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Tables");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  otherBranchId = (await createTenant(db, "TablesOther")).branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
});

afterAll(async () => {
  await db.$disconnect();
});

const names = async () => (await listTables(admin, branchId)).map((table) => [table.name, table.area, table.isActive]);

describe("dining tables", () => {
  it("saves, renames, reorders and deactivates, audited once per save", async () => {
    await saveTables(admin, {
      branchId,
      tables: [{ name: "1" }, { name: "2" }, { name: "T1", area: "Terrace" }],
    });
    expect(await names()).toEqual([
      ["1", null, true],
      ["2", null, true],
      ["T1", "Terrace", true],
    ]);
    const [one, two, terrace] = await listTables(admin, branchId);
    // Swap the names of 1 and 2 in one save, and drop the terrace table.
    await saveTables(admin, {
      branchId,
      tables: [
        { id: one.id, name: "2" },
        { id: two.id, name: "1" },
      ],
    });
    expect(await names()).toEqual([
      ["2", null, true],
      ["1", null, true],
      ["T1", "Terrace", false],
    ]);
    expect((await listTables(admin, branchId)).find((t) => t.id === terrace.id)?.isActive).toBe(false);
    expect(await db.auditEvent.count({ where: { orgId, action: "settings.tables.updated" } })).toBe(2);
  });

  it("refuses a repeated name, a cashier and another shop's branch", async () => {
    await expect(saveTables(admin, { branchId, tables: [{ name: "5" }, { name: "5" }] })).rejects.toThrow();
    await expectAppError(saveTables(cashier, { branchId, tables: [] }), 403);
    await expectAppError(saveTables(admin, { branchId: otherBranchId, tables: [] }), 404);
  });
});

describe("a table with an open ticket", () => {
  it("cannot be dropped, so its ticket never disappears from the floor", async () => {
    const owner = await createMember(db, orgId, "OWNER");
    const [first, second] = (await listTables(owner, branchId)).filter((table) => table.isActive);
    await openTicket(owner, { branchId, orderType: "DINE_IN", tableId: first.id });
    await expectAppError(
      saveTables(owner, { branchId, tables: [{ id: second.id, name: second.name }] }),
      409,
      "TABLE_BUSY",
    );
    // Renaming it is fine.
    await saveTables(owner, {
      branchId,
      tables: [
        { id: first.id, name: "Window" },
        { id: second.id, name: second.name },
      ],
    });
    expect((await listTables(owner, branchId)).find((table) => table.id === first.id)?.name).toBe("Window");
  });
});
