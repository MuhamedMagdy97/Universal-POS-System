import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import * as inventory from "@/modules/inventory";
import { createMember, createProduct, createTenant, expectReconciled, testDb } from "./helpers";

/** Stock in kg (weighed-selling-spec W7): imported and listed as grams, shown and exported as kg. */

let db: Db;
let orgId: string;
let branchId: string;
let admin: TenantContext;
let rice: { id: string; sku: string };
let pens: { id: string; sku: string };

const csv = (...lines: string[]) => `﻿${lines.join("\r\n")}\r\n`;

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "WeighedStock");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  admin = await createMember(db, orgId, "ADMIN");
  rice = await createProduct(db, orgId);
  await db.product.update({ where: { id: rice.id }, data: { unitType: "KG", name: "Rice" } });
  pens = await createProduct(db, orgId);
});

afterAll(async () => {
  await expectReconciled(db, orgId);
  await db.$disconnect();
});

describe("stock in kg", () => {
  it("imports kg with up to 3 decimals as grams and refuses more", async () => {
    const preview = await inventory.previewStockImport(admin, {
      branchId,
      mode: "opening",
      csv: csv("sku,qty", `${rice.sku},12.5`, `${pens.sku},1.5`),
    });
    expect(preview.rows[0]).toMatchObject({ unitType: "KG", qty: 12_500, errors: [] });
    expect(preview.rows[1].errors.map((e) => e.code)).toEqual(["qtyInvalid"]);

    await inventory.importStock(admin, {
      branchId,
      mode: "opening",
      csv: csv("sku,qty", `${rice.sku},12.5`, `${pens.sku},4`),
      importId: randomUUID(),
    });
    const adjust = await inventory.previewStockImport(admin, {
      branchId,
      mode: "adjustment",
      csv: csv("sku,qty,reason", `${rice.sku},-0.250,DAMAGED`),
    });
    expect(adjust.rows[0]).toMatchObject({ qty: -250, after: 12_250, errors: [] });
  });

  it("lists the unit with the stock and exports low stock in kg", async () => {
    const page = await inventory.listStock(admin, { branchId });
    expect(page.rows.find((row) => row.productId === rice.id)).toMatchObject({ unitType: "KG", qty: 12_500 });
    await inventory.setReorderPoint(admin, { branchId, ref: { productId: rice.id }, reorderPoint: 20_000 });
    const { body } = await inventory.exportLowStockCsv(admin, { branchId }, "en");
    expect(body).toContain("12.500 kg");
    expect(body).toContain("7.500 kg");
  });
});
