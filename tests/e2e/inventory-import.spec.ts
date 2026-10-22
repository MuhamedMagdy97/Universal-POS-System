import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";

/** Stock CSV import: opening stock from a file, then an adjustment file with a row error fixed. */
test.use({ storageState: storageStateFor("adminA") });

const MAIN = E2E_ORGS.A.branchId;

test("admin imports opening stock and an adjustment from CSV files", async ({ page }) => {
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
  const sku = `E2E-SI-${run}`;
  await createRunProduct(E2E_ORGS.A.id, sku, `Import Stock ${run}`);
  const file = (header: string, rows: string[]) => ({
    name: "stock.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`﻿${header}\r\n${rows.join("\r\n")}\r\n`, "utf8"),
  });

  await page.goto(`/inventory?branch=${MAIN}`);
  await page.getByRole("link", { name: "Import CSV" }).click();
  await expect(page).toHaveURL(/\/inventory\/import\?branch=/);
  await expect(page.getByRole("heading", { name: /^Import stock/ })).toBeVisible();

  // Opening stock: 8 units.
  const input = page.getByLabel("CSV file");
  await input.setInputFiles(file("sku,qty", [`${sku},8`]));
  await expect(page.getByText("1 rows ready, 0 with errors")).toBeVisible();
  await page.getByRole("button", { name: "Apply 1 rows" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Stock updated. Rows: 1" })).toBeVisible();

  // Adjustment: a row that would go below zero is shown, then the fixed file is applied.
  await page.getByLabel("Adjustments").check();
  await input.setInputFiles(file("sku,qty,reason", [`${sku},-9,DAMAGED`]));
  await expect(page.getByText("0 rows ready, 1 with errors")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: sku })).toContainText("qty: stock would go below zero");
  await expect(page.getByRole("button", { name: /^Apply/ })).toHaveCount(0);

  await input.setInputFiles(file("sku,qty,reason", [`${sku},-2,DAMAGED`]));
  await expect(page.getByRole("row").filter({ hasText: sku })).toContainText("Ready");
  await page.getByRole("button", { name: "Apply 1 rows" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Stock updated. Rows: 1" })).toBeVisible();

  await page.getByRole("link", { name: "View stock" }).click();
  await page.goto(`/inventory?branch=${MAIN}&q=${sku}`);
  await expect(page.getByRole("row").filter({ hasText: sku }).getByRole("cell").nth(2)).toHaveText("6");
});
