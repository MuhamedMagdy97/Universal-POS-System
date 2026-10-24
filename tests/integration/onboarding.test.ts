import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db";
import { getAuth } from "@/lib/auth/auth";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import {
  addStaff,
  changeOwnPassword,
  createBranch,
  createRegister,
  createShop,
  listStaff,
  updateBranch,
  updateRegister,
  updateStaff,
} from "@/modules/org";
import { closeShift, openShift } from "@/modules/registers";
import { createProduct, expectAppError, testDb } from "./helpers";

/** Onboarding spec acceptance: shop setup, staff, branches and tills, my-account password. */

const BASE = "http://localhost:3000/api/auth";
const PASSWORD = "correct horse battery";
let db: Db;

const email = (label: string) => `${label}-${randomUUID()}@example.test`;
const ip = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

function authPost(path: string, body: unknown) {
  return getAuth().handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": ip() },
      body: JSON.stringify(body),
    }),
  );
}

/** Signs in and returns request headers carrying the session cookie (null when sign-in fails). */
async function signIn(address: string, password = PASSWORD): Promise<Headers | null> {
  const response = await authPost("/sign-in/email", { email: address, password });
  if (response.status !== 200) return null;
  const cookie = response.headers.getSetCookie().find((c) => c.includes("session_token="));
  return cookie ? new Headers({ cookie: cookie.split(";")[0] ?? "" }) : null;
}

async function shop(label = "Shop", country: "EG" | "SA" = "EG") {
  const ownerEmail = email(label.toLowerCase());
  const created = await createShop({
    businessType: "RETAIL",
    shopName: `${label} ${randomUUID().slice(0, 8)}`,
    country,
    branchName: "Main",
    account: { ownerName: "Owner", email: ownerEmail, password: PASSWORD },
  });
  const membership = await db.membership.findUniqueOrThrow({
    where: { orgId_userId: { orgId: created.orgId, userId: created.userId } },
  });
  const owner: TenantContext = {
    userId: created.userId,
    orgId: created.orgId,
    membershipId: membership.id,
    role: "OWNER",
    branchId: null,
  };
  return { ...created, owner, ownerEmail };
}

