import { ZodError } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import { createCategory, createMember, createTenant, shortUpper, testDb, uniqueCode } from "./helpers";

/** Search, filters and cursor pagination (C-5, C-10). */
let db: Db;
let tenant: Awaited<ReturnType<typeof createTenant>>;
let other: Awaited<ReturnType<typeof createTenant>>;
let admin: TenantContext;
let outsider: TenantContext;
let tag: string;
let categoryId: string;
let barcode: string;
let barcodeProductId: string;

const TOTAL = 120;

/** Walks every page and returns the ids in order. */
async function collect(ctx: TenantContext, query: catalog.ListProductsQueryInput) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await catalog.listProducts(ctx, { ...query, cursor });
    ids.push(...page.items.map((p) => p.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 50) throw new Error("pagination did not terminate");
  } while (cursor);
  return { ids, pages };
}

beforeAll(async () => {
  db = testDb();
  tenant = await createTenant(db, "Search");
  other = await createTenant(db, "Search other");
  admin = await createMember(db, tenant.org.id, "ADMIN");
  outsider = await createMember(db, other.org.id, "ADMIN");
  tag = shortUpper();
  categoryId = (await createCategory(db, tenant.org.id, `Search cat ${tag}`)).id;

  await db.product.createMany({
    data: Array.from({ length: TOTAL }, (_, i) => ({
      orgId: tenant.org.id,
      sku: `S${tag}-${String(i).padStart(3, "0")}`,
      // Duplicate names on purpose so the id tie-break matters.
      name: `Widget ${String(Math.floor(i / 3)).padStart(3, "0")}`,
      nameAr: i === 7 ? "قهوة عربية" : null,
      priceMinor: 100 + i,
      categoryId: i % 10 === 0 ? categoryId : null,
      isActive: i % 40 !== 39,
    })),
  });
  const target = await db.product.findFirstOrThrow({ where: { orgId: tenant.org.id, sku: `S${tag}-050` } });
  barcode = uniqueCode();
  barcodeProductId = target.id;
  await db.barcode.create({ data: { orgId: tenant.org.id, productId: target.id, code: barcode } });
  // A product whose name happens to contain the barcode digits as well: must not be duplicated.
  await db.product.create({
    data: { orgId: tenant.org.id, sku: `T${tag}`, name: `Label ${barcode}`, priceMinor: 1 },
  });
});

afterAll(async () => {
  await db.$disconnect();
  await getDb().$disconnect();
});

