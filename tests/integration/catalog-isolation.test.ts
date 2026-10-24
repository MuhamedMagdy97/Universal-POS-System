import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { Role } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/auth";
import * as products from "@/app/api/products/route";
import * as product from "@/app/api/products/[productId]/route";
import * as productArchive from "@/app/api/products/[productId]/archive/route";
import * as productRestore from "@/app/api/products/[productId]/restore/route";
import * as variants from "@/app/api/products/[productId]/variants/route";
import * as variant from "@/app/api/products/[productId]/variants/[variantId]/route";
import * as variantArchive from "@/app/api/products/[productId]/variants/[variantId]/archive/route";
import * as variantRestore from "@/app/api/products/[productId]/variants/[variantId]/restore/route";
import * as categories from "@/app/api/categories/route";
import * as category from "@/app/api/categories/[categoryId]/route";
import * as categoryArchive from "@/app/api/categories/[categoryId]/archive/route";
import * as categoryRestore from "@/app/api/categories/[categoryId]/restore/route";
import * as barcodes from "@/app/api/barcodes/route";
import * as barcode from "@/app/api/barcodes/[barcodeId]/route";
import * as search from "@/app/api/catalog/search/route";
import { createCategory, createProduct, createTenant, createVariant, shortUpper, testDb, uniqueCode } from "./helpers";

/**
 * Route-level auth/isolation matrix for every catalog Route Handler (C-8…C-16).
 * Real Better-Auth sessions (sign-up → cookie) + real Postgres; handlers are
 * invoked directly, as Next.js would call them after `proxy.ts`.
 */

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const BASE = "http://localhost:3000";
const PASSWORD = "correct horse battery";

let db: Db;
let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;
const cookies = {} as Record<"ADMIN" | "MANAGER" | "CASHIER" | "REPORTING", string>;
let managerUserId: string;

// Org B fixtures (must never change or leak).
let bProduct: { id: string; sku: string; updatedAt: Date };
let bVariantProduct: { id: string };
let bVariant: { id: string; sku: string; updatedAt: Date };
let bCategory: { id: string; updatedAt: Date };
let bBarcode: { id: string; code: string };

// Org A fixtures.
let aProduct: { id: string; sku: string };
let aVariantProduct: { id: string; sku: string };
let aCategory: { id: string };
let aCode: string;

function randomIp() {
  const n = () => Math.floor(Math.random() * 250);
  return `10.${n()}.${n()}.${n()}`;
}

/** Signs a new user up through Better-Auth, joins `orgId` with `role`, and activates that org on the session. */
async function sessionFor(orgId: string, role: Role): Promise<{ cookie: string; userId: string }> {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.test`;
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
  return { cookie: token.split(";")[0] ?? "", userId: user.id };
}

type Call = { cookie?: string; body?: unknown; rawBody?: string; query?: Record<string, string> };

async function call(
  handler: Handler,
  method: string,
  path: string,
  params: Record<string, string> = {},
  opts: Call = {},
): Promise<Response> {
  const url = new URL(`${BASE}/api${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined;
  if (opts.rawBody !== undefined || opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = opts.rawBody ?? JSON.stringify(opts.body);
  }
  return handler(new Request(url, { method, headers, body }), { params: Promise.resolve(params) });
}

async function expectEnvelope(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["code", "details", "message"]);
  expect(typeof body.message).toBe("string");
  if (code) expect(body.code).toBe(code);
  return body;
}

async function ok<T = unknown>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return JSON.parse(text) as T;
}

const archiveBody = (updatedAt: Date | string) => ({
  expectedUpdatedAt: typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString(),
});