/** Adds a member through the service and returns their context. */
async function member(actor: TenantContext, role: TenantContext["role"], address = email(role.toLowerCase())) {
  await addStaff(actor, { name: role, email: address, password: PASSWORD, role, branches: { allBranches: true } });
  const user = await db.user.findUniqueOrThrow({ where: { email: address } });
  const membership = await db.membership.findUniqueOrThrow({
    where: { orgId_userId: { orgId: actor.orgId, userId: user.id } },
  });
  const ctx: TenantContext = { userId: user.id, orgId: actor.orgId, membershipId: membership.id, role, branchId: null };
  return { ctx, email: address };
}

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("shop setup", () => {
  it("creates the owner login, shop, Main branch, Till 1 and Owner membership, then signs in to the shop", async () => {
    const created = await shop("Setup", "SA");
    const org = await db.organization.findUniqueOrThrow({ where: { id: created.orgId } });
    expect(org).toMatchObject({
      businessType: "RETAIL",
      countryCode: "SA",
      currency: "SAR",
      vatRateBp: 1500,
      pricesIncludeVat: true,
      blockNegativeStock: true,
      legalName: null,
    });
    const branch = await db.branch.findUniqueOrThrow({ where: { id: created.branchId } });
    expect(branch).toMatchObject({ name: "Main", code: "MAIN", isActive: true });
    const register = await db.register.findUniqueOrThrow({ where: { id: created.registerId } });
    expect(register).toMatchObject({ branchId: created.branchId, name: "Till 1" });
    const membership = await db.membership.findUniqueOrThrow({ where: { id: created.owner.membershipId } });
    expect(membership).toMatchObject({ role: "OWNER", allBranches: true, isActive: true });
    const account = await db.account.findFirstOrThrow({ where: { userId: created.userId } });
    expect(account).toMatchObject({ providerId: "credential", accountId: created.userId });
    expect(account.password).toMatch(/^\$argon2id\$/);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { orgId: created.orgId, action: "org.created" } });
    expect(audit.actorUserId).toBe(created.userId);

    const headers = await signIn(created.ownerEmail);
    const session = await getAuth().api.getSession({ headers: headers ?? new Headers() });
    expect(session?.session.activeOrganizationId).toBe(created.orgId);

    // The till sells once a product with stock exists (acceptance 1).
    const product = await createProduct(db, created.orgId);
    await inventory.recordOpeningBalances(created.owner, {
      branchId: created.branchId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty: 3 }],
    });
    const shift = await openShift(created.owner, {
      branchId: created.branchId,
      registerId: created.registerId,
      openingFloatMinor: 0,
    });
    expect(shift.status).toBe("OPEN");
  });

  it("creates a shop of any business type (business-profiles-spec BP2)", async () => {
    const created = await createShop({
      businessType: "SALON",
      shopName: `Salon ${randomUUID().slice(0, 8)}`,
      country: "SA",
      branchName: "Main",
      account: { ownerName: "Owner", email: email("salon"), password: PASSWORD },
    });
    const org = await db.organization.findUniqueOrThrow({ where: { id: created.orgId } });
    expect(org.businessType).toBe("SALON");
  });

  it("leaves nothing behind when the email is taken or the input is bad (acceptance 2)", async () => {
    const first = await shop("Dup");
    const name = `Orphan ${randomUUID()}`;
    await expectAppError(
      createShop({
        businessType: "RETAIL",
        shopName: name,
        country: "EG",
        branchName: "Main",
        account: { ownerName: "Again", email: first.ownerEmail.toUpperCase(), password: PASSWORD },
      }),
      409,
      "EMAIL_TAKEN",
    );
    const badEmail = email("bad");
    await expect(
      createShop({
        businessType: "PHARMACY" as "RETAIL",
        shopName: name,
        country: "EG",
        branchName: "Main",
        account: { ownerName: "Bad", email: badEmail, password: PASSWORD },
      }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      createShop({ businessType: "RETAIL", shopName: name, country: "EG", branchName: "Main" }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await db.organization.count({ where: { name } })).toBe(0);
    expect(await db.user.count({ where: { email: badEmail } })).toBe(0);
  });

  it("finishes setup for a signed-in user without a shop, once (O7, O8)", async () => {
    const address = email("api");
    expect((await authPost("/sign-up/email", { email: address, password: PASSWORD, name: "API" })).status).toBe(200);
    const headers = await signIn(address);
    const session = await getAuth().api.getSession({ headers: headers ?? new Headers() });
    expect(session?.session.activeOrganizationId ?? null).toBeNull();
    const userId = session?.user.id ?? "";

    const input = { businessType: "RETAIL", shopName: "Late shop", country: "EG", branchName: "Main" };
    const created = await createShop(input, { signedInUserId: userId });
    const moved = await getAuth().api.getSession({ headers: headers ?? new Headers() });
    expect(moved?.session.activeOrganizationId).toBe(created.orgId);

    await expectAppError(createShop(input, { signedInUserId: userId }), 403, "ALREADY_IN_SHOP");
  });
});

