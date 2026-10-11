import { expect, test, type Page } from "@playwright/test";
import { E2E_FIXTURES, E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { countProductsBySku } from "./support/db";

/** C-17, C-18: uniqueness conflicts are shown inline on the field; a double-clicked Save creates one product. */
test.use({ storageState: storageStateFor("adminA") });

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.toUpperCase();

async function fillNewProduct(page: Page, values: { name: string; sku: string; price: string; barcode?: string }) {
  await page.goto("/catalog/products/new");
  await page.getByRole("textbox", { name: /Name \(English\)/ }).fill(values.name);
  await page.getByRole("textbox", { name: /^SKU/ }).fill(values.sku);
  await page.getByRole("textbox", { name: /^Price/ }).fill(values.price);
  if (values.barcode) {
    const scan = page.getByRole("textbox", { name: "Scan or type barcode" });
    await scan.fill(values.barcode);
    await scan.press("Enter");
    await expect(page.getByText(values.barcode, { exact: true }).filter({ visible: true })).toBeVisible();
  }
}

test("duplicate SKU shows an inline error on the SKU field", async ({ page }) => {
  await fillNewProduct(page, { name: `Dup SKU ${unique()}`, sku: E2E_FIXTURES.arabic.sku, price: "3.00" });
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const sku = page.getByRole("textbox", { name: /^SKU/ });
  await expect(sku).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText(/SKU already used by/).filter({ visible: true })).toBeVisible();
  await expect(page).toHaveURL(/\/catalog\/products\/new$/);
  expect(await countProductsBySku(E2E_ORGS.A.id, E2E_FIXTURES.arabic.sku)).toBe(1);
});

test("duplicate barcode shows an inline error on the barcode field", async ({ page }) => {
  const sku = `E2E-DUPBC-${unique()}`;
  await fillNewProduct(page, {
    name: `Dup barcode ${sku}`,
    sku,
    price: "4.00",
    barcode: E2E_FIXTURES.aOnly.barcode,
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText(/Barcode already assigned to/).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Scan or type barcode" })).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/\/catalog\/products\/new$/);
  expect(await countProductsBySku(E2E_ORGS.A.id, sku)).toBe(0);
});

test("double-clicking Save creates exactly one product", async ({ page }) => {
  const sku = `E2E-DBL-${unique()}`;
  await fillNewProduct(page, { name: `Double click ${sku}`, sku, price: "9.99" });
  await page.getByRole("button", { name: "Save", exact: true }).dblclick();

  await expect(page).toHaveURL(/\/catalog\/products\/[0-9a-f-]{36}\?saved=1/);
  await expect(page.getByRole("heading", { name: "Edit product" })).toBeVisible();
  expect(await countProductsBySku(E2E_ORGS.A.id, sku)).toBe(1);

  await page.goto(`/catalog/products?q=${encodeURIComponent(`Double click ${sku}`)}`);
  await expect(page.getByRole("row").filter({ hasText: sku })).toHaveCount(1);
});