/** Every catalog route, with Org B ids in the path and a plausible body. */
function routes() {
  const pid = { productId: bProduct.id };
  const vid = { productId: bVariantProduct.id, variantId: bVariant.id };
  const cid = { categoryId: bCategory.id };
  return [
    { name: "GET products", h: products.GET, m: "GET", p: "/products", params: {}, query: { q: "x" } },
    {
      name: "POST products",
      h: products.POST,
      m: "POST",
      p: "/products",
      params: {},
      body: { sku: "X", name: "X", priceMinor: 1 },
    },
    { name: "GET product", h: product.GET, m: "GET", p: "/products/id", params: pid },
    {
      name: "PATCH product",
      h: product.PATCH,
      m: "PATCH",
      p: "/products/id",
      params: pid,
      body: { name: "Hacked", ...archiveBody(bProduct.updatedAt) },
    },
    {
      name: "archive product",
      h: productArchive.POST,
      m: "POST",
      p: "/products/id/archive",
      params: pid,
      body: archiveBody(bProduct.updatedAt),
    },
    {
      name: "restore product",
      h: productRestore.POST,
      m: "POST",
      p: "/products/id/restore",
      params: pid,
      body: archiveBody(bProduct.updatedAt),
    },
    {
      name: "POST variant",
      h: variants.POST,
      m: "POST",
      p: "/products/id/variants",
      params: pid,
      body: { sku: `V-${shortUpper()}`, name: "V" },
    },
    {
      name: "PATCH variant",
      h: variant.PATCH,
      m: "PATCH",
      p: "/products/id/variants/id",
      params: vid,
      body: { name: "Hacked", ...archiveBody(bVariant.updatedAt) },
    },
    {
      name: "archive variant",
      h: variantArchive.POST,
      m: "POST",
      p: "/products/id/variants/id/archive",
      params: vid,
      body: archiveBody(bVariant.updatedAt),
    },
    {
      name: "restore variant",
      h: variantRestore.POST,
      m: "POST",
      p: "/products/id/variants/id/restore",
      params: vid,
      body: archiveBody(bVariant.updatedAt),
    },
    { name: "GET categories", h: categories.GET, m: "GET", p: "/categories", params: {} },
    { name: "POST categories", h: categories.POST, m: "POST", p: "/categories", params: {}, body: { name: "X" } },
    {
      name: "PATCH category",
      h: category.PATCH,
      m: "PATCH",
      p: "/categories/id",
      params: cid,
      body: { name: "Hacked", ...archiveBody(bCategory.updatedAt) },
    },
    {
      name: "archive category",
      h: categoryArchive.POST,
      m: "POST",
      p: "/categories/id/archive",
      params: cid,
      body: archiveBody(bCategory.updatedAt),
    },
    {
      name: "restore category",
      h: categoryRestore.POST,
      m: "POST",
      p: "/categories/id/restore",
      params: cid,
      body: archiveBody(bCategory.updatedAt),
    },
    {
      name: "GET barcodes (lookup)",
      h: barcodes.GET,
      m: "GET",
      p: "/barcodes",
      params: {},
      query: { code: bBarcode.code },
    },
    {
      name: "POST barcodes",
      h: barcodes.POST,
      m: "POST",
      p: "/barcodes",
      params: {},
      body: { code: uniqueCode(), productId: bProduct.id },
    },
    { name: "DELETE barcode", h: barcode.DELETE, m: "DELETE", p: "/barcodes/id", params: { barcodeId: bBarcode.id } },
    { name: "GET catalog search", h: search.GET, m: "GET", p: "/catalog/search", params: {}, query: { q: "x" } },
  ] as Array<{
    name: string;
    h: Handler;
    m: string;
    p: string;
    params: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
  }>;
}

