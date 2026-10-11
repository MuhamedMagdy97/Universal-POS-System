import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { Role } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/auth";
import * as sales from "@/app/api/sales/route";
import * as shifts from "@/app/api/shifts/open/route";
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
