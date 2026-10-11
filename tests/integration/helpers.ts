import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@/lib/db";

export function testDb(): Db {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");
  return createDb(url);
}

const short = () => randomUUID().slice(0, 8);
/** Upper-case unique suffix: SKUs must satisfy the DB CHECK sku = upper(btrim(sku)). */
export const shortUpper = () => short().toUpperCase();

/** Creates an isolated tenant (org + 2 branches + register). Unique per call, so tests never collide. */
export async function createTenant(db: Db, label = "Org") {
  const org = await db.organization.create({
    data: {
      name: `${label} ${short()}`,
      businessType: "RETAIL",
      countryCode: "EG",
      currency: "EGP",
      vatRateBp: 1400,
    },
  });
  const branchA = await db.branch.create({ data: { orgId: org.id, name: "Main", code: `M-${short()}` } });
  const branchB = await db.branch.create({ data: { orgId: org.id, name: "Second", code: `S-${short()}` } });
  const register = await db.register.create({ data: { orgId: org.id, branchId: branchA.id, name: "Till 1" } });
  return { org, branchA, branchB, register };
}

export async function createUser(db: Db, name = "Test User") {
  return db.user.create({ data: { name, email: `user-${randomUUID()}@example.test` } });
}

export async function createProduct(db: Db, orgId: string, sku = `SKU-${shortUpper()}`) {
  return db.product.create({ data: { orgId, sku, name: `Product ${sku}`, priceMinor: 1000 } });
}
