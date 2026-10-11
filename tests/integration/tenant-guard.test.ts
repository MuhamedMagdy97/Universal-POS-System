import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { prismaTenantRepository, resolveTenantContext, type TenantRepository } from "@/lib/auth/tenant";
import type { SessionIdentity } from "@/lib/auth/session";
import { createTenant, createUser, testDb } from "./helpers";

/** Acceptance criterion 6: cross-tenant read → 403/404, no leak. Runs against real Postgres. */
let db: Db;
let repo: TenantRepository;
let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
let cashierId: string;
let adminId: string;
let outsiderId: string;

function identity(userId: string, orgId: string | null, branchId: string | null = null): SessionIdentity {
  return { userId, sessionId: randomUUID(), activeOrganizationId: orgId, activeBranchId: branchId };
}

async function expectAppError(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  return err as AppError;
}

beforeAll(async () => {
  db = testDb();
  repo = prismaTenantRepository(db);
  a = await createTenant(db, "Tenant A");
  b = await createTenant(db, "Tenant B");

  const cashier = await createUser(db, "Cashier A");
  const membership = await db.membership.create({ data: { orgId: a.org.id, userId: cashier.id, role: "CASHIER" } });
  await db.membershipBranch.create({ data: { orgId: a.org.id, membershipId: membership.id, branchId: a.branchA.id } });
  cashierId = cashier.id;

  const admin = await createUser(db, "Admin A");
  await db.membership.create({ data: { orgId: a.org.id, userId: admin.id, role: "ADMIN", allBranches: true } });
  adminId = admin.id;

  outsiderId = (await createUser(db, "Outsider")).id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe("tenant guard", () => {
  it("rejects a request without a session (401)", async () => {
    await expectAppError(resolveTenantContext(null, {}, repo), 401);
  });

  it("rejects a session with no active organization (403)", async () => {
    await expectAppError(resolveTenantContext(identity(cashierId, null), {}, repo), 403);
  });

  it("resolves org and an assigned branch for a member", async () => {
    const ctx = await resolveTenantContext(identity(cashierId, a.org.id), { branchId: a.branchA.id }, repo);
    expect(ctx).toMatchObject({ userId: cashierId, orgId: a.org.id, role: "CASHIER", branchId: a.branchA.id });
  });

  it("returns 404 for a branch of the same org the cashier is not assigned to", async () => {
    await expectAppError(resolveTenantContext(identity(cashierId, a.org.id), { branchId: a.branchB.id }, repo), 404);
  });

  it("returns 404 for another tenant's branch without leaking anything about it", async () => {
    const err = await expectAppError(
      resolveTenantContext(identity(adminId, a.org.id), { branchId: b.branchA.id }, repo),
      404,
    );
    expect(err.message).toBe("Branch not found");
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(b.org.id);
    expect(err.message).not.toContain(b.org.name);
  });

  it("answers the same 404 for a branch that does not exist at all", async () => {
    const err = await expectAppError(
      resolveTenantContext(identity(adminId, a.org.id), { branchId: randomUUID() }, repo),
      404,
    );
    expect(err.message).toBe("Branch not found");
  });

  it("treats malformed branch ids as not found", async () => {
    await expectAppError(
      resolveTenantContext(identity(adminId, a.org.id), { branchId: "'; DROP TABLE x;--" }, repo),
      404,
    );
  });

  it("forbids a user pointing their session at an org they do not belong to (403)", async () => {
    await expectAppError(resolveTenantContext(identity(outsiderId, b.org.id), {}, repo), 403);
    await expectAppError(resolveTenantContext(identity(cashierId, b.org.id), {}, repo), 403);
  });

  it("enforces permissions server-side (403)", async () => {
    await expectAppError(
      resolveTenantContext(identity(cashierId, a.org.id), { permission: "reports.view" }, repo),
      403,
    );
    const ctx = await resolveTenantContext(identity(cashierId, a.org.id), { permission: "sales.create" }, repo);
    expect(ctx.role).toBe("CASHIER");
  });

  it("lets all-branch admins use any branch of their own org", async () => {
    const ctx = await resolveTenantContext(identity(adminId, a.org.id), { branchId: a.branchB.id }, repo);
    expect(ctx.branchId).toBe(a.branchB.id);
  });

  it("blocks deactivated memberships (403)", async () => {
    const user = await createUser(db, "Former staff");
    await db.membership.create({ data: { orgId: a.org.id, userId: user.id, role: "OWNER", isActive: false } });
    await expectAppError(resolveTenantContext(identity(user.id, a.org.id), {}, repo), 403);
  });

  it("drops a session branch the member can no longer access", async () => {
    const ctx = await resolveTenantContext(identity(cashierId, a.org.id, a.branchB.id), {}, repo);
    expect(ctx.branchId).toBeNull();
  });
});
