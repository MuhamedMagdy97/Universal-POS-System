import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";

/** Inventory access by role (T4.8): cashiers see nothing, reporting reads only, anonymous visitors log in. */

test.describe("cashier (no inventory.read)", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("sees the no-access state and no Inventory link", async ({ page }) => {
    await page.goto("/inventory");
    await expect(page.getByRole("heading", { name: "You do not have access to stock" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Inventory" })).toHaveCount(0);
  });
});

test.describe("reporting (read-only stock)", () => {
  test.use({ storageState: storageStateFor("reportingA") });

  test("reads the stock list without any change controls", async ({ page }) => {
    await page.goto(`/inventory?branch=${E2E_ORGS.A.branchId}`);
    await expect(page.getByRole("heading", { name: "Stock", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Adjust" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "New transfer" })).toHaveCount(0);
  });

  test("cannot open the opening-stock grid or the transfer form", async ({ page }) => {
    await page.goto(`/inventory/opening?branch=${E2E_ORGS.A.branchId}`);
    await expect(page.getByRole("heading", { name: "You do not have access to stock" })).toBeVisible();
    await page.goto(`/inventory/transfer?branch=${E2E_ORGS.A.branchId}`);
    await expect(page.getByRole("heading", { name: "You do not have access to stock" })).toBeVisible();
  });
});

test.describe("anonymous visitor", () => {
  test("is sent to sign in", async ({ page }) => {
    await page.goto("/inventory");
    await expect(page).toHaveURL(/\/login/);
  });
});