beforeAll(async () => {
  db = testDb();
  a = await createTenant(db, "Catalog API A");
  b = await createTenant(db, "Catalog API B");

  cookies.ADMIN = (await sessionFor(a.org.id, "ADMIN")).cookie;
  const manager = await sessionFor(a.org.id, "MANAGER");
  cookies.MANAGER = manager.cookie;
  managerUserId = manager.userId;
  cookies.CASHIER = (await sessionFor(a.org.id, "CASHIER")).cookie;
  cookies.REPORTING = (await sessionFor(a.org.id, "REPORTING")).cookie;

  bCategory = await createCategory(db, b.org.id);
  bProduct = await createProduct(db, b.org.id);
  bVariantProduct = await createProduct(db, b.org.id);
  bVariant = await createVariant(db, b.org.id, bVariantProduct.id);
  bBarcode = await db.barcode.create({ data: { orgId: b.org.id, code: uniqueCode(), productId: bProduct.id } });

  aCategory = await createCategory(db, a.org.id);
  aProduct = await db.product.create({
    data: { orgId: a.org.id, sku: `A-${shortUpper()}`, name: "Alpha tea", priceMinor: 1000, costMinor: 400 },
  });
  aVariantProduct = await db.product.create({
    data: { orgId: a.org.id, sku: `AV-${shortUpper()}`, name: "Alpha shirt", priceMinor: 2000, costMinor: 900 },
  });
  await createVariant(db, a.org.id, aVariantProduct.id);
  aCode = uniqueCode();
  await db.barcode.create({ data: { orgId: a.org.id, code: aCode, productId: aProduct.id } });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("catalog routes: authentication (C-16)", () => {
  it("answers 401 with the error envelope and no-store on every route without a session", async () => {
    for (const r of routes()) {
      const response = await call(r.h, r.m, r.p, r.params, { body: r.body, query: r.query });
      await expectEnvelope(response, 401, "UNAUTHENTICATED");
    }
  });

  it("answers 401 for a forged / unknown session cookie", async () => {
    const response = await call(
      products.GET,
      "GET",
      "/products",
      {},
      { cookie: "better-auth.session_token=forged.sig" },
    );
    await expectEnvelope(response, 401, "UNAUTHENTICATED");
  });
});

describe("catalog routes: tenant isolation (C-8, C-10, C-11)", () => {
  it("answers 404 (never 403/200) when Org A addresses any Org B record", async () => {
    const byId = routes().filter((r) => Object.keys(r.params).length > 0 || r.name === "POST barcodes");
    expect(byId.length).toBe(13);
    for (const r of byId) {
      const response = await call(r.h, r.m, r.p, r.params, { cookie: cookies.ADMIN, body: r.body });
      const body = await expectEnvelope(response, 404, "NOT_FOUND");
      expect(JSON.stringify(body), r.name).not.toContain(b.org.id);
    }
    const lookup = await call(
      barcodes.GET,
      "GET",
      "/barcodes",
      {},
      { cookie: cookies.ADMIN, query: { code: bBarcode.code } },
    );
    const lookupBody = await expectEnvelope(lookup, 404, "NOT_FOUND");
    expect(lookupBody.details).toEqual({ reason: "UNKNOWN_CODE" });
  });

  it("leaves every Org B record untouched", async () => {
    const p = await db.product.findUniqueOrThrow({ where: { id: bProduct.id } });
    expect(p).toMatchObject({ name: `Product ${bProduct.sku}`, isActive: true });
    expect(p.updatedAt.getTime()).toBe(bProduct.updatedAt.getTime());
    const v = await db.productVariant.findUniqueOrThrow({ where: { id: bVariant.id } });
    expect(v.isActive).toBe(true);
    expect(v.updatedAt.getTime()).toBe(bVariant.updatedAt.getTime());
    expect(await db.productVariant.count({ where: { productId: bProduct.id } })).toBe(0);
    const c = await db.category.findUniqueOrThrow({ where: { id: bCategory.id } });
    expect(c.updatedAt.getTime()).toBe(bCategory.updatedAt.getTime());
    expect(await db.barcode.count({ where: { productId: bProduct.id } })).toBe(1);
    expect(await db.barcode.findUnique({ where: { id: bBarcode.id } })).not.toBeNull();
  });

  it("treats malformed ids in the path as 404, not 422/500", async () => {
    const bad = "not-a-uuid";
    const cases: Array<[Handler, string, Record<string, string>, unknown]> = [
      [product.GET, "GET", { productId: bad }, undefined],
      [product.PATCH, "PATCH", { productId: bad }, { name: "X", ...archiveBody(new Date()) }],
      [productArchive.POST, "POST", { productId: bad }, archiveBody(new Date())],
      [variants.POST, "POST", { productId: bad }, { sku: "V-X", name: "V" }],
      [
        variant.PATCH,
        "PATCH",
        { productId: aVariantProduct.id, variantId: "'; DROP TABLE x;--" },
        { name: "X", ...archiveBody(new Date()) },
      ],
      [category.PATCH, "PATCH", { categoryId: bad }, { name: "X", ...archiveBody(new Date()) }],
      [categoryRestore.POST, "POST", { categoryId: bad }, archiveBody(new Date())],
      [barcode.DELETE, "DELETE", { barcodeId: bad }, undefined],
    ];
    for (const [h, m, params, body] of cases) {
      await expectEnvelope(await call(h, m, "/x", params, { cookie: cookies.ADMIN, body }), 404, "NOT_FOUND");
    }
  });

  it("never returns Org B items from list, categories or POS search", async () => {
    const list = await ok<{ items: Array<{ id: string }> }>(
      await call(
        products.GET,
        "GET",
        "/products",
        {},
        { cookie: cookies.ADMIN, query: { q: bProduct.sku, status: "all" } },
      ),
    );
    expect(list.items).toEqual([]);
    const byBarcode = await ok<{ items: unknown[] }>(
      await call(products.GET, "GET", "/products", {}, { cookie: cookies.ADMIN, query: { q: bBarcode.code } }),
    );
    expect(byBarcode.items).toEqual([]);
    const found = await ok<unknown[]>(
      await call(search.GET, "GET", "/catalog/search", {}, { cookie: cookies.ADMIN, query: { q: bProduct.sku } }),
    );
    expect(found).toEqual([]);
    const tree = await ok<unknown[]>(
      await call(categories.GET, "GET", "/categories", {}, { cookie: cookies.ADMIN, query: { status: "all" } }),
    );
    expect(JSON.stringify(tree)).not.toContain(bCategory.id);
  });

  it("rejects a foreign categoryId on create and update, writing nothing (C-11)", async () => {
    const sku = `FC-${shortUpper()}`;
    const create = await call(
      products.POST,
      "POST",
      "/products",
      {},
      {
        cookie: cookies.ADMIN,
        body: { sku, name: "Foreign cat", priceMinor: 100, categoryId: bCategory.id },
      },
    );
    expect([404, 422]).toContain(create.status);
    await expectEnvelope(create, create.status);
    expect(await db.product.count({ where: { orgId: a.org.id, sku } })).toBe(0);

    const current = await db.product.findUniqueOrThrow({ where: { id: aProduct.id } });
    const patch = await call(
      product.PATCH,
      "PATCH",
      "/products/id",
      { productId: aProduct.id },
      {
        cookie: cookies.ADMIN,
        body: { categoryId: bCategory.id, ...archiveBody(current.updatedAt) },
      },
    );
    expect([404, 422]).toContain(patch.status);
    const after = await db.product.findUniqueOrThrow({ where: { id: aProduct.id } });
    expect(after.categoryId).toBe(current.categoryId);
    expect(after.updatedAt.getTime()).toBe(current.updatedAt.getTime());

    const sub = await call(
      categories.POST,
      "POST",
      "/categories",
      {},
      {
        cookie: cookies.ADMIN,
        body: { name: `Sub ${shortUpper()}`, parentId: bCategory.id },
      },
    );
    expect([404, 422]).toContain(sub.status);
    expect(await db.category.count({ where: { parentId: bCategory.id } })).toBe(0);
  });
});

describe("catalog routes: forged tenant fields (C-12)", () => {
  it("rejects a body carrying orgId with 422 and writes nothing", async () => {
    const sku = `FORGE-${shortUpper()}`;
    const response = await call(
      products.POST,
      "POST",
      "/products",
      {},
      {
        cookie: cookies.ADMIN,
        body: { sku, name: "Forged", priceMinor: 100, orgId: b.org.id },
      },
    );
    const body = await expectEnvelope(response, 422, "VALIDATION_FAILED");
    expect(JSON.stringify(body.details)).toContain("orgId");
    expect(await db.product.count({ where: { sku } })).toBe(0);

    const cat = await call(
      categories.POST,
      "POST",
      "/categories",
      {},
      {
        cookie: cookies.ADMIN,
        body: { name: "Forged", orgId: b.org.id },
      },
    );
    await expectEnvelope(cat, 422, "VALIDATION_FAILED");
    const bc = await call(
      barcodes.POST,
      "POST",
      "/barcodes",
      {},
      {
        cookie: cookies.ADMIN,
        body: { code: uniqueCode(), productId: aProduct.id, orgId: b.org.id },
      },
    );
    await expectEnvelope(bc, 422, "VALIDATION_FAILED");
  });

  it("rejects unknown query parameters and malformed JSON with 422", async () => {
    await expectEnvelope(
      await call(products.GET, "GET", "/products", {}, { cookie: cookies.ADMIN, query: { orgId: b.org.id } }),
      422,
      "VALIDATION_FAILED",
    );
    await expectEnvelope(
      await call(products.GET, "GET", "/products", {}, { cookie: cookies.ADMIN, query: { limit: "500" } }),
      422,
      "VALIDATION_FAILED",
    );
    await expectEnvelope(
      await call(categories.GET, "GET", "/categories", {}, { cookie: cookies.ADMIN, query: { orgId: b.org.id } }),
      422,
      "VALIDATION_FAILED",
    );
    await expectEnvelope(
      await call(
        search.GET,
        "GET",
        "/catalog/search",
        {},
        { cookie: cookies.ADMIN, query: { q: "x", orgId: b.org.id } },
      ),
      422,
      "VALIDATION_FAILED",
    );
    // Browse mode for the till tiles (business-profiles-spec BP8) is strict too.
    await expectEnvelope(
      await call(
        search.GET,
        "GET",
        "/catalog/search",
        {},
        { cookie: cookies.ADMIN, query: { all: "1", orgId: b.org.id } },
      ),
      422,
      "VALIDATION_FAILED",
    );
    await expectEnvelope(
      await call(barcodes.GET, "GET", "/barcodes", {}, { cookie: cookies.ADMIN }),
      422,
      "VALIDATION_FAILED",
    );
    await expectEnvelope(
      await call(products.POST, "POST", "/products", {}, { cookie: cookies.ADMIN, rawBody: "{not json" }),
      422,
      "VALIDATION_FAILED",
    );
  });
});

describe("catalog routes: permissions (C-13, C-14, C-15)", () => {
  it("denies Reporting every catalog route, reads included (403)", async () => {
    for (const r of routes()) {
      const response = await call(r.h, r.m, r.p, r.params, { cookie: cookies.REPORTING, body: r.body, query: r.query });
      await expectEnvelope(response, 403, "FORBIDDEN");
    }
  });

  it.each(["CASHIER", "MANAGER"] as const)("lets %s read, look up and search but not write", async (role) => {
    const cookie = cookies[role];
    await ok(await call(products.GET, "GET", "/products", {}, { cookie }));
    await ok(await call(product.GET, "GET", "/products/id", { productId: aProduct.id }, { cookie }));
    await ok(await call(categories.GET, "GET", "/categories", {}, { cookie }));
    const lookup = await ok<{ productId: string; sellable: boolean }>(
      await call(barcodes.GET, "GET", "/barcodes", {}, { cookie, query: { code: aCode } }),
    );
    expect(lookup).toMatchObject({ productId: aProduct.id, sellable: true });
    const hits = await ok<Array<{ productId: string }>>(
      await call(search.GET, "GET", "/catalog/search", {}, { cookie, query: { q: aProduct.sku } }),
    );
    expect(hits.map((h) => h.productId)).toContain(aProduct.id);

    // Writes on the caller's own org records: always 403, whatever the body.
    const own = await db.product.findUniqueOrThrow({ where: { id: aProduct.id } });
    const ownCategory = await db.category.findUniqueOrThrow({ where: { id: aCategory.id } });
    const v = await db.productVariant.findFirstOrThrow({ where: { productId: aVariantProduct.id } });
    const barcodeRow = await db.barcode.findFirstOrThrow({ where: { code: aCode } });
    const writes: Array<[Handler, string, Record<string, string>, unknown]> = [
      [products.POST, "POST", {}, { sku: `NO-${shortUpper()}`, name: "No", priceMinor: 1 }],
      [products.POST, "POST", {}, {}],
      [product.PATCH, "PATCH", { productId: own.id }, { priceMinor: 1, ...archiveBody(own.updatedAt) }],
      [productArchive.POST, "POST", { productId: own.id }, archiveBody(own.updatedAt)],
      [productRestore.POST, "POST", { productId: own.id }, archiveBody(own.updatedAt)],
      [variants.POST, "POST", { productId: own.id }, { sku: `NV-${shortUpper()}`, name: "No" }],
      [
        variant.PATCH,
        "PATCH",
        { productId: aVariantProduct.id, variantId: v.id },
        { name: "No", ...archiveBody(v.updatedAt) },
      ],
      [variantArchive.POST, "POST", { productId: aVariantProduct.id, variantId: v.id }, archiveBody(v.updatedAt)],
      [variantRestore.POST, "POST", { productId: aVariantProduct.id, variantId: v.id }, archiveBody(v.updatedAt)],
      [categories.POST, "POST", {}, { name: "No" }],
      [category.PATCH, "PATCH", { categoryId: ownCategory.id }, { name: "No", ...archiveBody(ownCategory.updatedAt) }],
      [categoryArchive.POST, "POST", { categoryId: ownCategory.id }, archiveBody(ownCategory.updatedAt)],
      [categoryRestore.POST, "POST", { categoryId: ownCategory.id }, archiveBody(ownCategory.updatedAt)],
      [barcodes.POST, "POST", {}, { code: uniqueCode(), productId: own.id }],
      [barcode.DELETE, "DELETE", { barcodeId: barcodeRow.id }, undefined],
    ];
    for (const [h, m, params, body] of writes) {
      await expectEnvelope(await call(h, m, "/x", params, { cookie, body }), 403, "FORBIDDEN");
    }

    const after = await db.product.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.updatedAt.getTime()).toBe(own.updatedAt.getTime());
    expect(after.priceMinor).toBe(own.priceMinor);
    expect(await db.barcode.findUnique({ where: { id: barcodeRow.id } })).not.toBeNull();
    expect(await db.productVariant.count({ where: { productId: own.id } })).toBe(0);
  });

  it("audit-logs a Manager's denied write attempts (C-14)", async () => {
    const denied = await db.auditEvent.findMany({
      where: { orgId: a.org.id, actorUserId: managerUserId, action: "catalog.permission.denied" },
    });
    expect(denied.length).toBeGreaterThanOrEqual(15);
  });
});

describe("catalog routes: cost visibility", () => {
  it("never sends costMinor to a Cashier or Manager", async () => {
    for (const cookie of [cookies.CASHIER, cookies.MANAGER]) {
      const responses = [
        await call(products.GET, "GET", "/products", {}, { cookie, query: { status: "all" } }),
        await call(product.GET, "GET", "/products/id", { productId: aProduct.id }, { cookie }),
        await call(product.GET, "GET", "/products/id", { productId: aVariantProduct.id }, { cookie }),
        await call(barcodes.GET, "GET", "/barcodes", {}, { cookie, query: { code: aCode } }),
        await call(search.GET, "GET", "/catalog/search", {}, { cookie, query: { q: "Alpha" } }),
      ];
      for (const response of responses) {
        const text = await response.text();
        expect(response.status, text).toBe(200);
        expect(text).not.toContain("costMinor");
      }
    }
  });

  it("does send costMinor to an Admin", async () => {
    const detail = await ok<{ costMinor?: number }>(
      await call(product.GET, "GET", "/products/id", { productId: aProduct.id }, { cookie: cookies.ADMIN }),
    );
    expect(detail.costMinor).toBe(400);
  });
});

describe("catalog routes: happy path status codes", () => {
  it("creates (201), updates, archives/restores (200) and deletes barcodes (204)", async () => {
    const cookie = cookies.ADMIN;
    const cat = await ok<{ id: string; updatedAt: string }>(
      await call(categories.POST, "POST", "/categories", {}, { cookie, body: { name: `Cat ${shortUpper()}` } }),
      201,
    );
    const sku = `HP-${shortUpper()}`;
    const created = await ok<{ id: string; updatedAt: string; categoryId: string; costMinor: number }>(
      await call(
        products.POST,
        "POST",
        "/products",
        {},
        {
          cookie,
          body: { sku, name: "Happy", priceMinor: 1500, costMinor: 500, categoryId: cat.id },
        },
      ),
      201,
    );
    expect(created).toMatchObject({ categoryId: cat.id, costMinor: 500 });

    const patched = await ok<{ name: string; updatedAt: string }>(
      await call(
        product.PATCH,
        "PATCH",
        "/products/id",
        { productId: created.id },
        {
          cookie,
          body: { name: "Happier", expectedUpdatedAt: created.updatedAt },
        },
      ),
    );
    expect(patched.name).toBe("Happier");
    const stale = await call(
      product.PATCH,
      "PATCH",
      "/products/id",
      { productId: created.id },
      {
        cookie,
        body: { name: "Stale", expectedUpdatedAt: created.updatedAt },
      },
    );
    expect((await expectEnvelope(stale, 409, "CONFLICT")).details).toMatchObject({ reason: "STALE_WRITE" });

    const archived = await ok<{ isActive: boolean; updatedAt: string }>(
      await call(
        productArchive.POST,
        "POST",
        "/products/id/archive",
        { productId: created.id },
        {
          cookie,
          body: { expectedUpdatedAt: patched.updatedAt },
        },
      ),
    );
    expect(archived.isActive).toBe(false);
    const restored = await ok<{ isActive: boolean }>(
      await call(
        productRestore.POST,
        "POST",
        "/products/id/restore",
        { productId: created.id },
        {
          cookie,
          body: { expectedUpdatedAt: archived.updatedAt },
        },
      ),
    );
    expect(restored.isActive).toBe(true);

    const v = await ok<{ id: string; updatedAt: string }>(
      await call(
        variants.POST,
        "POST",
        "/products/id/variants",
        { productId: created.id },
        {
          cookie,
          body: { sku: `${sku}-S`, name: "Small" },
        },
      ),
      201,
    );
    const vPatched = await ok<{ updatedAt: string; priceMinor: number | null }>(
      await call(
        variant.PATCH,
        "PATCH",
        "/products/id/variants/id",
        { productId: created.id, variantId: v.id },
        {
          cookie,
          body: { priceMinor: 1700, expectedUpdatedAt: v.updatedAt },
        },
      ),
    );
    expect(vPatched.priceMinor).toBe(1700);
    const vArchived = await ok<{ isActive: boolean; updatedAt: string }>(
      await call(
        variantArchive.POST,
        "POST",
        "/x",
        { productId: created.id, variantId: v.id },
        {
          cookie,
          body: { expectedUpdatedAt: vPatched.updatedAt },
        },
      ),
    );
    expect(vArchived.isActive).toBe(false);
    await ok(
      await call(
        variantRestore.POST,
        "POST",
        "/x",
        { productId: created.id, variantId: v.id },
        {
          cookie,
          body: { expectedUpdatedAt: vArchived.updatedAt },
        },
      ),
    );

    const code = uniqueCode();
    const bc = await ok<{ id: string; variantId: string }>(
      await call(
        barcodes.POST,
        "POST",
        "/barcodes",
        {},
        { cookie, body: { code, productId: created.id, variantId: v.id } },
      ),
      201,
    );
    expect(bc.variantId).toBe(v.id);
    const deleted = await call(barcode.DELETE, "DELETE", "/barcodes/id", { barcodeId: bc.id }, { cookie });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(await deleted.text()).toBe("");
    expect(await db.barcode.findUnique({ where: { id: bc.id } })).toBeNull();

    const renamed = await ok<{ name: string; updatedAt: string }>(
      await call(
        category.PATCH,
        "PATCH",
        "/categories/id",
        { categoryId: cat.id },
        {
          cookie,
          body: { name: `Renamed ${shortUpper()}`, expectedUpdatedAt: cat.updatedAt },
        },
      ),
    );
    const catArchived = await ok<{ isActive: boolean; updatedAt: string }>(
      await call(
        categoryArchive.POST,
        "POST",
        "/x",
        { categoryId: cat.id },
        {
          cookie,
          body: { expectedUpdatedAt: renamed.updatedAt },
        },
      ),
    );
    expect(catArchived.isActive).toBe(false);
    await ok(
      await call(
        categoryRestore.POST,
        "POST",
        "/x",
        { categoryId: cat.id },
        {
          cookie,
          body: { expectedUpdatedAt: catArchived.updatedAt },
        },
      ),
    );

    const page = await ok<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await call(products.GET, "GET", "/products", {}, { cookie, query: { q: sku, categoryId: cat.id, q2: "" } }),
    );
    expect(page.items.map((i) => i.id)).toEqual([created.id]);
  });

  it("passes the cursor through the list query schema", async () => {
    const first = await ok<{ items: unknown[]; nextCursor: string | null }>(
      await call(products.GET, "GET", "/products", {}, { cookie: cookies.ADMIN, query: { limit: "1" } }),
    );
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await ok<{ items: unknown[] }>(
      await call(
        products.GET,
        "GET",
        "/products",
        {},
        {
          cookie: cookies.ADMIN,
          query: { limit: "1", cursor: first.nextCursor ?? "" },
        },
      ),
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).not.toEqual(first.items[0]);
    await expectEnvelope(
      await call(products.GET, "GET", "/products", {}, { cookie: cookies.ADMIN, query: { cursor: "garbage!" } }),
      422,
      "VALIDATION_FAILED",
    );
  });
});
