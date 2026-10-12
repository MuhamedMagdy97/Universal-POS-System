import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { Role } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/auth";
import * as suppliers from "@/app/api/purchasing/suppliers/route";
import * as supplier from "@/app/api/purchasing/suppliers/[supplierId]/route";
import * as archive from "@/app/api/purchasing/suppliers/[supplierId]/archive/route";
import * as pos from "@/app/api/purchasing/pos/route";
import * as po from "@/app/api/purchasing/pos/[poId]/route";
import * as order from "@/app/api/purchasing/pos/[poId]/order/route";
import * as cancel from "@/app/api/purchasing/pos/[poId]/cancel/route";
import * as receipts from "@/app/api/purchasing/pos/[poId]/receipts/route";
import { createProduct, createTenant, expectReconciled, testDb, uniqueCode } from "./helpers";

/**
 * Route-level auth, status codes, tenant isolation and idempotency for the purchasing Route Handlers.
 * Real Better-Auth sessions and real Postgres; handlers are called directly, as Next.js does.
 */

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";

let db: Db;
let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
let adminA: string;
let managerA: string;
let cashierA: string;
let adminB: string;

function randomIp() {
  const n = () => Math.floor(Math.random() * 250);
  return `10.${n()}.${n()}.${n()}`;
}

async function sessionFor(orgId: string, role: Role) {
  const email = `purchasing-${role.toLowerCase()}-${randomUUID()}@example.test`;
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

type Call = {
  method?: "GET" | "POST" | "PATCH";
  cookie?: string;
  body?: unknown;
  rawBody?: string;
  key?: string;
  params?: Record<string, string>;
};

async function call(handler: Handler, path: string, opts: Call = {}): Promise<Response> {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const body = method === "GET" ? undefined : (opts.rawBody ?? JSON.stringify(opts.body ?? {}));
  const request = new Request(`${BASE}/api/purchasing${path}`, { method, headers, body });
  return handler(request, { params: Promise.resolve(opts.params ?? {}) });
}

async function expectEnvelope(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["code", "details", "message"]);
  if (code) expect(body.code).toBe(code);
  return body;
}

