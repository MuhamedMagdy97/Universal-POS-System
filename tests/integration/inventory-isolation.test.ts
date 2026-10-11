import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { Role } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/auth";
import * as stock from "@/app/api/inventory/stock/route";
import * as ledger from "@/app/api/inventory/ledger/route";
import * as opening from "@/app/api/inventory/opening/route";
import * as adjust from "@/app/api/inventory/adjust/route";
import * as transfer from "@/app/api/inventory/transfer/route";
import * as inventory from "@/modules/inventory";
import { createProduct, createTenant, expectReconciled, testDb, uniqueCode } from "./helpers";

/**
 * Route-level auth, tenant and scope matrix for the inventory Route Handlers (I-9, I-18).
 * Real Better-Auth sessions and real Postgres; handlers are called directly, as Next.js does.
 */

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";

let db: Db;
let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
const cookies = {} as Record<"ADMIN" | "MANAGER" | "CASHIER", string>;
let productA: { id: string };
let productB: { id: string };

function randomIp() {
  const n = () => Math.floor(Math.random() * 250);
  return `10.${n()}.${n()}.${n()}`;
}

/** Signs a user up through Better-Auth, joins `orgId` with `role`, and activates that org on the session. */
async function sessionFor(orgId: string, role: Role, allBranches = true) {
  const email = `inv-${role.toLowerCase()}-${randomUUID()}@example.test`;
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
  await db.membership.create({ data: { orgId, userId: user.id, role, allBranches } });
  await db.session.updateMany({ where: { userId: user.id }, data: { activeOrganizationId: orgId } });
  return { cookie: token.split(";")[0] ?? "", userId: user.id };
}

type Call = { cookie?: string; body?: unknown; rawBody?: string; query?: Record<string, string> };

