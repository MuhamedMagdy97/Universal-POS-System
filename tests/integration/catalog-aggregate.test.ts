import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import { createMember, createTenant, detailsOf, expectAppError, shortUpper, testDb, uniqueCode } from "./helpers";

/**
 * Atomic product save (createProductAggregate / updateProductAggregate): the
 * product, its variants and barcodes commit together with their audit rows,
 * or nothing does. Each test uses its own tenant so audit counts are exact.
 */
let db: Db;

const sku = (prefix = "P") => `${prefix}-${shortUpper()}`;
const meta = () => ({ requestId: `req-${randomUUID()}` });

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

async function newAdmin(): Promise<TenantContext> {
  const tenant = await createTenant(db, "Catalog Aggregate");
  return createMember(db, tenant.org.id, "ADMIN");
}

async function auditActions(orgId: string): Promise<string[]> {
  const rows = await db.auditEvent.findMany({
    where: { orgId, action: { startsWith: "catalog." } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { action: true },
  });
  return rows.map((r) => r.action);
}

async function snapshot(orgId: string) {
  const [products, variants, barcodes, audits] = await Promise.all([
    db.product.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    db.productVariant.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    db.barcode.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    db.auditEvent.count({ where: { orgId } }),
  ]);
  return { products, variants, barcodes, audits };
}

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

describe("createProductAggregate", () => {
  it("creates product, variants and barcodes with every audit event", async () => {
    const admin = await newAdmin();
    const m = meta();
    const [c0, c1, c2] = [uniqueCode(), uniqueCode(), uniqueCode()];
    const codes = [c0, c1, c2];
    const result = await catalog.createProductAggregate(
      admin,
      {
        sku: sku(),
        name: "Shirt",
        priceMinor: 1000,
        costMinor: 1200,
        barcodes: [c0],
        variants: [
          { sku: sku("V"), name: "Small", barcodes: [c1] },
          { sku: sku("V"), name: "Large", priceMinor: 1500, barcodes: [c2] },
        ],
      },
      m,
    );

    expect(result.hasVariants).toBe(true);
    expect(result.variants.map((v) => v.name).sort()).toEqual(["Large", "Small"]);
    expect(result.barcodes.map((b) => b.code).sort()).toEqual([...codes].sort());
    expect(result.warnings).toEqual(["PRICE_BELOW_COST"]);

    const actions = await auditActions(admin.orgId);
    expect(actions.filter((a) => a === "catalog.product.created")).toHaveLength(1);
    expect(actions.filter((a) => a === "catalog.variant.created")).toHaveLength(2);
    expect(actions.filter((a) => a === "catalog.barcode.added")).toHaveLength(3);
    const events = await db.auditEvent.findMany({ where: { orgId: admin.orgId } });
    expect(events.every((e) => e.requestId === m.requestId)).toBe(true);
  });

  it("rolls back everything (audit rows included) when a later variant's SKU is taken", async () => {
    const admin = await newAdmin();
    const taken = await catalog.createProduct(admin, { sku: sku(), name: "Existing", priceMinor: 100 });
    const before = await snapshot(admin.orgId);

    const err = await expectAppError(
      catalog.createProductAggregate(admin, {
        sku: sku(),
        name: "New",
        priceMinor: 500,
        barcodes: [uniqueCode()],
        variants: [
          { sku: sku("V"), name: "A", barcodes: [uniqueCode()] },
          { sku: taken.sku, name: "B" },
        ],
      }),
      409,
      "SKU_TAKEN",
    );
    expect(detailsOf(err)).toMatchObject({ field: "variants[1].sku", existingId: taken.id });
    expect(await snapshot(admin.orgId)).toEqual(before);
  });

  it("rolls back everything when a variant barcode is taken and names its index", async () => {
    const admin = await newAdmin();
    const takenCode = uniqueCode();
    const holder = await catalog.createProduct(admin, {
      sku: sku(),
      name: "Holder",
      priceMinor: 100,
      barcodes: [takenCode],
    });
    const before = await snapshot(admin.orgId);

    const err = await expectAppError(
      catalog.createProductAggregate(admin, {
        sku: sku(),
        name: "New",
        priceMinor: 500,
        variants: [{ sku: sku("V"), name: "A", barcodes: [uniqueCode(), takenCode] }],
      }),
      409,
      "BARCODE_TAKEN",
    );
    expect(detailsOf(err)).toMatchObject({ field: "variants[0].barcodes[1]", existingId: holder.id });
    expect(await snapshot(admin.orgId)).toEqual(before);
  });

  it("rejects a SKU or barcode repeated inside the request before any write", async () => {
    const admin = await newAdmin();
    const productSku = sku();
    const code = uniqueCode();
    const err = await catalog
      .createProductAggregate(admin, {
        sku: productSku,
        name: "Dup",
        priceMinor: 1,
        barcodes: [code],
        variants: [{ sku: productSku, name: "A", barcodes: [code] }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    const paths = (err as ZodError).issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["variants.0.sku", "variants.0.barcodes.0"]));
    expect(await auditActions(admin.orgId)).toEqual([]);
  });
});

describe("updateProductAggregate", () => {
  async function seeded(admin: TenantContext) {
    return catalog.createProductAggregate(admin, {
      sku: sku(),
      name: "Base",
      priceMinor: 1000,
      costMinor: 400,
      variants: [
        { sku: sku("V"), name: "Red", barcodes: [uniqueCode()] },
        { sku: sku("V"), name: "Blue" },
      ],
    });
  }

  function byName(product: catalog.ProductDetail) {
    return {
      red: must(product.variants.find((v) => v.name === "Red")),
      blue: must(product.variants.find((v) => v.name === "Blue")),
    };
  }

  it("applies product, barcode and variant changes atomically with all audit events", async () => {
    const admin = await newAdmin();
    const product = await seeded(admin);
    const { red, blue } = byName(product);
    const redCode = must(product.barcodes.find((b) => b.variantId === red.id)).code;
    const before = (await auditActions(admin.orgId)).length;
    const newCode = uniqueCode();

    const result = await catalog.updateProductAggregate(admin, product.id, {
      expectedUpdatedAt: product.updatedAt,
      priceMinor: 1100,
      name: "Base 2",
      variants: [
        // Move Red's barcode to the new variant; rename Red.
        { id: red.id, expectedUpdatedAt: red.updatedAt, sku: red.sku, name: "Crimson", barcodes: [] },
        { id: blue.id, expectedUpdatedAt: blue.updatedAt, sku: blue.sku, name: "Blue", isActive: false },
        { sku: sku("V"), name: "Green", priceMinor: 1300, barcodes: [redCode, newCode] },
      ],
    });

    expect(result).toMatchObject({ name: "Base 2", priceMinor: 1100 });
    expect(result.variants.find((v) => v.id === red.id)).toMatchObject({ name: "Crimson", isActive: true });
    expect(result.variants.find((v) => v.id === blue.id)).toMatchObject({ isActive: false });
    const green = must(result.variants.find((v) => v.name === "Green"));
    expect(result.barcodes.filter((b) => b.variantId === green.id).map((b) => b.code)).toEqual([redCode, newCode]);
    expect(Date.parse(result.updatedAt)).toBeGreaterThan(Date.parse(product.updatedAt));

    const actions = (await auditActions(admin.orgId)).slice(before);
    expect(actions.sort()).toEqual(
      [
        "catalog.product.updated",
        "catalog.product.price_changed",
        "catalog.barcode.removed",
        "catalog.variant.updated",
        "catalog.variant.archived",
        "catalog.variant.created",
        "catalog.barcode.added",
        "catalog.barcode.added",
        // Green's first barcode becomes its primary.
        "catalog.barcode.primary_changed",
      ].sort(),
    );
  });

  it("rolls back product and barcode changes when a new variant's SKU is taken", async () => {
    const admin = await newAdmin();
    const product = await seeded(admin);
    const other = await catalog.createProduct(admin, { sku: sku(), name: "Other", priceMinor: 1 });
    const { red, blue } = byName(product);
    const before = await snapshot(admin.orgId);

    const err = await expectAppError(
      catalog.updateProductAggregate(admin, product.id, {
        expectedUpdatedAt: product.updatedAt,
        priceMinor: 999,
        variants: [
          { id: red.id, expectedUpdatedAt: red.updatedAt, sku: red.sku, name: "Changed", barcodes: [] },
          { id: blue.id, expectedUpdatedAt: blue.updatedAt, sku: blue.sku, name: "Blue" },
          { sku: other.sku, name: "Clash" },
        ],
      }),
      409,
      "SKU_TAKEN",
    );
    expect(detailsOf(err)).toMatchObject({ field: "variants[2].sku", existingId: other.id });
    expect(await snapshot(admin.orgId)).toEqual(before);
  });

  it("rolls back when an added barcode is taken and names the barcode index", async () => {
    const admin = await newAdmin();
    const product = await seeded(admin);
    const takenCode = uniqueCode();
    await catalog.createProduct(admin, { sku: sku(), name: "Holder", priceMinor: 1, barcodes: [takenCode] });
    const { red } = byName(product);
    const before = await snapshot(admin.orgId);

    const err = await expectAppError(
      catalog.updateProductAggregate(admin, product.id, {
        expectedUpdatedAt: product.updatedAt,
        name: "Renamed",
        variants: [
          {
            id: red.id,
            expectedUpdatedAt: red.updatedAt,
            sku: red.sku,
            name: red.name,
            barcodes: [uniqueCode(), takenCode],
          },
        ],
      }),
      409,
      "BARCODE_TAKEN",
    );
    expect(detailsOf(err)).toMatchObject({ field: "variants[0].barcodes[1]" });
    expect(await snapshot(admin.orgId)).toEqual(before);
  });

  it("rejects a stale product write and a stale variant write without changing anything", async () => {
    const admin = await newAdmin();
    const product = await seeded(admin);
    const { red } = byName(product);
    // Someone else saves first.
    const fresh = await catalog.updateProductAggregate(admin, product.id, {
      expectedUpdatedAt: product.updatedAt,
      name: "Theirs",
    });
    const before = await snapshot(admin.orgId);

    await expectAppError(
      catalog.updateProductAggregate(admin, product.id, { expectedUpdatedAt: product.updatedAt, name: "Mine" }),
      409,
      "STALE_WRITE",
    );

    const staleVariant = new Date(Date.parse(red.updatedAt) - 1000).toISOString();
    const err = await expectAppError(
      catalog.updateProductAggregate(admin, product.id, {
        expectedUpdatedAt: fresh.updatedAt,
        priceMinor: 5,
        variants: [{ id: red.id, expectedUpdatedAt: staleVariant, sku: red.sku, name: "Mine" }],
      }),
      409,
      "STALE_WRITE",
    );
    expect(detailsOf(err)).toMatchObject({ field: "variants[0]" });
    expect(await snapshot(admin.orgId)).toEqual(before);
  });

  it("is a no-op (no audit, same updatedAt) when nothing changed", async () => {
    const admin = await newAdmin();
    const product = await seeded(admin);
    const before = await snapshot(admin.orgId);
    const result = await catalog.updateProductAggregate(admin, product.id, {
      expectedUpdatedAt: product.updatedAt,
      name: product.name,
      barcodes: [],
      variants: product.variants.map((v) => ({
        id: v.id,
        expectedUpdatedAt: v.updatedAt,
        sku: v.sku,
        name: v.name,
        barcodes: product.barcodes.filter((b) => b.variantId === v.id).map((b) => b.code),
      })),
    });
    expect(result.updatedAt).toBe(product.updatedAt);
    expect(await snapshot(admin.orgId)).toEqual(before);
  });
});
