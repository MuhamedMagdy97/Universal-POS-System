import { expect, test } from "@playwright/test";
import { E2E_FIXTURES, E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { productIdBySku } from "./support/db";

/** C-8, C-9, C-10: Org B never sees Org A's catalog, even with shared SKU/barcode values. */
test.use({ storageState: storageStateFor("adminB") });

test("searching an Org A-only SKU or barcode finds nothing", async ({ page }) => {
  await page.goto(`/catalog/products?q=${encodeURIComponent(E2E_FIXTURES.aOnly.sku)}`);
  await expect(page.getByText(`No match for “${E2E_FIXTURES.aOnly.sku}”`)).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);

  await page.goto(`/catalog/products?q=${encodeURIComponent(E2E_FIXTURES.aOnly.barcode)}`);
  await expect(page.getByText(`No match for “${E2E_FIXTURES.aOnly.barcode}”`)).toBeVisible();
});

test("the shared SKU and barcode resolve to Org B's own product", async ({ page }) => {
  const { sku, barcode, nameA, nameB } = E2E_FIXTURES.shared;
  const ownId = await productIdBySku(E2E_ORGS.B.id, sku);

  await page.goto(`/catalog/products?q=${encodeURIComponent(sku)}`);
  await expect(page).toHaveURL(`/catalog/products/${ownId}`);
  await expect(page.getByRole("textbox", { name: /Name \(English\)/ })).toHaveValue(nameB);
  await expect(page.getByRole("textbox", { name: /^Price/ })).toHaveValue("9.00");
  await expect(page.getByText("Price (SAR)")).toBeVisible();

  await page.goto(`/catalog/products?q=${encodeURIComponent(barcode)}`);
  await expect(page).toHaveURL(`/catalog/products/${ownId}`);

  await page.goto("/catalog/products?status=all");
  await expect(page.getByRole("row").filter({ hasText: nameA })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: E2E_FIXTURES.arabic.sku })).toHaveCount(0);
});

test("opening an Org A product URL shows not found", async ({ page }) => {
  const foreignId = await productIdBySku(E2E_ORGS.A.id, E2E_FIXTURES.aOnly.sku);
  await page.goto(`/catalog/products/${foreignId}`);
  await expect(page.getByRole("heading", { name: "Product not found" })).toBeVisible();
  await expect(page.getByText(E2E_FIXTURES.aOnly.name)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^SKU/ })).toHaveCount(0);

  const response = await page.request.get(`/api/products/${foreignId}`);
  expect(response.status()).toBe(404);
});