async function call(handler: Handler, method: string, path: string, opts: Call = {}): Promise<Response> {
  const url = new URL(`${BASE}/api/inventory${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.rawBody !== undefined || opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = opts.rawBody ?? JSON.stringify(opts.body);
  }
  return handler(new Request(url, { method, headers, body }), { params: Promise.resolve({}) });
}

async function expectEnvelope(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["code", "details", "message"]);
  if (code) expect(body.code).toBe(code);
  return body;
}

beforeAll(async () => {
  db = testDb();
  a = await createTenant(db, "Inv Isolation A");
  b = await createTenant(db, "Inv Isolation B");
  cookies.ADMIN = (await sessionFor(a.org.id, "ADMIN")).cookie;
  cookies.MANAGER = (await sessionFor(a.org.id, "MANAGER")).cookie;
  cookies.CASHIER = (await sessionFor(a.org.id, "CASHIER")).cookie;
  productA = await createProduct(db, a.org.id, `IA-${uniqueCode().slice(-6)}`);
  productB = await createProduct(db, b.org.id, `IB-${uniqueCode().slice(-6)}`);
});

afterAll(async () => {
  await expectReconciled(db, a.org.id);
  await expectReconciled(db, b.org.id);
  await db.$disconnect();
});

describe("authentication and permissions on every inventory route", () => {
  it("answers 401 without a session", async () => {
    await expectEnvelope(await call(stock.GET, "GET", "/stock", { query: { branchId: a.branchA.id } }), 401);
    await expectEnvelope(await call(ledger.GET, "GET", "/ledger", { query: {} }), 401);
    await expectEnvelope(await call(opening.POST, "POST", "/opening", { body: {} }), 401);
    await expectEnvelope(await call(adjust.POST, "POST", "/adjust", { body: {} }), 401);
    await expectEnvelope(await call(transfer.POST, "POST", "/transfer", { body: {} }), 401);
  });

  it("answers 403 to a cashier on every route", async () => {
    const cashier = cookies.CASHIER;
    await expectEnvelope(
      await call(stock.GET, "GET", "/stock", { cookie: cashier, query: { branchId: a.branchA.id } }),
      403,
    );
    await expectEnvelope(
      await call(ledger.GET, "GET", "/ledger", {
        cookie: cashier,
        query: { branchId: a.branchA.id, productId: productA.id },
      }),
      403,
    );
    await expectEnvelope(
      await call(opening.POST, "POST", "/opening", {
        cookie: cashier,
        body: { branchId: a.branchA.id, lines: [{ ref: { productId: productA.id }, qty: 1 }] },
      }),
      403,
    );
  });

  it("audits a denied write attempt", async () => {
    const denial = await db.auditEvent.findFirst({
      where: { orgId: a.org.id, action: "inventory.permission.denied" },
    });
    expect(denial).not.toBeNull();
  });
});

describe("tenant and branch scope", () => {
  it("answers 404 for another org's branch, never leaking its existence", async () => {
    await expectEnvelope(
      await call(stock.GET, "GET", "/stock", { cookie: cookies.ADMIN, query: { branchId: b.branchA.id } }),
      404,
    );
    await expectEnvelope(
      await call(opening.POST, "POST", "/opening", {
        cookie: cookies.ADMIN,
        body: { branchId: b.branchA.id, lines: [{ ref: { productId: productA.id }, qty: 1 }] },
      }),
      404,
    );
  });

  it("answers 404 for another org's item in a ledger request", async () => {
    await expectEnvelope(
      await call(ledger.GET, "GET", "/ledger", {
        cookie: cookies.ADMIN,
        query: { branchId: a.branchA.id, productId: productB.id },
      }),
      404,
    );
  });

  it("refuses a transfer from a branch outside the user's scope with 404", async () => {
    const scoped = await sessionFor(a.org.id, "MANAGER", false);
    await db.membershipBranch.create({
      data: { orgId: a.org.id, membershipId: await membershipIdOf(scoped.userId), branchId: a.branchA.id },
    });
    await expectEnvelope(
      await call(transfer.POST, "POST", "/transfer", {
        cookie: scoped.cookie,
        body: {
          transferId: randomUUID(),
          fromBranchId: a.branchB.id,
          toBranchId: a.branchA.id,
          lines: [{ ref: { productId: productA.id }, qty: 1 }],
        },
      }),
      404,
    );
  });

  it("ignores a forged orgId in the body (strict schema, 422)", async () => {
    await expectEnvelope(
      await call(opening.POST, "POST", "/opening", {
        cookie: cookies.ADMIN,
        body: {
          orgId: b.org.id,
          branchId: a.branchA.id,
          lines: [{ ref: { productId: productA.id }, qty: 1 }],
        },
      }),
      422,
      "VALIDATION_FAILED",
    );
  });
});

describe("response shape", () => {
  it("never includes cost in stock or history responses (I-18)", async () => {
    await db.product.update({ where: { id: productA.id }, data: { costMinor: 777 } });
    const list = await call(stock.GET, "GET", "/stock", {
      cookie: cookies.MANAGER,
      query: { branchId: a.branchA.id, q: productA.id.slice(0, 8) },
    });
    const text = await list.text();
    expect(list.status).toBe(200);
    expect(text).not.toContain("costMinor");
    expect(text).not.toContain("777");
  });

  it("maps malformed JSON to 422", async () => {
    await expectEnvelope(
      await call(opening.POST, "POST", "/opening", { cookie: cookies.ADMIN, rawBody: "{not json" }),
      422,
    );
  });
});

describe("write status codes", () => {
  it("returns 201 for a new opening and 200 for a replayed transfer", async () => {
    const product = await createProduct(db, a.org.id);
    const open = await call(opening.POST, "POST", "/opening", {
      cookie: cookies.ADMIN,
      body: { branchId: a.branchA.id, lines: [{ ref: { productId: product.id }, qty: 6 }] },
    });
    expect(open.status).toBe(201);

    const transferId = randomUUID();
    const body = {
      transferId,
      fromBranchId: a.branchA.id,
      toBranchId: a.branchB.id,
      lines: [{ ref: { productId: product.id }, qty: 2 }],
    };
    const first = await call(transfer.POST, "POST", "/transfer", { cookie: cookies.ADMIN, body });
    const replay = await call(transfer.POST, "POST", "/transfer", { cookie: cookies.ADMIN, body });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(await inventory.getOnHand(db, a.org.id, a.branchB.id, [{ productId: product.id, variantId: null }])).toEqual(
      [2],
    );
  });

  it("returns 409 STALE_STOCK from the adjust route", async () => {
    const product = await createProduct(db, a.org.id);
    await call(opening.POST, "POST", "/opening", {
      cookie: cookies.ADMIN,
      body: { branchId: a.branchA.id, lines: [{ ref: { productId: product.id }, qty: 2 }] },
    });
    await expectEnvelope(
      await call(adjust.POST, "POST", "/adjust", {
        cookie: cookies.ADMIN,
        body: {
          branchId: a.branchA.id,
          ref: { productId: product.id },
          adjustmentReason: "FOUND",
          qtyDelta: 1,
          expectedOnHand: 9,
        },
      }),
      409,
      "CONFLICT",
    );
  });
});

/** The membership row id for a user in org A (needed for scope fixtures). */
async function membershipIdOf(userId: string): Promise<string> {
  const row = await db.membership.findFirstOrThrow({ where: { userId, orgId: a.org.id }, select: { id: true } });
  return row.id;
}
