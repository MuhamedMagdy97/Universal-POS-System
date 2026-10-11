import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { Role } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/auth";
import * as sales from "@/app/api/sales/route";
import * as shifts from "@/app/api/shifts/open/route";
import * as close from "@/app/api/shifts/[shiftId]/close/route";
import * as movements from "@/app/api/shifts/[shiftId]/cash-movements/route";
import * as inventory from "@/modules/inventory";
import { createMember, createProduct, createTenant, expectReconciled, testDb } from "./helpers";

/**
 * Route-level auth, tenant isolation and idempotency for the checkout Route Handlers.
 * Real Better-Auth sessions and real Postgres; handlers are called directly, as Next.js does.
 */

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";

let db: Db;
let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
let cashierA: string;
let reportingA: string;
let productA: { id: string };
let productB: { id: string };

function randomIp() {
  const n = () => Math.floor(Math.random() * 250);
  return `10.${n()}.${n()}.${n()}`;
}

/** Signs a user up through Better-Auth, joins `orgId` with `role`, and activates that org on the session. */
async function sessionFor(orgId: string, role: Role) {
  const email = `sales-${role.toLowerCase()}-${randomUUID()}@example.test`;
  const response = await getAuth().handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": randomIp() },
      body: JSON.stringify({ email, password: PASSWORD, name: role }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed: ${response.status}`);
  const { user } = (await response.json()) as { user: { id: string } };
  const token = response.headers.getSetCookie().find((c) => c.includes("session_token="));
  if (!token) throw new Error("no session cookie returned");
  await db.membership.create({ data: { orgId, userId: user.id, role, allBranches: true } });
  await db.session.updateMany({ where: { userId: user.id }, data: { activeOrganizationId: orgId } });
  return token.split(";")[0] ?? "";
}

type Call = { cookie?: string; body?: unknown; key?: string };

async function call(handler: Handler, path: string, opts: Call = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const request = new Request(`${BASE}/api${path}`, { method: "POST", headers, body: JSON.stringify(opts.body ?? {}) });
  return handler(request, { params: Promise.resolve({}) });
}

async function expectEnvelope(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["code", "details", "message"]);
  if (code) expect(body.code).toBe(code);
  return body;
}

const saleBody = (productId: string, tenant = a) => ({
  branchId: tenant.branchA.id,
  registerId: tenant.register.id,
  lines: [{ ref: { productId }, qty: 1 }],
  payments: [{ method: "CASH", amountMinor: 1000 }],
});

beforeAll(async () => {
  db = testDb();
  a = await createTenant(db, "Sales Routes A");
  b = await createTenant(db, "Sales Routes B");
  cashierA = await sessionFor(a.org.id, "CASHIER");
  reportingA = await sessionFor(a.org.id, "REPORTING");
  productA = await createProduct(db, a.org.id);
  productB = await createProduct(db, b.org.id);
  const adminA = await createMember(db, a.org.id, "ADMIN");
  await inventory.recordOpeningBalances(adminA, {
    branchId: a.branchA.id,
    lines: [{ ref: { productId: productA.id, variantId: null }, qty: 10 }],
  });
});

afterAll(async () => {
  await expectReconciled(db, a.org.id);
  await db.$disconnect();
});

describe("checkout routes", () => {
  it("answer 401 without a session", async () => {
    await expectEnvelope(await call(sales.POST, "/sales", { body: saleBody(productA.id), key: "k-401" }), 401);
    await expectEnvelope(await call(shifts.POST, "/shifts/open", { body: {} }), 401);
  });

  it("answer 403 for a role without the permission", async () => {
    const shiftBody = { branchId: a.branchA.id, registerId: a.register.id, openingFloatMinor: 0 };
    await expectEnvelope(await call(shifts.POST, "/shifts/open", { cookie: reportingA, body: shiftBody }), 403);
    await expectEnvelope(
      await call(sales.POST, "/sales", { cookie: reportingA, body: saleBody(productA.id), key: "k-403" }),
      403,
    );
  });

  it("opens a shift (201) and refuses a second one (409)", async () => {
    const body = { branchId: a.branchA.id, registerId: a.register.id, openingFloatMinor: 0 };
    const opened = await call(shifts.POST, "/shifts/open", { cookie: cashierA, body });
    expect(opened.status).toBe(201);
    await expectEnvelope(await call(shifts.POST, "/shifts/open", { cookie: cashierA, body }), 409, "CONFLICT");
  });

  it("answers 422 when the Idempotency-Key header is missing", async () => {
    await expectEnvelope(
      await call(sales.POST, "/sales", { cookie: cashierA, body: saleBody(productA.id) }),
      422,
      "VALIDATION_FAILED",
    );
  });

  it("creates a sale (201), replays it (200), and refuses the key with another body (409)", async () => {
    const key = `route-${randomUUID()}`;
    const first = await call(sales.POST, "/sales", { cookie: cashierA, body: saleBody(productA.id), key });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const created = (await first.json()) as { id: string; totalMinor: number };
    expect(created.totalMinor).toBe(1000);
    expect(created).not.toHaveProperty("costMinor");

    const replay = await call(sales.POST, "/sales", { cookie: cashierA, body: saleBody(productA.id), key });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { id: string }).id).toBe(created.id);

    const other = { ...saleBody(productA.id), payments: [{ method: "CASH", amountMinor: 2000 }] };
    await expectEnvelope(
      await call(sales.POST, "/sales", { cookie: cashierA, body: other, key }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("answers 404 for another org's branch and register, or another org's product", async () => {
    await expectEnvelope(
      await call(sales.POST, "/sales", { cookie: cashierA, body: saleBody(productA.id, b), key: `x-${randomUUID()}` }),
      404,
    );
    await expectEnvelope(
      await call(sales.POST, "/sales", { cookie: cashierA, body: saleBody(productB.id), key: `x-${randomUUID()}` }),
      404,
    );
  });
});

describe("shift close routes", () => {
  /** A fresh register with an open shift in `tenant`, written directly so it never meets the checkout tests. */
  async function openShiftIn(tenant: typeof a, openingFloatMinor = 0) {
    const register = await db.register.create({
      data: { orgId: tenant.org.id, branchId: tenant.branchA.id, name: `Route Till ${randomUUID().slice(0, 8)}` },
    });
    const opener = await createMember(db, tenant.org.id, "CASHIER");
    const shift = await db.registerShift.create({
      data: {
        orgId: tenant.org.id,
        branchId: tenant.branchA.id,
        registerId: register.id,
        openedById: opener.userId,
        openingFloatMinor,
      },
    });
    return shift.id;
  }

  const closeAt = (shiftId: string, opts: Call) =>
    close.POST(
      new Request(`${BASE}/api/shifts/${shiftId}/close`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
        body: JSON.stringify(opts.body ?? {}),
      }),
      { params: Promise.resolve({ shiftId }) },
    );
  const moveAt = (shiftId: string, opts: Call) =>
    movements.POST(
      new Request(`${BASE}/api/shifts/${shiftId}/cash-movements`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
        body: JSON.stringify(opts.body ?? {}),
      }),
      { params: Promise.resolve({ shiftId }) },
    );

  it("answer 401 without a session and 403 without the permission", async () => {
    const shiftId = await openShiftIn(a);
    await expectEnvelope(await closeAt(shiftId, { body: { countedCashMinor: 0 } }), 401);
    await expectEnvelope(await moveAt(shiftId, { body: { type: "DROP", amountMinor: 1, reason: "x" } }), 401);
    await expectEnvelope(await closeAt(shiftId, { cookie: reportingA, body: { countedCashMinor: 0 } }), 403);
  });

  it("answer 404 for a malformed id, an unknown id and another org's shift", async () => {
    const otherOrgShift = await openShiftIn(b);
    for (const shiftId of ["not-a-uuid", randomUUID(), otherOrgShift]) {
      await expectEnvelope(await closeAt(shiftId, { cookie: cashierA, body: { countedCashMinor: 0 } }), 404);
      await expectEnvelope(
        await moveAt(shiftId, { cookie: cashierA, body: { type: "PAY_IN", amountMinor: 1, reason: "x" } }),
        404,
      );
    }
  });

  it("answer 422 for a bad body and for a difference without a note", async () => {
    const shiftId = await openShiftIn(a, 1000);
    await expectEnvelope(
      await closeAt(shiftId, { cookie: cashierA, body: { countedCashMinor: -1 } }),
      422,
      "VALIDATION_FAILED",
    );
    const body = await expectEnvelope(
      await closeAt(shiftId, { cookie: cashierA, body: { countedCashMinor: 900 } }),
      422,
      "VALIDATION_FAILED",
    );
    expect(body.details).toMatchObject({ reason: "DISCREPANCY_NOTE_REQUIRED" });
  });

  it("records a movement (201), closes (200), replays (200) and refuses a different close (409)", async () => {
    const shiftId = await openShiftIn(a, 1000);
    const moved = await moveAt(shiftId, {
      cookie: cashierA,
      body: { type: "PAY_IN", amountMinor: 500, reason: "Top-up" },
    });
    expect(moved.status).toBe(201);

    const closed = await closeAt(shiftId, { cookie: cashierA, body: { countedCashMinor: 1500 } });
    expect(closed.status).toBe(200);
    expect(closed.headers.get("cache-control")).toBe("no-store");
    expect(await closed.json()).toMatchObject({ status: "CLOSED", expectedCashMinor: 1500, discrepancyMinor: 0 });

    expect((await closeAt(shiftId, { cookie: cashierA, body: { countedCashMinor: 1500 } })).status).toBe(200);
    await expectEnvelope(
      await closeAt(shiftId, { cookie: cashierA, body: { countedCashMinor: 1400 } }),
      409,
      "CONFLICT",
    );
    await expectEnvelope(
      await moveAt(shiftId, { cookie: cashierA, body: { type: "DROP", amountMinor: 1, reason: "Late" } }),
      409,
      "CONFLICT",
    );
  });
});
