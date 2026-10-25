import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { storageStateFor } from "./support/auth";
import { e2eQuery, resetLoginRateLimit } from "./support/db";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";

/**
 * Business profiles (business-profiles-spec): a fresh owner sets up a shop and switches it to Restaurant / café;
 * the shop then shows the café view. The seeded shops stay retail.
 */

const en = MESSAGES.en;
const PASSWORD = "e2e owner password";
const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const accent = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());

/** Sets up a shop through onboarding; returns its ids and the owner's email. */
async function newShop(page: Page, type: string) {
  const shopName = `Shop ${run()}`;
  const email = `owner-${run()}@example.test`;
  await resetLoginRateLimit();
  await page.goto("/onboarding");
  await page.getByRole("radio", { name: type }).check();
  await page.getByLabel(en["onboarding.shopName"]).fill(shopName);
  await page.getByLabel(en["onboarding.ownerName"]).fill("Owner");
  await page.getByLabel(en["onboarding.email"]).fill(email);
  await page.getByLabel(en["onboarding.password"].replace("{min}", "10")).fill(PASSWORD);
  await page.getByLabel(en["onboarding.confirm"]).fill(PASSWORD);
  await page.getByRole("button", { name: en["onboarding.create"] }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const [shop] = await e2eQuery<{ orgId: string; branchId: string }>(
    `SELECT o."id" AS "orgId", b."id" AS "branchId" FROM "Organization" o JOIN "Branch" b ON b."orgId" = o."id"
      WHERE o."name" = $1`,
    [shopName],
  );
  return { ...shop, email };
}

async function createCategory(orgId: string, name: string): Promise<string> {
  const [row] = await e2eQuery<{ id: string }>(
    `INSERT INTO "Category" ("id", "orgId", "name", "isActive", "sortOrder", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, true, 0, now(), now()) RETURNING "id"`,
    [orgId, name],
  );
  return row.id;
}

test("a café sells from a tile on the till", async ({ browser }) => {
  const page = await (await browser.newContext({ hasTouch: true })).newPage();
  const { orgId, branchId, email } = await newShop(page, "Restaurant / café");
  const drinks = await createCategory(orgId, "Hot drinks");
  await createCategory(orgId, "Desserts");
  const latte = await createRunProduct(orgId, `LAT-${run().toUpperCase()}`, "Latte");
  const long = await createRunProduct(
    orgId,
    `LNG-${run().toUpperCase()}`,
    "Cappuccino with oat milk, cinnamon and an extra shot of espresso",
  );
  for (const id of [latte, long]) {
    await e2eQuery(`UPDATE "Product" SET "categoryId" = $1 WHERE "id" = $2`, [drinks, id]);
    await openRunStock(orgId, branchId, id, 10, email);
  }
  const registerId = await createRunRegister(orgId, branchId, "Bar");

  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await page.getByLabel(/Opening cash in the drawer/).fill("100");
  await page.getByRole("button", { name: "Open shift" }).click();

  const tiles = page.getByTestId("till-tiles");
  await tiles.getByRole("button", { name: "Desserts" }).click();
  await expect(tiles.getByText(en["pos.tiles.empty"])).toBeVisible();
  await tiles.getByRole("button", { name: "Hot drinks" }).click();
  const longTile = tiles.getByRole("button", { name: /Add Cappuccino/ });
  await expect(longTile).toBeVisible();
  expect((await longTile.boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(96);
  // Tiles show on-hand stock like the search results.
  await expect(tiles.getByRole("button", { name: "Add Latte" })).toContainText("On hand: 10");
  // A touch tap keeps the on-screen keyboard down; a mouse click puts the scanner box back in focus.
  const search = page.getByRole("textbox", { name: "Scan or search items" });
  await tiles.getByRole("button", { name: "Add Latte" }).tap();
  await expect(page.getByRole("textbox", { name: "Quantity for Latte" })).toHaveValue("1");
  await expect(search).not.toBeFocused();
  await longTile.click();
  await expect(search).toBeFocused();
  await page.getByRole("button", { name: /^Remove Cappuccino/ }).click();
  await page.getByLabel(/Cash received/).fill("10");
  await page.getByRole("button", { name: /^Charge/ }).click();
  await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
  await expect(page.getByText(/Latte × 1/)).toBeVisible();
});

test("an owner switches a retail shop to Restaurant / café in Settings → Shop", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await newShop(page, "General retail");
  await page.goto("/settings/shop");
  await expect(page.getByRole("radio", { name: "General retail" })).toBeChecked();
  await page.getByRole("radio", { name: "Restaurant / café" }).check();
  // The business type form; the scale-label card below has its own Save.
  const typeForm = page.locator("form", { has: page.getByRole("radio", { name: "Restaurant / café" }) });
  await typeForm.getByRole("button", { name: en["settings.shop.save"] }).click();
  await expect(typeForm.getByRole("status")).toHaveText(en["settings.shop.saved"]);
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
