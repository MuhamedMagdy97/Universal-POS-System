import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import { createMember, createTenant, shortUpper, testDb, uniqueCode } from "./helpers";

/**
 * Owner decision "First barcode is primary": every item (product-level or one
 * variant) with barcodes has exactly one primary. Each test uses its own tenant.
 */
let db: Db;

const sku = (prefix = "P") => `${prefix}-${shortUpper()}`;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

async function newAdmin(): Promise<TenantContext> {
  const tenant = await createTenant(db, "Primary Barcode");
  return createMember(db, tenant.org.id, "ADMIN");
}

/** Primary codes of one item, straight from the DB. */
async function primaries(orgId: string, productId: string, variantId: string | null): Promise<string[]> {
  const rows = await db.barcode.findMany({
    where: { orgId, productId, variantId, isPrimary: true },
    select: { code: true },
  });
  return rows.map((r) => r.code);
}

async function primaryAudits(orgId: string) {
  return db.auditEvent.findMany({
    where: { orgId, action: "catalog.barcode.primary_changed" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

describe("addBarcode", () => {
  it("makes the first product-level barcode primary, later ones not", async () => {
    const admin = await newAdmin();
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Soap", priceMinor: 100 });
    const [a, b] = [uniqueCode(), uniqueCode()];

    expect(await catalog.addBarcode(admin, { code: a, productId: product.id })).toMatchObject({ isPrimary: true });
    expect(await catalog.addBarcode(admin, { code: b, productId: product.id })).toMatchObject({ isPrimary: false });
    expect(await primaries(admin.orgId, product.id, null)).toEqual([a]);
    expect((await catalog.getProduct(admin, product.id)).primaryBarcode).toBe(a);

    const audits = await primaryAudits(admin.orgId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ code: a, previousCode: null, reason: "first" });
  });

  it("makes the first barcode of each variant primary, independently", async () => {
    const admin = await newAdmin();
    const product = await catalog.createProductAggregate(admin, {
      sku: sku(),
      name: "Shirt",
      priceMinor: 100,
      variants: [
        { sku: sku("V"), name: "S" },
        { sku: sku("V"), name: "M" },
      ],
    });
    const [s, m] = product.variants;
    const [s1, s2, m1] = [uniqueCode(), uniqueCode(), uniqueCode()];
    await catalog.addBarcode(admin, { code: s1, productId: product.id, variantId: must(s).id });
    await catalog.addBarcode(admin, { code: s2, productId: product.id, variantId: must(s).id });
    await catalog.addBarcode(admin, { code: m1, productId: product.id, variantId: must(m).id });

    expect(await primaries(admin.orgId, product.id, must(s).id)).toEqual([s1]);
    expect(await primaries(admin.orgId, product.id, must(m).id)).toEqual([m1]);
    // Variant primaries are not the product-level primary.
    expect((await catalog.getProduct(admin, product.id)).primaryBarcode).toBeNull();
  });

  it("moves the primary to a code added with isPrimary", async () => {
    const admin = await newAdmin();
    const product = await catalog.createProduct(admin, {
      sku: sku(),
      name: "Soap",
      priceMinor: 100,
      barcodes: [uniqueCode()],
    });
    const old = must(product.barcodes[0]);
    const code = uniqueCode();

    expect(await catalog.addBarcode(admin, { code, productId: product.id, isPrimary: true })).toMatchObject({
      isPrimary: true,
    });
    expect(await primaries(admin.orgId, product.id, null)).toEqual([code]);
    const last = (await primaryAudits(admin.orgId)).at(-1);
    expect(last?.metadata).toMatchObject({ code, previousId: old.id, previousCode: old.code, reason: "explicit" });
  });

  it("concurrent adds to one item never violate the one-primary index", async () => {
    const admin = await newAdmin();
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Soap", priceMinor: 100 });
    const codes = Array.from({ length: 8 }, () => uniqueCode());

    const results = await Promise.allSettled(
      codes.map((code, i) => catalog.addBarcode(admin, { code, productId: product.id, isPrimary: i % 3 === 0 })),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await primaries(admin.orgId, product.id, null)).toHaveLength(1);
    expect(await db.barcode.count({ where: { orgId: admin.orgId, productId: product.id } })).toBe(codes.length);
  });
});

describe("removeBarcode", () => {
  it("promotes the item's next oldest barcode when the primary is removed", async () => {
    const admin = await newAdmin();
    const codes = [uniqueCode(), uniqueCode(), uniqueCode()];
    const product = await catalog.createProduct(admin, { sku: sku(), name: "Soap", priceMinor: 100, barcodes: codes });
    const first = must(product.barcodes.find((b) => b.code === codes[0]));
    expect(first.isPrimary).toBe(true);

    await catalog.removeBarcode(admin, first.id);
    expect(await primaries(admin.orgId, product.id, null)).toEqual([codes[1]]);
    expect((await primaryAudits(admin.orgId)).at(-1)?.metadata).toMatchObject({
      code: codes[1],
      previousId: first.id,
      reason: "promoted",
    });

    // Removing a non-primary leaves the primary alone.
    const third = must(product.barcodes.find((b) => b.code === codes[2]));
    await catalog.removeBarcode(admin, third.id);
    expect(await primaries(admin.orgId, product.id, null)).toEqual([codes[1]]);
  });

  it("promotes within the same variant only", async () => {
    const admin = await newAdmin();
    const [a1, a2, b1] = [uniqueCode(), uniqueCode(), uniqueCode()];
    const product = await catalog.createProductAggregate(admin, {
      sku: sku(),
      name: "Shirt",
      priceMinor: 100,
      variants: [
        { sku: sku("V"), name: "A", barcodes: [a1, a2] },
        { sku: sku("V"), name: "B", barcodes: [b1] },
      ],
    });
    const a = must(product.variants.find((v) => v.name === "A"));
    const b = must(product.variants.find((v) => v.name === "B"));
    await catalog.removeBarcode(admin, must(product.barcodes.find((x) => x.code === a1)).id);
    expect(await primaries(admin.orgId, product.id, a.id)).toEqual([a2]);
    expect(await primaries(admin.orgId, product.id, b.id)).toEqual([b1]);

    // Removing an item's last barcode leaves it without one (nothing to promote).
    await catalog.removeBarcode(admin, must(product.barcodes.find((x) => x.code === b1)).id);
    expect(await primaries(admin.orgId, product.id, b.id)).toEqual([]);
  });
});

describe("aggregate saves", () => {
  it("createProductAggregate marks the first code of every list primary", async () => {
    const admin = await newAdmin();
    const [p1, p2, v1, v2] = [uniqueCode(), uniqueCode(), uniqueCode(), uniqueCode()];
    const product = await catalog.createProductAggregate(admin, {
      sku: sku(),
      name: "Kit",
      priceMinor: 100,
      barcodes: [p1, p2],
    });
    expect(product.primaryBarcode).toBe(p1);
    expect(product.barcodes.filter((b) => b.isPrimary).map((b) => b.code)).toEqual([p1]);

    const withVariants = await catalog.createProductAggregate(admin, {
      sku: sku(),
      name: "Shirt",
      priceMinor: 100,
      variants: [{ sku: sku("V"), name: "S", barcodes: [v1, v2] }],
    });
    expect(withVariants.barcodes.filter((b) => b.isPrimary).map((b) => b.code)).toEqual([v1]);
  });

  it("updateProductAggregate makes the first code of the list primary", async () => {
    const admin = await newAdmin();
    const [a, b, c] = [uniqueCode(), uniqueCode(), uniqueCode()];
    const product = await catalog.createProductAggregate(admin, {
      sku: sku(),
      name: "Kit",
      priceMinor: 100,
      barcodes: [a, b],
    });

    // Reorder only: b becomes primary, and the save bumps updatedAt.
    const reordered = await catalog.updateProductAggregate(admin, product.id, {
      expectedUpdatedAt: product.updatedAt,
      barcodes: [b, a],
    });
    expect(reordered.primaryBarcode).toBe(b);
    expect(await primaries(admin.orgId, product.id, null)).toEqual([b]);
    expect(Date.parse(reordered.updatedAt)).toBeGreaterThan(Date.parse(product.updatedAt));

    // A new first code takes the primary; removing the old primary promotes nothing else.
    const replaced = await catalog.updateProductAggregate(admin, product.id, {
      expectedUpdatedAt: reordered.updatedAt,
      barcodes: [c, a],
    });
    expect(replaced.primaryBarcode).toBe(c);
    expect(await primaries(admin.orgId, product.id, null)).toEqual([c]);

    // Unchanged list: no new primary audit rows.
    const count = (await primaryAudits(admin.orgId)).length;
    await catalog.updateProductAggregate(admin, product.id, {
      expectedUpdatedAt: replaced.updatedAt,
      barcodes: [c, a],
    });
    expect(await primaryAudits(admin.orgId)).toHaveLength(count);
  });

  it("updateProductAggregate sets each edited variant's primary", async () => {
    const admin = await newAdmin();
    const [a, b] = [uniqueCode(), uniqueCode()];
    const product = await catalog.createProductAggregate(admin, {
      sku: sku(),
      name: "Shirt",
      priceMinor: 100,
      variants: [{ sku: sku("V"), name: "S", barcodes: [a, b] }],
    });
    const variant = must(product.variants[0]);
    await catalog.updateProductAggregate(admin, product.id, {
      expectedUpdatedAt: product.updatedAt,
      variants: [
        {
          id: variant.id,
          expectedUpdatedAt: variant.updatedAt,
          sku: variant.sku,
          name: variant.name,
          barcodes: [b, a],
        },
      ],
    });
    expect(await primaries(admin.orgId, product.id, variant.id)).toEqual([b]);
  });
});