describe("search (C-5)", () => {
  it("matches a partial name, case-insensitively", async () => {
    const page = await catalog.listProducts(admin, { q: "widget 01", limit: 100 });
    expect(page.items.map((p) => p.name).every((n) => n.startsWith("Widget 01"))).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it("matches a SKU prefix typed in lower case", async () => {
    const page = await catalog.listProducts(admin, { q: `s${tag.toLowerCase()}-00`, limit: 100 });
    expect(page.items.map((p) => p.sku).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `S${tag}-00${i}`).sort());
  });

  it("matches the Arabic name", async () => {
    const page = await catalog.listProducts(admin, { q: "قهوة" });
    expect(page.items.map((p) => p.sku)).toEqual([`S${tag}-007`]);
  });

  it("puts the exact barcode match first, without duplicating it", async () => {
    const page = await catalog.listProducts(admin, { q: barcode });
    expect(page.items[0]?.id).toBe(barcodeProductId);
    expect(page.items.map((p) => p.sku)).toEqual([`S${tag}-050`, `T${tag}`]);
    expect(page.nextCursor).toBeNull();
  });

  it("continues correctly when page 1 holds only the barcode hit", async () => {
    const first = await catalog.listProducts(admin, { q: barcode, limit: 1 });
    expect(first.items.map((p) => p.id)).toEqual([barcodeProductId]);
    expect(first.nextCursor).not.toBeNull();
    const second = await catalog.listProducts(admin, { q: barcode, limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((p) => p.sku)).toEqual([`T${tag}`]);
    expect(second.nextCursor).toBeNull();
  });

  it("treats LIKE wildcards literally", async () => {
    expect((await catalog.listProducts(admin, { q: "%" })).items).toEqual([]);
    expect((await catalog.listProducts(admin, { q: "_" })).items).toEqual([]);
  });
});

describe("pagination", () => {
  it("walks every active product exactly once in name, id order", async () => {
    const activeCount = await db.product.count({ where: { orgId: tenant.org.id, isActive: true } });
    const { ids, pages } = await collect(admin, { limit: 25 });
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(activeCount);
    expect(pages).toBe(Math.ceil(activeCount / 25));

    const expected = await db.product.findMany({
      where: { orgId: tenant.org.id, isActive: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(ids).toEqual(expected.map((p) => p.id));
  });

  it("is stable when sorting by updatedAt (DESC, id DESC)", async () => {
    const { ids } = await collect(admin, { limit: 7, sort: "updatedAt", status: "all" });
    const expected = await db.product.findMany({
      where: { orgId: tenant.org.id },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    expect(ids).toEqual(expected.map((p) => p.id));
  });

  it("paginates a filtered search", async () => {
    const { ids } = await collect(admin, { q: "widget", limit: 10, status: "all" });
    expect(ids).toHaveLength(TOTAL);
  });

  it("rejects a forged cursor with a validation error", async () => {
    await expect(catalog.listProducts(admin, { cursor: "not-a-cursor!" })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("filters", () => {
  it("filters by status", async () => {
    const archived = await catalog.listProducts(admin, { status: "archived", limit: 100 });
    expect(archived.items.map((p) => p.sku).sort()).toEqual([`S${tag}-039`, `S${tag}-079`, `S${tag}-119`]);
    expect(archived.items.every((p) => !p.isActive)).toBe(true);
  });

  it("filters by category", async () => {
    const page = await catalog.listProducts(admin, { categoryId, limit: 100 });
    expect(page.items).toHaveLength(TOTAL / 10);
    expect(page.items.every((p) => p.categoryId === categoryId)).toBe(true);
  });
});

describe("tenant isolation (C-10)", () => {
  it("returns nothing for another org's SKU, name or barcode", async () => {
    expect((await catalog.listProducts(outsider, { q: `S${tag}` })).items).toEqual([]);
    expect((await catalog.listProducts(outsider, { q: barcode })).items).toEqual([]);
    expect((await catalog.listProducts(outsider, { categoryId })).items).toEqual([]);
  });
});

describe("VAT category filter", () => {
  it("returns only products of the requested VAT category, combined with other filters", async () => {
    const t = await createTenant(db, "VAT filter");
    const ctx = await createMember(db, t.org.id, "ADMIN");
    const p = `VF${shortUpper()}`;
    const standard = await catalog.createProduct(ctx, { sku: `${p}-S`, name: "Std", priceMinor: 1 });
    const zero = await catalog.createProduct(ctx, {
      sku: `${p}-Z`,
      name: "Zero",
      priceMinor: 1,
      vatCategory: "ZERO_RATED",
    });
    const exempt = await catalog.createProduct(ctx, {
      sku: `${p}-E`,
      name: "Exempt",
      priceMinor: 1,
      vatCategory: "EXEMPT",
    });
    const archivedExempt = await catalog.createProduct(ctx, {
      sku: `${p}-EA`,
      name: "Exempt old",
      priceMinor: 1,
      vatCategory: "EXEMPT",
    });
    await catalog.archiveProduct(ctx, archivedExempt.id, { expectedUpdatedAt: archivedExempt.updatedAt });

    const ids = async (query: catalog.ListProductsQueryInput) =>
      (await catalog.listProducts(ctx, query)).items.map((i) => i.id).sort();

    expect(await ids({ vatCategory: "STANDARD" })).toEqual([standard.id]);
    expect(await ids({ vatCategory: "ZERO_RATED" })).toEqual([zero.id]);
    expect(await ids({ vatCategory: "EXEMPT" })).toEqual([exempt.id]);
    expect(await ids({ vatCategory: "EXEMPT", status: "all" })).toEqual([exempt.id, archivedExempt.id].sort());
    expect(await ids({ vatCategory: "EXEMPT", q: "old", status: "all" })).toEqual([archivedExempt.id]);
    expect(await ids({})).toEqual([standard.id, zero.id, exempt.id].sort());
    await expect(catalog.listProducts(ctx, { vatCategory: "REDUCED" as never })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("primary barcode in the list", () => {
  it("shows the product-level primary barcode, else null", async () => {
    const t = await createTenant(db, "Primary barcode");
    const ctx = await createMember(db, t.org.id, "ADMIN");
    const p = `PB${shortUpper()}`;
    const withPrimary = await catalog.createProduct(ctx, { sku: `${p}-A`, name: "A", priceMinor: 1 });
    const primaryCode = uniqueCode();
    await catalog.addBarcode(ctx, { code: uniqueCode(), productId: withPrimary.id });
    await catalog.addBarcode(ctx, { code: primaryCode, productId: withPrimary.id, isPrimary: true });
    const nonPrimary = await catalog.createProduct(ctx, {
      sku: `${p}-B`,
      name: "B",
      priceMinor: 1,
      barcodes: [uniqueCode()],
    });
    const variantOnly = await catalog.createProductAggregate(ctx, {
      sku: `${p}-C`,
      name: "C",
      priceMinor: 1,
      variants: [{ sku: `${p}-C1`, name: "C1" }],
    });
    const [variant] = variantOnly.variants;
    if (!variant) throw new Error("variant missing");
    await catalog.addBarcode(ctx, {
      code: uniqueCode(),
      productId: variantOnly.id,
      variantId: variant.id,
      isPrimary: true,
    });

    const page = await catalog.listProducts(ctx, { q: p });
    const byId = new Map(page.items.map((i) => [i.id, i.primaryBarcode]));
    expect(byId.get(withPrimary.id)).toBe(primaryCode);
    expect(byId.get(nonPrimary.id)).toBeNull();
    expect(byId.get(variantOnly.id)).toBeNull();
    // The exact-barcode hit (prepended on page 1) carries it too.
    const hit = await catalog.listProducts(ctx, { q: primaryCode });
    expect(hit.items[0]).toMatchObject({ id: withPrimary.id, primaryBarcode: primaryCode });
    expect((await catalog.getProduct(ctx, withPrimary.id)).primaryBarcode).toBe(primaryCode);
  });
});