async function ok<T>(response: Response, status: number): Promise<T> {
  if (response.status !== status)
    throw new Error(`expected ${status}, got ${response.status}: ${await response.text()}`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as T;
}

type PoBody = { id: string; status: string; lines: { id: string; qtyReceived: number }[] };

/** Creates a supplier and an ordered PO for one product through the routes. */
async function orderedPo(qty = 5) {
  const product = await createProduct(db, a.org.id);
  const s = await ok<{ id: string }>(
    await call(suppliers.POST, "/suppliers", { cookie: adminA, body: { name: `Supplier ${uniqueCode()}` } }),
    201,
  );
  const draft = await ok<PoBody>(
    await call(pos.POST, "/pos", {
      cookie: adminA,
      body: {
        branchId: a.branchA.id,
        supplierId: s.id,
        lines: [{ ref: { productId: product.id }, qty, unitCostMinor: 250 }],
      },
    }),
    201,
  );
  const ordered = await ok<PoBody>(
    await call(order.POST, "/order", { cookie: adminA, params: { poId: draft.id } }),
    200,
  );
  return { product, supplierId: s.id, po: ordered };
}

beforeAll(async () => {
  db = testDb();
  a = await createTenant(db, "Purchasing Routes A");
  b = await createTenant(db, "Purchasing Routes B");
  adminA = await sessionFor(a.org.id, "ADMIN");
  managerA = await sessionFor(a.org.id, "MANAGER");
  cashierA = await sessionFor(a.org.id, "CASHIER");
  adminB = await sessionFor(b.org.id, "ADMIN");
});

afterAll(async () => {
  await expectReconciled(db, a.org.id);
  await db.$disconnect();
});

describe("purchasing routes", () => {
  it("answer 401 without a session and 403 for a cashier", async () => {
    await expectEnvelope(await call(suppliers.GET, "/suppliers", { method: "GET" }), 401);
    await expectEnvelope(await call(pos.GET, "/pos", { method: "GET", cookie: cashierA }), 403);
    await expectEnvelope(await call(suppliers.POST, "/suppliers", { cookie: managerA, body: { name: "x" } }), 403);
  });

  it("validate bodies and query strings (422) and refuse a duplicate supplier (409)", async () => {
    await expectEnvelope(await call(suppliers.POST, "/suppliers", { cookie: adminA, rawBody: "{" }), 422);
    await expectEnvelope(await call(suppliers.POST, "/suppliers", { cookie: adminA, body: { name: "" } }), 422);
    const r = new Request(`${BASE}/api/purchasing/pos?status=bogus`, { headers: { cookie: adminA } });
    await expectEnvelope(await pos.GET(r, { params: Promise.resolve({}) }), 422);
    const name = `Dup ${uniqueCode()}`;
    await ok(await call(suppliers.POST, "/suppliers", { cookie: adminA, body: { name } }), 201);
    const body = await expectEnvelope(
      await call(suppliers.POST, "/suppliers", { cookie: adminA, body: { name } }),
      409,
    );
    expect(body.details).toMatchObject({ reason: "SUPPLIER_NAME_TAKEN" });
  });

  it("edit and archive a supplier", async () => {
    const s = await ok<{ id: string }>(
      await call(suppliers.POST, "/suppliers", { cookie: adminA, body: { name: `Edit ${uniqueCode()}` } }),
      201,
    );
    const edited = await ok<{ phone: string }>(
      await call(supplier.PATCH, "/suppliers/x", {
        method: "PATCH",
        cookie: adminA,
        body: { phone: "0123" },
        params: { supplierId: s.id },
      }),
      200,
    );
    expect(edited.phone).toBe("0123");
    const archived = await ok<{ isActive: boolean }>(
      await call(archive.POST, "/archive", { cookie: adminA, params: { supplierId: s.id } }),
      200,
    );
    expect(archived.isActive).toBe(false);
  });

  it("receive with an Idempotency-Key: 201, replay 200, other body 409, missing key 422", async () => {
    const { po: ordered } = await orderedPo(5);
    const poItemId = ordered.lines[0].id;
    const params = { poId: ordered.id };
    await expectEnvelope(
      await call(receipts.POST, "/receipts", { cookie: managerA, params, body: { lines: [{ poItemId, qty: 2 }] } }),
      422,
    );
    const key = `k-${uniqueCode()}`;
    const first = await ok<{ receiptId: string; purchaseOrder: PoBody }>(
      await call(receipts.POST, "/receipts", {
        cookie: managerA,
        params,
        key,
        body: { lines: [{ poItemId, qty: 2 }] },
      }),
      201,
    );
    expect(first.purchaseOrder.status).toBe("PARTIALLY_RECEIVED");
    const replay = await ok<{ receiptId: string }>(
      await call(receipts.POST, "/receipts", {
        cookie: managerA,
        params,
        key,
        body: { lines: [{ poItemId, qty: 2 }] },
      }),
      200,
    );
    expect(replay.receiptId).toBe(first.receiptId);
    await expectEnvelope(
      await call(receipts.POST, "/receipts", {
        cookie: managerA,
        params,
        key,
        body: { lines: [{ poItemId, qty: 1 }] },
      }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    const over = await expectEnvelope(
      await call(receipts.POST, "/receipts", {
        cookie: managerA,
        params,
        key: `k-${uniqueCode()}`,
        body: { lines: [{ poItemId, qty: 4 }] },
      }),
      409,
    );
    expect(over.details).toMatchObject({ reason: "QTY_EXCEEDS_OUTSTANDING", outstanding: 3 });
    // Frozen after the first receipt.
    const patch = await expectEnvelope(
      await call(po.PATCH, "/pos/x", { method: "PATCH", cookie: adminA, params, body: { note: "late" } }),
      409,
    );
    expect(patch.details).toMatchObject({ reason: "PO_NOT_EDITABLE" });
    await expectEnvelope(await call(cancel.POST, "/cancel", { cookie: adminA, params, body: {} }), 409);
  });

  it("read a PO and list open POs; another org gets 404", async () => {
    const { po: ordered } = await orderedPo(1);
    const read = await ok<PoBody>(
      await call(po.GET, "/pos/x", { method: "GET", cookie: managerA, params: { poId: ordered.id } }),
      200,
    );
    expect(read.id).toBe(ordered.id);
    const page = await ok<{ rows: { id: string }[] }>(
      await call(pos.GET, "/pos", { method: "GET", cookie: managerA }),
      200,
    );
    expect(page.rows.map((row) => row.id)).toContain(ordered.id);
    await expectEnvelope(
      await call(po.GET, "/pos/x", { method: "GET", cookie: adminB, params: { poId: ordered.id } }),
      404,
    );
    await expectEnvelope(
      await call(receipts.POST, "/receipts", {
        cookie: adminB,
        params: { poId: ordered.id },
        key: `k-${uniqueCode()}`,
        body: { lines: [{ poItemId: ordered.lines[0].id, qty: 1 }] },
      }),
      404,
    );
  });
});
