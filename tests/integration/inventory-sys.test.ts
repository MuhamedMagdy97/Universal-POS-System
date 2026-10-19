import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as catalog from "@/modules/catalog";
import * as inventory from "@/modules/inventory";
import { getTillOnHand } from "@/modules/inventory/till-stock";
import * as purchasing from "@/modules/purchasing";
import {
  checkInventoryLink,
  getInventoryLinkStatus,
  saveInventoryLink,
  setInventorySource,
  syncInventoryNow,
} from "@/modules/integrations/inventory-sys";
import { fakeFetch, fakeIms, type FakeCategory, type FakeIms, type FakeProduct } from "../support/fake-ims";
import {
  createCategory,
  createMember,
  createProduct,
  createTenant,
  expectAppError,
  shortUpper,
  testDb,
} from "./helpers";

/** Phase 13 slice 1: link settings, the source toggle, the catalog sync and the read-only guards. */

process.env.INTEGRATION_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const BASE = "http://127.0.0.1:4999";
const KEY = `ims_${randomUUID()}`;

let db: Db;
let ims: FakeIms;

const simple = (sku: string, price = "10", barcode: string | null = `${sku}-BC`): FakeProduct => ({
  id: randomUUID(),
  name: `Item ${sku}`,
  type: "simple",
  status: "active",
  isSerialized: false,
  baseUom: "each",
  variants: [{ id: randomUUID(), sku, barcode, name: null, status: "active", sellPrice: price, costPrice: "4" }],
});

const parent = (prefix: string): FakeProduct => ({
  id: randomUUID(),
  name: `Shirt ${prefix}`,
  type: "variant_parent",
  status: "active",
  isSerialized: false,
  baseUom: "each",
  variants: ["M", "L"].map((size) => ({
    id: randomUUID(),
    sku: `${prefix}-${size}`,
    barcode: `${prefix}-${size}-BC`,
    name: size,
    status: "active",
    sellPrice: "150",
    costPrice: null,
  })),
});

async function linkedTenant(label: string, products: FakeProduct[]) {
  const tenant = await createTenant(db, label);
  const owner = await createMember(db, tenant.org.id, "OWNER");
  ims.products = products;
  expect(await saveInventoryLink(owner, { baseUrl: BASE, apiKey: KEY })).toEqual({ ok: true });
  return { ...tenant, owner };
}

beforeAll(() => {
  db = testDb();
});