describe("staff", () => {
  it("adds a cashier with chosen branches who can sign in; deactivation signs them out (acceptance 3)", async () => {
    const { owner } = await shop("Staff");
    const second = await createBranch(owner, { name: "Second", code: "s2" });
    const address = email("cashier");
    await addStaff(owner, {
      name: "Cashier",
      email: address,
      password: PASSWORD,
      role: "CASHIER",
      branches: { allBranches: false, branchIds: [second.id] },
    });
    const row = (await listStaff(owner)).find((s) => s.email === address);
    expect(row).toMatchObject({ role: "CASHIER", allBranches: false, branchIds: [second.id], isActive: true });

    const headers = await signIn(address);
    expect(await getAuth().api.getSession({ headers: headers ?? new Headers() })).not.toBeNull();

    await updateStaff(owner, row?.membershipId ?? "", { isActive: false });
    expect(await getAuth().api.getSession({ headers: headers ?? new Headers() })).toBeNull();
    expect(await db.session.count({ where: { userId: row?.userId } })).toBe(0);
    const actions = await db.auditEvent.findMany({
      where: { orgId: owner.orgId, entityId: row?.membershipId },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual(["staff.added", "staff.deactivated"]);

    await updateStaff(owner, row?.membershipId ?? "", { isActive: true });
    expect(await signIn(address)).not.toBeNull();
  });

  it("refuses a taken email, a foreign branch and a staff change by a cashier", async () => {
    const a = await shop("StaffA");
    const b = await shop("StaffB");
    await expectAppError(
      addStaff(a.owner, {
        name: "Dup",
        email: b.ownerEmail,
        password: PASSWORD,
        role: "CASHIER",
        branches: { allBranches: true },
      }),
      409,
      "EMAIL_TAKEN",
    );
    const foreign = email("foreign");
    await expectAppError(
      addStaff(a.owner, {
        name: "Foreign",
        email: foreign,
        password: PASSWORD,
        role: "CASHIER",
        branches: { allBranches: false, branchIds: [b.branchId] },
      }),
      404,
    );
    expect(await db.user.count({ where: { email: foreign } })).toBe(0);

    const cashier = await member(a.owner, "CASHIER");
    await expectAppError(listStaff(cashier.ctx), 403);
    expect(
      await db.auditEvent.count({
        where: { orgId: a.owner.orgId, actorUserId: cashier.ctx.userId, action: "staff.permission.denied" },
      }),
    ).toBe(1);
  });

  it("lets only an owner manage owners and admins, and nobody edit themselves (acceptance 4)", async () => {
    const { owner } = await shop("Roles");
    const admin = await member(owner, "ADMIN");
    const otherAdmin = await member(owner, "ADMIN");
    const staffInput = (role: "OWNER" | "ADMIN" | "MANAGER") => ({
      name: role,
      email: email(role.toLowerCase()),
      password: PASSWORD,
      role,
      branches: { allBranches: true } as const,
    });

    await expectAppError(addStaff(admin.ctx, staffInput("ADMIN")), 403);
    await expectAppError(addStaff(admin.ctx, staffInput("OWNER")), 403);
    await addStaff(admin.ctx, staffInput("MANAGER"));
    await expectAppError(updateStaff(admin.ctx, otherAdmin.ctx.membershipId, { isActive: false }), 403);
    await expectAppError(updateStaff(admin.ctx, owner.membershipId, { role: "CASHIER" }), 403);
    const manager = (await listStaff(owner)).find((s) => s.role === "MANAGER");
    await expectAppError(updateStaff(admin.ctx, manager?.membershipId ?? "", { role: "ADMIN" }), 403);
    await expectAppError(updateStaff(owner, owner.membershipId, { role: "ADMIN" }), 403, "SELF");

    await updateStaff(owner, otherAdmin.ctx.membershipId, { role: "OWNER" });
    expect((await db.membership.findUniqueOrThrow({ where: { id: otherAdmin.ctx.membershipId } })).role).toBe("OWNER");
  });

  it("keeps one active owner when two owners remove each other at once (R3)", async () => {
    const { owner } = await shop("LastOwner");
    const second = await member(owner, "OWNER");
    const results = await Promise.allSettled([
      updateStaff(owner, second.ctx.membershipId, { isActive: false }),
      updateStaff(second.ctx, owner.membershipId, { role: "MANAGER" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect((refused as PromiseRejectedResult).reason.details).toMatchObject({ reason: "LAST_OWNER" });
    expect(await db.membership.count({ where: { orgId: owner.orgId, role: "OWNER", isActive: true } })).toBe(1);
  });

  it("sets a new temporary password that signs the person out (R4)", async () => {
    const { owner } = await shop("Reset");
    const cashier = await member(owner, "CASHIER");
    const headers = await signIn(cashier.email);
    await updateStaff(owner, cashier.ctx.membershipId, { password: "brand new password" });
    expect(await getAuth().api.getSession({ headers: headers ?? new Headers() })).toBeNull();
    expect(await signIn(cashier.email)).toBeNull();
    expect(await signIn(cashier.email, "brand new password")).not.toBeNull();
  });
});

describe("branches and tills", () => {
  it("adds branches with unique codes ignoring case, and tills that show on the branch (acceptance 5)", async () => {
    const { owner, branchId } = await shop("Branches");
    const second = await createBranch(owner, { name: "Second", code: " north-1 " });
    expect((await db.branch.findUniqueOrThrow({ where: { id: second.id } })).code).toBe("NORTH-1");
    await expectAppError(createBranch(owner, { name: "Dup", code: "North-1" }), 409, "BRANCH_CODE_TAKEN");
    await expect(createBranch(owner, { name: "Bad", code: "no spaces" })).rejects.toBeInstanceOf(ZodError);

    const till = await createRegister(owner, { branchId: second.id, name: "Till 1" });
    await expectAppError(createRegister(owner, { branchId: second.id, name: "Till 1" }), 409, "REGISTER_NAME_TAKEN");
    const shift = await openShift(owner, { branchId: second.id, registerId: till.id, openingFloatMinor: 0 });
    expect(shift.registerId).toBe(till.id);
    await closeShift(owner, shift.id, { countedCashMinor: 0 });

    await updateRegister(owner, till.id, { name: "Front" });
    await updateRegister(owner, till.id, { isActive: false });
    await expectAppError(openShift(owner, { branchId: second.id, registerId: till.id, openingFloatMinor: 0 }), 404);
    await updateBranch(owner, second.id, { isActive: false });
    await expectAppError(updateRegister(owner, till.id, { isActive: true }), 409, "BRANCH_INACTIVE");
    await expectAppError(createRegister(owner, { branchId: second.id, name: "Late" }), 409, "BRANCH_INACTIVE");
    await expectAppError(updateBranch(owner, branchId, { isActive: false }), 409, "LAST_BRANCH");

    const actions = await db.auditEvent.findMany({
      where: { orgId: owner.orgId, entityType: { in: ["Branch", "Register"] } },
      select: { action: true },
    });
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set(["branch.created", "register.created", "register.updated", "register.deactivated", "branch.deactivated"]),
    );
  });

  it("refuses to deactivate a branch with stock or an open shift, or a till with an open shift", async () => {
    const { owner, branchId, registerId } = await shop("Guards");
    await createBranch(owner, { name: "Other", code: "OTHER" });

    const shift = await openShift(owner, { branchId, registerId, openingFloatMinor: 0 });
    await expectAppError(updateRegister(owner, registerId, { isActive: false }), 409, "REGISTER_HAS_OPEN_SHIFT");
    await expectAppError(updateBranch(owner, branchId, { isActive: false }), 409, "BRANCH_HAS_OPEN_SHIFT");
    await closeShift(owner, shift.id, { countedCashMinor: 0 });

    const product = await createProduct(db, owner.orgId);
    await inventory.recordOpeningBalances(owner, {
      branchId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty: 1 }],
    });
    await expectAppError(updateBranch(owner, branchId, { isActive: false }), 409, "BRANCH_HAS_STOCK");
  });

  it("is for settings.manage only, and audits a refused attempt", async () => {
    const { owner, branchId } = await shop("BranchPerm");
    const manager = await member(owner, "MANAGER");
    await expectAppError(createBranch(manager.ctx, { name: "X", code: "X" }), 403);
    await expectAppError(updateBranch(manager.ctx, branchId, { name: "Renamed" }), 403);
    expect(
      await db.auditEvent.count({
        where: { orgId: owner.orgId, actorUserId: manager.ctx.userId, action: "settings.permission.denied" },
      }),
    ).toBe(2);
  });
});

describe("my account", () => {
  it("changes the password with the current one and signs out the other sessions (O10)", async () => {
    const { owner, ownerEmail } = await shop("Account");
    const kept = await signIn(ownerEmail);
    const other = await signIn(ownerEmail);
    const keptSession = await getAuth().api.getSession({ headers: kept ?? new Headers() });

    await expectAppError(
      changeOwnPassword(
        owner,
        { currentPassword: "wrong one!", newPassword: "another password" },
        {
          keepSessionId: keptSession?.session.id ?? "",
        },
      ),
      422,
      "WRONG_PASSWORD",
    );
    await changeOwnPassword(
      owner,
      { currentPassword: PASSWORD, newPassword: "another password" },
      {
        keepSessionId: keptSession?.session.id ?? "",
      },
    );
    expect(await getAuth().api.getSession({ headers: kept ?? new Headers() })).not.toBeNull();
    expect(await getAuth().api.getSession({ headers: other ?? new Headers() })).toBeNull();
    expect(await signIn(ownerEmail, "another password")).not.toBeNull();
    expect(await db.auditEvent.count({ where: { orgId: owner.orgId, action: "account.password_changed" } })).toBe(1);
  });
});
