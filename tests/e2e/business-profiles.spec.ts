import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { storageStateFor } from "./support/auth";
import { resetLoginRateLimit } from "./support/db";

/**
 * Business profiles (business-profiles-spec): a fresh owner sets up a shop and switches it to Restaurant / café;
 * the shop then shows the café view. The seeded shops stay retail.
 */

const en = MESSAGES.en;
const PASSWORD = "e2e owner password";
const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const accent = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());

async function newShop(page: Page, type: string) {
  await resetLoginRateLimit();
  await page.goto("/onboarding");
  await page.getByRole("radio", { name: type }).check();
  await page.getByLabel(en["onboarding.shopName"]).fill(`Shop ${run()}`);
  await page.getByLabel(en["onboarding.ownerName"]).fill("Owner");
  await page.getByLabel(en["onboarding.email"]).fill(`owner-${run()}@example.test`);
  await page.getByLabel(en["onboarding.password"].replace("{min}", "10")).fill(PASSWORD);
  await page.getByLabel(en["onboarding.confirm"]).fill(PASSWORD);
  await page.getByRole("button", { name: en["onboarding.create"] }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("an owner switches a retail shop to Restaurant / café in Settings → Shop", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await newShop(page, "General retail");
  await page.goto("/settings/shop");
  await expect(page.getByRole("radio", { name: "General retail" })).toBeChecked();
  await page.getByRole("radio", { name: "Restaurant / café" }).check();
  await page.getByRole("button", { name: en["settings.shop.save"] }).click();
  await expect(page.getByRole("status")).toHaveText(en["settings.shop.saved"]);
  await page.reload();
  await expect(page.getByRole("radio", { name: "Restaurant / café" })).toBeChecked();

  // The café view: coral accent, "Menu items" in the nav, on the products page and its add button.
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/dashboard");
  await expect.poll(() => accent(page)).toBe("#c2410c");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Menu items" })).toBeVisible();
  await nav.getByRole("link", { name: "Menu items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Menu items" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add menu item" }).first()).toBeVisible();

  // The café dashboard: average ticket and top items today.
  await page.goto("/dashboard");
  await expect(page.getByText(en["dashboard.tile.averageTicket"])).toBeVisible();
  await expect(page.getByText(en["dashboard.tile.topItems"])).toBeVisible();
  await expect(page.getByText(en["dashboard.tile.topEmpty"])).toBeVisible();
  await expect(page.getByText(en["dashboard.tile.refunds"])).toHaveCount(0);
});

test.describe("retail admin", () => {
  test.use({ storageState: storageStateFor("adminA") });

  test("keeps the retail view", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/dashboard");
    await expect.poll(() => accent(page)).toBe("#1d5fd1");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Catalog" })).toBeVisible();
    await page.goto("/catalog/products");
    await expect(page.getByRole("heading", { level: 1, name: "Products" })).toBeVisible();
  });
});

test.describe("cashier", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("cannot open the Shop setting", async ({ page }) => {
    await page.goto("/settings/shop");
    await expect(page.getByRole("heading", { name: "You cannot change settings" })).toBeVisible();
  });
});
