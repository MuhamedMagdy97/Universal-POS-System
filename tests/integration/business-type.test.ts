import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { getBusinessType, updateBusinessType } from "@/modules/org";
import { createMember, createTenant, expectAppError, testDb } from "./helpers";

/** Settings → Shop (business-profiles-spec BP3): only the Owner changes the business type; audited when it changes. */

let db: Db;
let orgId: string;
let otherOrgId: string;
let owner: TenantContext;
let admin: TenantContext;
let cashier: TenantContext;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "BizType");
  orgId = tenant.org.id;
  otherOrgId = (await createTenant(db, "BizTypeOther")).org.id;
  owner = await createMember(db, orgId, "OWNER");
  admin = await createMember(db, orgId, "ADMIN");
  cashier = await createMember(db, orgId, "CASHIER");
});

afterAll(async () => {
  await db.$disconnect();
});

const changes = () => db.auditEvent.count({ where: { orgId, action: "settings.business_type.updated" } });

describe("business type setting", () => {
  it("lets the owner change it, audits the change and leaves other shops alone", async () => {
    const before = await getBusinessType(owner);
    expect(before).toBe("RETAIL");
    expect(await updateBusinessType(owner, { businessType: "RESTAURANT_CAFE" })).toEqual({
      businessType: "RESTAURANT_CAFE",
    });
    expect(await getBusinessType(admin)).toBe("RESTAURANT_CAFE");
    const event = await db.auditEvent.findFirstOrThrow({
      where: { orgId, action: "settings.business_type.updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(event.metadata).toMatchObject({ businessType: { from: "RETAIL", to: "RESTAURANT_CAFE" } });
    const other = await db.organization.findUniqueOrThrow({ where: { id: otherOrgId } });
    expect(other.businessType).toBe("RETAIL");
  });

  it("saves the same type without an audit row", async () => {
    const count = await changes();
    await updateBusinessType(owner, { businessType: "RESTAURANT_CAFE" });
    expect(await changes()).toBe(count);
  });

  it("refuses an admin, a cashier and an unknown type", async () => {
    await expectAppError(updateBusinessType(admin, { businessType: "SALON" }), 403);
    await expectAppError(updateBusinessType(cashier, { businessType: "SALON" }), 403);
    await expect(updateBusinessType(owner, { businessType: "PHARMACY" })).rejects.toThrow();
    expect(await getBusinessType(owner)).toBe("RESTAURANT_CAFE");
  });
});