beforeEach(() => {
  ims = fakeIms(KEY);
  vi.stubGlobal("fetch", fakeFetch(ims));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("link settings (spec I2–I4)", () => {
  it("seals the key, never returns or audits it, and lets only the owner change the link", async () => {
    const tenant = await createTenant(db, "Inv Link");
    const owner = await createMember(db, tenant.org.id, "OWNER");
    const admin = await createMember(db, tenant.org.id, "ADMIN");
    const cashier = await createMember(db, tenant.org.id, "CASHIER");

    await expectAppError(saveInventoryLink(admin, { baseUrl: BASE, apiKey: KEY }), 403);
    await expectAppError(saveInventoryLink(owner, { baseUrl: BASE }), 422, "API_KEY_REQUIRED");
    await expect(saveInventoryLink(owner, { baseUrl: "http://ims.example.com", apiKey: KEY })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(await saveInventoryLink(owner, { baseUrl: `${BASE}/some/path?x=1`, apiKey: KEY })).toEqual({ ok: true });
    expect(ims.keysSeen.every((k) => k === KEY)).toBe(true);

    const status = await getInventoryLinkStatus(admin);
    expect(status).toMatchObject({ source: "BUILT_IN", canManage: false, link: { baseUrl: BASE, lastCheckOk: true } });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(status.link?.keyLast4).toBe(KEY.slice(-4));
    await expectAppError(getInventoryLinkStatus(cashier), 403);

    const row = await db.inventoryLink.findUniqueOrThrow({ where: { orgId: tenant.org.id } });
    expect(Buffer.from(row.apiKeyCiphertext).toString("utf8")).not.toContain(KEY);
    const audits = await db.auditEvent.findMany({ where: { orgId: tenant.org.id } });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "integration.inventory.permission.denied",
        "integration.inventory.link_saved",
        "integration.inventory.checked",
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain(KEY);

    // Keeping the key: only the address changes.
    expect(await saveInventoryLink(owner, { baseUrl: BASE })).toEqual({ ok: true });
  });

  it("reports a refused key, a missing stock permission and an outage, and blocks enabling", async () => {
    const tenant = await createTenant(db, "Inv Check");
    const owner = await createMember(db, tenant.org.id, "OWNER");
    expect(await saveInventoryLink(owner, { baseUrl: BASE, apiKey: "wrong-key-123" })).toEqual({
      ok: false,
      problem: "REFUSED",
    });
    await expectAppError(setInventorySource(owner, { source: "EXTERNAL" }), 409, "CHECK_FAILED");

    await saveInventoryLink(owner, { baseUrl: BASE, apiKey: KEY });
    ims.noStockPermission = true;
    expect(await checkInventoryLink(owner)).toEqual({ ok: false, problem: "REFUSED" });
    ims.noStockPermission = false;
    ims.down = "network";
    expect(await checkInventoryLink(owner)).toEqual({ ok: false, problem: "UNREACHABLE" });
    ims.down = "503";
    expect(await checkInventoryLink(owner)).toEqual({ ok: false, problem: "UNREACHABLE" });
    ims.down = false;
    expect(await checkInventoryLink(owner)).toEqual({ ok: true });
  });

  it("refuses to switch with an open shift", async () => {
    const t = await linkedTenant("Inv Shift", []);
    await db.registerShift.create({
      data: {
        orgId: t.org.id,
        branchId: t.branchA.id,
        registerId: t.register.id,
        openedById: t.owner.userId,
        openingFloatMinor: 0,
      },
    });
    await expectAppError(setInventorySource(t.owner, { source: "EXTERNAL" }), 409, "OPEN_SHIFTS");
    expect((await db.organization.findUniqueOrThrow({ where: { id: t.org.id } })).inventorySource).toBe("BUILT_IN");
  });
});

describe("catalog sync (spec I6–I11)", () => {
  it("enabling runs the first sync: creates, adopts by SKU and archives POS-only items", async () => {
    const sku = `SY-${shortUpper()}`;
    const cola = simple(`${sku}-COLA`, "12.50");
    const shirt = parent(`${sku}-SH`);
    const serial = { ...simple(`${sku}-PHONE`, "999"), isSerialized: true };
    const t = await linkedTenant("Inv Sync", [cola, shirt, serial]);
    const adopted = await createProduct(db, t.org.id, `${sku}-COLA`);
    const posOnly = await createProduct(db, t.org.id, `${sku}-LOCAL`);

    const result = await setInventorySource(t.owner, { source: "EXTERNAL" });
    expect(result.syncError).toBeNull();
    expect(result.sync).toMatchObject({ listed: 3, created: 2, updated: 1, archived: 1, skipped: [] });

    const colaRow = await db.product.findUniqueOrThrow({ where: { id: adopted.id } });
    expect(colaRow).toMatchObject({
      externalProductId: cola.id,
      externalVariantId: cola.variants[0].id,
      priceMinor: 1250,
      costMinor: 400,
      isActive: true,
    });
    const codes = await db.barcode.findMany({ where: { productId: adopted.id } });
    expect(codes.map((b) => [b.code, b.isPrimary])).toEqual([[`${sku}-COLA-BC`, true]]);

    const shirtRow = await db.product.findFirstOrThrow({
      where: { orgId: t.org.id, externalProductId: shirt.id },
      include: { variants: { orderBy: { sortOrder: "asc" } } },
    });
    expect(shirtRow.hasVariants).toBe(true);
    expect(shirtRow.variants.map((v) => [v.sku, v.priceMinor, v.externalVariantId])).toEqual([
      [`${sku}-SH-M`, 15000, shirt.variants[0].id],
      [`${sku}-SH-L`, 15000, shirt.variants[1].id],
    ]);
    const serialRow = await db.product.findFirstOrThrow({ where: { orgId: t.org.id, externalProductId: serial.id } });
    expect(serialRow).toMatchObject({ isActive: false, notSellableReason: "SERIALIZED" });
    expect(await db.product.findUniqueOrThrow({ where: { id: posOnly.id } })).toMatchObject({
      isActive: false,
      notSellableReason: "REMOVED",
    });

    const status = await getInventoryLinkStatus(t.owner);
    expect(status).toMatchObject({ source: "EXTERNAL", link: { lastSyncOk: true, syncRunning: false } });

    // Stock is never copied: the sync wrote no ledger or balance rows.
    expect(await db.inventoryMovement.count({ where: { orgId: t.org.id } })).toBe(0);
    expect(await db.stockBalance.count({ where: { orgId: t.org.id } })).toBe(0);
  });

  it("applies price, barcode and status changes and archives removed items, with audit", async () => {
    const sku = `RS-${shortUpper()}`;
    const a = simple(`${sku}-A`, "5");
    const b = simple(`${sku}-B`, "6");
    const t = await linkedTenant("Inv Resync", [a, b]);
    await setInventorySource(t.owner, { source: "EXTERNAL" });

    a.variants[0].sellPrice = "5.75";
    a.variants[0].barcode = `${sku}-A-NEW`;
    a.variants[0].barcodeAliases = [{ barcode: `${sku}-A-BC` }];
    ims.products = [a];
    const summary = await syncInventoryNow(t.owner);
    expect(summary).toMatchObject({ created: 0, updated: 1, archived: 1 });

    const rowA = await db.product.findFirstOrThrow({ where: { orgId: t.org.id, externalProductId: a.id } });
    expect(rowA.priceMinor).toBe(575);
    const codes = await db.barcode.findMany({ where: { productId: rowA.id }, orderBy: { isPrimary: "desc" } });
    expect(codes.map((c) => [c.code, c.isPrimary])).toEqual([
      [`${sku}-A-NEW`, true],
      [`${sku}-A-BC`, false],
    ]);
    const rowB = await db.product.findFirstOrThrow({ where: { orgId: t.org.id, externalProductId: b.id } });
    expect(rowB.isActive).toBe(false);

    const priceAudit = await db.auditEvent.findFirstOrThrow({
      where: { orgId: t.org.id, entityId: rowA.id, action: "catalog.product.price_changed" },
    });
    expect(priceAudit.metadata).toMatchObject({ priceMinor: [500, 575], source: "inventory-sync" });

    // A second pass with nothing new changes nothing.
    expect(await syncInventoryNow(t.owner)).toMatchObject({ updated: 0, unchanged: 1, archived: 0 });
  });

  it("an outage fails the sync, keeps what was applied and releases the slot", async () => {
    const t = await linkedTenant("Inv Outage", [simple(`OU-${shortUpper()}`)]);
    await setInventorySource(t.owner, { source: "EXTERNAL" });
    ims.down = "503";
    await expectAppError(syncInventoryNow(t.owner), 409, "INVENTORY_UNAVAILABLE");
    const link = await db.inventoryLink.findUniqueOrThrow({ where: { orgId: t.org.id } });
    expect(link).toMatchObject({ lastSyncOk: false, syncLockedUntil: null });
    expect(await db.auditEvent.count({ where: { orgId: t.org.id, action: "integration.inventory.sync.failed" } })).toBe(
      1,
    );
    expect(await db.product.count({ where: { orgId: t.org.id, isActive: true } })).toBe(1);

    await db.inventoryLink.update({
      where: { orgId: t.org.id },
      data: { syncLockedUntil: new Date(Date.now() + 60_000) },
    });
    ims.down = false;
    await expectAppError(syncInventoryNow(t.owner), 409, "SYNC_RUNNING");
  });

  it("keeps tenants apart: the same IMS ids map to separate rows per org", async () => {
    const shared = simple(`TI-${shortUpper()}`);
    const one = await linkedTenant("Inv Iso A", [shared]);
    await setInventorySource(one.owner, { source: "EXTERNAL" });
    const two = await linkedTenant("Inv Iso B", [shared]);
    const twoLocal = await createProduct(db, two.org.id);
    // Org B is linked to the same IMS but still built-in: syncing it is refused, its catalog untouched.
    await expectAppError(syncInventoryNow(two.owner), 409, "NOT_LINKED");
    expect((await db.product.findUniqueOrThrow({ where: { id: twoLocal.id } })).isActive).toBe(true);

    await setInventorySource(two.owner, { source: "EXTERNAL" });
    const rows = await db.product.findMany({ where: { externalProductId: shared.id } });
    expect(rows.map((r) => r.orgId).sort()).toEqual([one.org.id, two.org.id].sort());
  });
});

describe("category sync", () => {
  const cat = (name: string, parentId: string | null = null, archived = false): FakeCategory => ({
    id: randomUUID(),
    parentId,
    name,
    sort: 0,
    archived,
  });

  it("first sync builds the tree, adopts by name, folds deep levels and archives POS-only categories", async () => {
    const sku = `CS-${shortUpper()}`;
    const drinks = cat("Drinks");
    const soft = cat("Soft", drinks.id);
    const cola = cat("Cola", soft.id);
    const diet = cat("Diet", cola.id);
    const zero = cat("Zero", diet.id);
    const old = cat("Old", null, true);
    const a = { ...simple(`${sku}-A`), categoryId: zero.id };
    const b = { ...simple(`${sku}-B`), categoryId: soft.id };
    const c = simple(`${sku}-C`);
    const t = await linkedTenant("Inv Cat", [a, b, c]);
    ims.categories = [drinks, soft, cola, diet, zero, old];
    const posDrinks = await createCategory(db, t.org.id, "drinks");
    const posLocal = await createCategory(db, t.org.id, "Local");
    // An adopted product loses its POS category: the IMS has none for it.
    const adopted = await createProduct(db, t.org.id, `${sku}-C`);
    await db.product.update({ where: { id: adopted.id }, data: { categoryId: posLocal.id } });

    const { sync } = await setInventorySource(t.owner, { source: "EXTERNAL" });
    expect(sync?.categories).toEqual({ listed: 6, created: 3, updated: 1, unchanged: 0, archived: 1 });
    expect(sync?.notes).toEqual(expect.arrayContaining([`CATEGORY_FOLDED:${diet.id}`, `CATEGORY_FOLDED:${zero.id}`]));

    const rows = await db.category.findMany({ where: { orgId: t.org.id } });
    const byExt = new Map(rows.map((r) => [r.externalCategoryId, r]));
    expect(byExt.get(drinks.id)).toMatchObject({ id: posDrinks.id, name: "Drinks", parentId: null, isActive: true });
    expect(byExt.get(soft.id)?.parentId).toBe(posDrinks.id);
    expect(byExt.get(cola.id)?.parentId).toBe(byExt.get(soft.id)?.id);
    expect(byExt.has(diet.id)).toBe(false);
    expect(byExt.get(old.id)?.isActive).toBe(false);
    expect(rows.find((r) => r.id === posLocal.id)).toMatchObject({ isActive: false, externalCategoryId: null });

    const product = (id: string) => db.product.findFirstOrThrow({ where: { orgId: t.org.id, externalProductId: id } });
    expect((await product(a.id)).categoryId).toBe(byExt.get(cola.id)?.id);
    expect((await product(b.id)).categoryId).toBe(byExt.get(soft.id)?.id);
    expect((await product(c.id)).categoryId).toBeNull();
  });

  it("re-sync renames, moves and archives categories and re-files products, with audit", async () => {
    const sku = `CR-${shortUpper()}`;
    const food = cat("Food");
    const snacks = cat("Snacks", food.id);
    const gone = cat("Gone");
    const a = { ...simple(`${sku}-A`), categoryId: snacks.id };
    const t = await linkedTenant("Inv Cat Resync", [a]);
    ims.categories = [food, snacks, gone];
    await setInventorySource(t.owner, { source: "EXTERNAL" });

    snacks.name = "Crisps";
    snacks.parentId = null;
    a.categoryId = food.id;
    ims.categories = [food, snacks];
    const summary = await syncInventoryNow(t.owner);
    expect(summary.categories).toEqual({ listed: 2, created: 0, updated: 1, unchanged: 1, archived: 1 });

    const row = await db.category.findFirstOrThrow({ where: { orgId: t.org.id, externalCategoryId: snacks.id } });
    expect(row).toMatchObject({ name: "Crisps", parentId: null });
    const foodRow = await db.category.findFirstOrThrow({ where: { orgId: t.org.id, externalCategoryId: food.id } });
    const product = await db.product.findFirstOrThrow({ where: { orgId: t.org.id, externalProductId: a.id } });
    expect(product.categoryId).toBe(foodRow.id);
    const goneRow = await db.category.findFirstOrThrow({ where: { orgId: t.org.id, externalCategoryId: gone.id } });
    expect(goneRow.isActive).toBe(false);

    const audit = await db.auditEvent.findFirstOrThrow({
      where: { orgId: t.org.id, entityId: row.id, action: "catalog.category.updated" },
    });
    expect(audit.metadata).toMatchObject({ changes: { name: ["Snacks", "Crisps"] }, source: "inventory-sync" });
    expect(
      await db.auditEvent.count({
        where: { orgId: t.org.id, entityId: goneRow.id, action: "catalog.category.archived" },
      }),
    ).toBe(1);

    // The IMS restores it: the POS category comes back.
    gone.archived = false;
    ims.categories = [food, snacks, gone];
    expect((await syncInventoryNow(t.owner)).categories).toMatchObject({ updated: 1, archived: 0 });
    expect((await db.category.findUniqueOrThrow({ where: { id: goneRow.id } })).isActive).toBe(true);
  });

  it("skips a category whose name clashes with a sibling; its products stay uncategorised", async () => {
    const sku = `CC-${shortUpper()}`;
    const upper = cat("Snacks");
    const lower = cat("snacks");
    const a = { ...simple(`${sku}-A`), categoryId: upper.id };
    const b = { ...simple(`${sku}-B`), categoryId: lower.id };
    const t = await linkedTenant("Inv Cat Clash", [a, b]);
    ims.categories = [upper, lower];
    const { sync } = await setInventorySource(t.owner, { source: "EXTERNAL" });
    // Whichever comes second in the IMS's order is skipped.
    expect(sync?.skipped).toHaveLength(1);
    expect(sync?.skipped[0]).toMatchObject({ reason: "CATEGORY_NAME_TAKEN" });
    expect(sync?.categories).toMatchObject({ created: 1 });
    const skipped = sync?.skipped[0].id;
    for (const item of [a, b]) {
      const row = await db.product.findFirstOrThrow({ where: { orgId: t.org.id, externalProductId: item.id } });
      expect(row.categoryId === null).toBe(item.categoryId === skipped);
    }
  });

  it("keeps an already linked category when a rename clashes with a sibling", async () => {
    const sku = `CK-${shortUpper()}`;
    const snacks = cat("Snacks");
    const crisps = cat("Crisps");
    const item = { ...simple(sku), categoryId: snacks.id };
    const t = await linkedTenant("Inv Cat Keep", [item]);
    ims.categories = [snacks, crisps];
    await setInventorySource(t.owner, { source: "EXTERNAL" });
    const row = await db.category.findFirstOrThrow({ where: { orgId: t.org.id, externalCategoryId: snacks.id } });

    // Renamed in the IMS to a sibling's name: the rename is skipped, the category and its products stay.
    snacks.name = "Crisps";
    const sync = await syncInventoryNow(t.owner);
    expect(sync.skipped).toEqual([expect.objectContaining({ id: snacks.id, reason: "CATEGORY_NAME_TAKEN" })]);
    expect(sync.categories).toMatchObject({ archived: 0 });
    expect(await db.category.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      isActive: true,
      name: "Snacks",
    });
    const product = await db.product.findFirstOrThrow({ where: { orgId: t.org.id, externalProductId: item.id } });
    expect(product.categoryId).toBe(row.id);
  });

  it("refuses category writes and product re-filing in a linked shop, not in a built-in one", async () => {
    const t = await linkedTenant("Inv Cat Guard", [simple(`CG-${shortUpper()}`)]);
    const keep = cat("Keep");
    ims.categories = [keep];
    await setInventorySource(t.owner, { source: "EXTERNAL" });
    const row = await db.category.findFirstOrThrow({ where: { orgId: t.org.id, externalCategoryId: keep.id } });
    const at = { expectedUpdatedAt: row.updatedAt.toISOString() };

    await expectAppError(catalog.createCategory(t.owner, { name: "New" }), 409, "MANAGED_BY_INVENTORY");
    await expectAppError(catalog.updateCategory(t.owner, row.id, { name: "X", ...at }), 409, "MANAGED_BY_INVENTORY");
    await expectAppError(catalog.archiveCategory(t.owner, row.id, at), 409, "MANAGED_BY_INVENTORY");
    await expectAppError(catalog.restoreCategory(t.owner, row.id, at), 409, "MANAGED_BY_INVENTORY");

    const product = await db.product.findFirstOrThrow({ where: { orgId: t.org.id, isActive: true } });
    const err = await expectAppError(
      catalog.updateProduct(t.owner, product.id, {
        categoryId: row.id,
        expectedUpdatedAt: product.updatedAt.toISOString(),
      }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    expect((err.details as { fields?: string[] }).fields).toEqual(["categoryId"]);

    const other = await createTenant(db, "Inv Cat Built-in");
    const admin = await createMember(db, other.org.id, "ADMIN");
    await expect(catalog.createCategory(admin, { name: "Local" })).resolves.toMatchObject({ name: "Local" });
  });
});

describe("read-only when linked (spec I18)", () => {
  let linked: Awaited<ReturnType<typeof linkedTenant>>;
  let builtIn: { orgId: string; branchId: string; admin: TenantContext };
  let synced: { id: string; updatedAt: Date };

  beforeAll(async () => {
    ims = fakeIms(KEY);
    vi.stubGlobal("fetch", fakeFetch(ims));
    linked = await linkedTenant("Inv Guard", [simple(`GU-${shortUpper()}`)]);
    await setInventorySource(linked.owner, { source: "EXTERNAL" });
    synced = await db.product.findFirstOrThrow({ where: { orgId: linked.org.id, isActive: true } });
    const other = await createTenant(db, "Inv Guard Built-in");
    builtIn = { orgId: other.org.id, branchId: other.branchA.id, admin: await createMember(db, other.org.id, "ADMIN") };
  });

  it("refuses synced catalog fields but keeps POS-owned ones editable", async () => {
    const at = synced.updatedAt.toISOString();
    const err = await expectAppError(
      catalog.updateProduct(linked.owner, synced.id, { priceMinor: 1, expectedUpdatedAt: at }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    expect((err.details as { fields?: string[] }).fields).toEqual(["priceMinor"]);
    const renamed = await catalog.updateProduct(linked.owner, synced.id, {
      nameAr: "منتج",
      vatCategory: "EXEMPT",
      expectedUpdatedAt: at,
    });
    expect(renamed).toMatchObject({ nameAr: "منتج", vatCategory: "EXEMPT" });
    await expectAppError(
      catalog.createProduct(linked.owner, { sku: `NEW-${shortUpper()}`, name: "New", priceMinor: 100 }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    await expectAppError(
      catalog.archiveProduct(linked.owner, synced.id, { expectedUpdatedAt: renamed.updatedAt }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    await expectAppError(
      catalog.addBarcode(linked.owner, { code: `X${shortUpper()}`, productId: synced.id }),
      409,
      "MANAGED_BY_INVENTORY",
    );
  });

  it("refuses stock and purchasing writes", async () => {
    await expectAppError(
      inventory.recordOpeningBalances(linked.owner, {
        branchId: linked.branchA.id,
        lines: [{ ref: { productId: synced.id, variantId: null }, qty: 3 }],
      }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    await expectAppError(purchasing.createSupplier(linked.owner, { name: "Acme" }), 409, "MANAGED_BY_INVENTORY");
    // Reads keep working.
    await expect(purchasing.listSuppliers(linked.owner)).resolves.toEqual([]);
  });

  it("refuses reorder points and shows no POS stock at the till or in low stock", async () => {
    const ref = { productId: synced.id, variantId: null };
    const branchId = linked.branchA.id;
    await expectAppError(
      inventory.setReorderPoint(linked.owner, { branchId, ref, reorderPoint: 5 }),
      409,
      "MANAGED_BY_INVENTORY",
    );
    // A point set before linking stays in the table but is not reported (POS stock is history only).
    await db.stockBalance.create({ data: { orgId: linked.org.id, branchId, ...ref, qty: 0, reorderPoint: 5 } });
    await expect(inventory.listLowStock(linked.owner, { branchId })).resolves.toEqual({ rows: [], truncated: false });
    await expect(inventory.countLowStock(linked.owner, branchId)).resolves.toBe(0);
    // No warehouse mapped for the branch: the till shows nothing (slice 2 reads the IMS when mapped).
    await expect(getTillOnHand(linked.owner, { branchId, refs: [ref] })).resolves.toEqual([null]);
  });

  it("leaves a built-in shop fully editable", async () => {
    const product = await catalog.createProduct(builtIn.admin, {
      sku: `BI-${shortUpper()}`,
      name: "Local",
      priceMinor: 100,
    });
    await inventory.recordOpeningBalances(builtIn.admin, {
      branchId: builtIn.branchId,
      lines: [{ ref: { productId: product.id, variantId: null }, qty: 2 }],
    });
    await expect(purchasing.createSupplier(builtIn.admin, { name: "Acme" })).resolves.toMatchObject({ name: "Acme" });
  });

  it("switching back to built-in makes the catalog editable again", async () => {
    await setInventorySource(linked.owner, { source: "BUILT_IN" });
    const current = await db.product.findUniqueOrThrow({ where: { id: synced.id } });
    await expect(
      catalog.updateProduct(linked.owner, synced.id, {
        priceMinor: 1,
        expectedUpdatedAt: current.updatedAt.toISOString(),
      }),
    ).resolves.toMatchObject({ priceMinor: 1 });
    expect(current.externalProductId).not.toBeNull();
  });
});
