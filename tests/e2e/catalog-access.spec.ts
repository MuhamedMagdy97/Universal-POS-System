import { expect, test } from "@playwright/test";
import { E2E_FIXTURES, E2E_ORGS } from "../../prisma/seed-e2e";
import { signIn, storageStateFor } from "./support/auth";
import { productIdBySku } from "./support/db";

/** C-13, C-15, C-16: read-only roles, no-access roles and anonymous visitors. */

test.describe("cashier (products.read only)", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("can browse the list but has no create control", async ({ page }) => {
    await page.goto("/catalog/products");
    await expect(page.getByRole("heading", { name: "Products", level: 1 })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: E2E_FIXTURES.arabic.sku })).toContainText(
      E2E_FIXTURES.arabic.name,
    );
    await expect(page.getByRole("link", { name: "Add product" })).toHaveCount(0);
  });

  test("sees a product read-only, without Save or Archive", async ({ page }) => {
    const id = await productIdBySku(E2E_ORGS.A.id, E2E_FIXTURES.arabic.sku);
    await page.goto(`/catalog/products/${id}`);
    await expect(page.getByText("You can view this product but not change it.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Name \(English\)/ })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: /Name \(English\)/ })).toHaveValue(E2E_FIXTURES.arabic.name);
    await expect(page.getByRole("textbox", { name: /^Price/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    // Cost is hidden without products.update.
    await expect(page.getByRole("textbox", { name: /^Cost/ })).toHaveCount(0);
  });

  test("cannot open the create form", async ({ page }) => {
    await page.goto("/catalog/products/new");
    await expect(page.getByRole("heading", { name: "You don't have access to the catalog" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /^SKU/ })).toHaveCount(0);
  });
});

test.describe("reporting (no products.read)", () => {
  test.use({ storageState: storageStateFor("reportingA") });

  test("sees permission denied and no catalog data", async ({ page }) => {
    await page.goto("/catalog/products");
    await expect(page.getByRole("heading", { name: "You don't have access to the catalog" })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByText(E2E_FIXTURES.arabic.sku)).toHaveCount(0);
  });

  test("gets 403 from the products API", async ({ page }) => {
    const response = await page.request.get("/api/products");
    expect(response.status()).toBe(403);
  });
});

test.describe("anonymous", () => {
  test("catalog pages redirect to login with next", async ({ page }) => {
    await page.goto("/catalog/products/new");
    await expect(page).toHaveURL(/\/login\?next=%2Fcatalog%2Fproducts%2Fnew$/);
  });

  test("signing in returns to the requested catalog page (manager: read-only list)", async ({ page }) => {
    await page.goto("/catalog/products");
    await expect(page).toHaveURL(/\/login\?next=%2Fcatalog%2Fproducts$/);

    await signIn(page, "managerA", "/catalog/products");
    await page.reload();
    await expect(page.getByRole("row").filter({ hasText: E2E_FIXTURES.arabic.sku })).toBeVisible();
    await expect(page.getByRole("link", { name: "Add product" })).toHaveCount(0);
  });
});
