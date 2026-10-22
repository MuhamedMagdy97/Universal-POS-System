import { expect, test } from "@playwright/test";
import { storageStateFor } from "./support/auth";

/** CSV import: upload → preview with row errors → upload a fixed file → confirm → products listed. */
test.use({ storageState: storageStateFor("adminA") });

test("admin imports products from a CSV after fixing a row error", async ({ page }) => {
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
  const file = (rows: string[]) => ({
    name: "products.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`﻿name,sku,price\r\n${rows.join("\r\n")}\r\n`, "utf8"),
  });

  await page.goto("/catalog/products");
  await page.getByRole("link", { name: "Import CSV" }).click();
  await expect(page).toHaveURL(/\/catalog\/products\/import$/);
  await expect(page.getByRole("heading", { name: "Import products" })).toBeVisible();

  const input = page.getByLabel("CSV file");
  await input.setInputFiles(
    file([`"Import Tea, green ${run}",E2E-IM-A-${run},4.50`, `Import Bad ${run},E2E-IM-B-${run},abc`]),
  );
  await expect(page.getByText("1 rows ready, 1 with errors")).toBeVisible();
  const badRow = page.getByRole("row").filter({ hasText: `E2E-IM-B-${run}` });
  await expect(badRow).toContainText("price: enter an amount like 12.50");
  await expect(page.getByRole("button", { name: /^Import \d+ products$/ })).toHaveCount(0);

  await input.setInputFiles(
    file([`"Import Tea, green ${run}",E2E-IM-A-${run},4.50`, `Import Good ${run},E2E-IM-B-${run},3`]),
  );
  await expect(page.getByText("2 rows ready, 0 with errors")).toBeVisible();
  await page.getByRole("button", { name: "Import 2 products" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Imported 2 products." })).toBeVisible();

  await page.getByRole("link", { name: "View products" }).click();
  await expect(page).toHaveURL(/\/catalog\/products$/);
  await page.goto(`/catalog/products?q=${run}`);
  await expect(page.getByRole("row").filter({ hasText: `E2E-IM-A-${run}` })).toContainText(`Import Tea, green ${run}`);
  await expect(page.getByRole("row").filter({ hasText: `E2E-IM-B-${run}` })).toContainText("EGP 3.00");
});
