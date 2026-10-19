import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { fakeIms, startFakeIms } from "../support/fake-ims";
import { storageStateFor } from "./support/auth";
import { resetLoginRateLimit } from "./support/db";
import { E2E_BASE_URL, E2E_PORT } from "./support/env";

/**
 * Phase 13 slice 1: an owner links a fresh shop to the inventory system (a fake on E2E_PORT + 1),
 * switches the source, and the synced catalog is read-only, in English and in Arabic (RTL).
 * A fresh shop from onboarding, so the seeded orgs other specs use stay built-in.
 */

const en = MESSAGES.en;
const ar = MESSAGES.ar;
const IMS_PORT = E2E_PORT + 1;
const API_KEY = `ims_e2e_${Date.now().toString(36)}_secret`;
const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SKU = `E2E-INV-${run().toUpperCase()}`;

const ims = fakeIms(API_KEY, [
  {
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    name: "Synced Mango Juice",
    type: "simple",
    status: "active",
    isSerialized: false,
    baseUom: "each",
    variants: [
      {
        id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
        sku: SKU,
        barcode: `${SKU}-BC`,
        name: null,
        status: "active",
        sellPrice: "12.5000",
        costPrice: "7.0000",
      },
    ],
  },
]);

const ENGLISH_PHRASES = Object.entries(en)
  .filter(([key, text]) => !text.includes("{") && text.trim().includes(" ") && ar[key as keyof typeof ar] !== text)
  .map(([, text]) => text);

async function setUpShop(page: Page, id: string) {
  await resetLoginRateLimit();
  await page.goto("/onboarding");
  await page.getByLabel(en["onboarding.shopName"]).fill(`Linked shop ${id}`);
  await page.getByLabel(en["onboarding.ownerName"]).fill("Owner");
  await page.getByLabel(en["onboarding.email"]).fill(`owner-inv-${id}@example.test`);
  await page.getByLabel(en["onboarding.password"].replace("{min}", "10")).fill("e2e owner password");
  await page.getByLabel(en["onboarding.confirm"]).fill("e2e owner password");
  await page.getByRole("button", { name: en["onboarding.create"] }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("an owner links a shop to the inventory system and the synced catalog is read-only (EN, AR)", async ({
  browser,
}) => {
  // Started here, not in beforeAll: with fullyParallel every worker would run a file-level hook on the same port.
  const server = await startFakeIms(ims, IMS_PORT);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setUpShop(page, run());

    await page.goto("/settings/inventory");
    await expect(page.getByRole("heading", { name: en["settings.inventory.title"], exact: true })).toBeVisible();
    await expect(page.getByTestId("inventory-source")).toHaveText(en["settings.inventory.source.BUILT_IN"]);
    await page.getByLabel(en["settings.inventory.baseUrl"]).fill(`http://127.0.0.1:${IMS_PORT}`);
    await page.getByLabel(en["settings.inventory.apiKey"]).fill(API_KEY);
    await page.getByRole("button", { name: en["settings.inventory.save"] }).click();
    await expect(page.getByRole("status")).toHaveText(en["settings.inventory.check.ok"]);
    // The key is write-only: the field is empty again and the page never shows it.
    await expect(page.getByLabel(en["settings.inventory.apiKey"])).toHaveValue("");
    expect(await page.content()).not.toContain(API_KEY);

    await page.getByRole("button", { name: en["settings.inventory.enable"] }).click();
    await page.getByRole("dialog").getByRole("button", { name: en["settings.inventory.confirm"] }).click();
    await expect(page.getByTestId("inventory-source")).toHaveText(en["settings.inventory.source.EXTERNAL"]);
    await expect(page.getByTestId("inventory-sync-status")).toContainText("1 new");
    await page.getByRole("button", { name: en["settings.inventory.sync"], exact: true }).click();
    await expect(page.getByTestId("inventory-sync-status")).toContainText("0 new");
    expect(ims.keysSeen.every((key) => key === API_KEY)).toBe(true);

    await page.goto(`/catalog/products?q=${SKU}`);
    await expect(page.getByTestId("managed-notice")).toHaveText(en["managed.catalog"]);
    await expect(page.getByRole("link", { name: en["catalog.products.add"] })).toHaveCount(0);
    await expect(page).toHaveURL(/\/catalog\/products\/[0-9a-f-]{36}$/);
    await expect(page.getByText(en["catalog.form.readOnly"])).toBeVisible();

    await page.goto("/inventory");
    await expect(page.getByTestId("managed-notice")).toHaveText(en["managed.stock"]);
    await expect(page.getByRole("link", { name: en["inventory.action.opening"] })).toHaveCount(0);

    await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
    await page.goto("/settings/inventory");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: ar["settings.inventory.title"], exact: true })).toBeVisible();
    await expect(page.getByTestId("inventory-source")).toHaveText(ar["settings.inventory.source.EXTERNAL"]);
    const text = await page.locator("main").innerText();
    expect(ENGLISH_PHRASES.filter((phrase) => text.includes(phrase))).toEqual([]);
    await page.goto("/catalog/products");
    await expect(page.getByTestId("managed-notice")).toHaveText(ar["managed.catalog"]);
  } finally {
    await context.close();
    server.close();
  }
});

test.describe("access", () => {
  test("an admin sees the status but cannot change the link", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStateFor("adminA") });
    const page = await context.newPage();
    await page.goto("/settings/inventory");
    await expect(page.getByTestId("inventory-source")).toHaveText(en["settings.inventory.source.BUILT_IN"]);
    await expect(page.getByText(en["settings.inventory.ownerOnly"])).toBeVisible();
    await expect(page.getByLabel(en["settings.inventory.apiKey"])).toHaveCount(0);
    await context.close();
  });

  test("a cashier is refused", async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStateFor("cashierA") });
    const page = await context.newPage();
    await page.goto("/settings/inventory");
    await expect(page.getByRole("heading", { name: en["settings.state.forbidden"] })).toBeVisible();
    await context.close();
  });
});
