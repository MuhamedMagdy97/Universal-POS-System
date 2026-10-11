import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuth } from "@/lib/auth/auth";
import { createTenant, testDb } from "./helpers";

const db = testDb();
const BASE = "http://localhost:3000";
const PASSWORD = "correct-horse-battery";

function randomIp(): string {
  const n = () => Math.floor(Math.random() * 250) + 1;
  return `10.${n()}.${n()}.${n()}`;
}

/** Signs a user up through Better-Auth (no membership yet). */
async function signUp(email: string): Promise<string> {
  const response = await getAuth().handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": randomIp() },
      body: JSON.stringify({ email, password: PASSWORD, name: "Sign-in test" }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed: ${response.status}`);
  const { user } = (await response.json()) as { user: { id: string } };
  return user.id;
}

/** Signs in through Better-Auth and returns the new session row. */
async function signIn(email: string) {
  const response = await getAuth().handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": randomIp() },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status}`);
  const { user } = (await response.json()) as { user: { id: string } };
  return db.session.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
}

describe("sign-in sets the active organization", () => {
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    const tenant = await createTenant(db, "Sign-in");
    orgId = tenant.org.id;
    otherOrgId = (await createTenant(db, "Sign-in other")).org.id;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("starts the session in the user's only organization", async () => {
    const email = `single-${randomUUID()}@example.test`;
    const userId = await signUp(email);
    await db.membership.create({ data: { orgId, userId, role: "ADMIN", allBranches: true } });

    const session = await signIn(email);
    expect(session.activeOrganizationId).toBe(orgId);
  });

  it("leaves the session without an organization when the user has no membership", async () => {
    const email = `none-${randomUUID()}@example.test`;
    await signUp(email);

    const session = await signIn(email);
    expect(session.activeOrganizationId).toBeNull();
  });

  it("ignores inactive memberships", async () => {
    const email = `inactive-${randomUUID()}@example.test`;
    const userId = await signUp(email);
    await db.membership.create({ data: { orgId, userId, role: "ADMIN", isActive: false } });
    await db.membership.create({ data: { orgId: otherOrgId, userId, role: "ADMIN", allBranches: true } });

    const session = await signIn(email);
    expect(session.activeOrganizationId).toBe(otherOrgId);
  });
});
