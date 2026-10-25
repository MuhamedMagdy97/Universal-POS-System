import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { DEFAULT_SCALE_SETTINGS } from "@/lib/scale-label";
import { getScaleSettings, updateScaleSettings } from "@/modules/org";
import { createMember, createTenant, expectAppError, testDb } from "./helpers";

/** Scale-label settings (weighed-selling-spec W6, W12): Owner only, off by default, audited when they change. */

let db: Db;
let orgId: string;
let owner: TenantContext;
let admin: TenantContext;

beforeAll(async () => {
  db = testDb();
  orgId = (await createTenant(db, "Scale")).org.id;
  owner = await createMember(db, orgId, "OWNER");
  admin = await createMember(db, orgId, "ADMIN");
});

afterAll(async () => {
  await db.$disconnect();
});

const changes = () => db.auditEvent.count({ where: { orgId, action: "settings.scale_labels.updated" } });
const priceLabels = { enabled: true, prefixes: ["23", "21"], itemDigits: 4, valueKind: "PRICE" as const };

describe("scale-label settings", () => {
  it("are off with prefixes 20-29 and 5 item digits for a new shop", async () => {
    expect(await getScaleSettings(admin)).toEqual(DEFAULT_SCALE_SETTINGS);
  });

  it("lets the owner change them (prefixes kept sorted), audited once; the same again is not audited", async () => {
    expect(await updateScaleSettings(owner, priceLabels)).toEqual({ ...priceLabels, prefixes: ["21", "23"] });
    expect(await getScaleSettings(admin)).toEqual({ ...priceLabels, prefixes: ["21", "23"] });
    expect(await changes()).toBe(1);
    await updateScaleSettings(owner, { ...priceLabels, prefixes: ["21", "23"] });
    expect(await changes()).toBe(1);
  });

  it("refuses an admin, item digits outside 4-6 and prefixes not 2x", async () => {
    await expectAppError(updateScaleSettings(admin, priceLabels), 403);
    for (const bad of [
      { ...priceLabels, itemDigits: 3 },
      { ...priceLabels, itemDigits: 7 },
      { ...priceLabels, prefixes: ["30"] },
      { ...priceLabels, prefixes: ["2"] },
      { ...priceLabels, prefixes: [] },
      { ...priceLabels, prefixes: ["21", "21"] },
    ]) {
      await expect(updateScaleSettings(owner, bad)).rejects.toThrow();
    }
    expect(await changes()).toBe(1);
  });
});
