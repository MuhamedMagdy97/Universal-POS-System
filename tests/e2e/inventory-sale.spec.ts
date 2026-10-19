import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { fakeIms, startFakeIms } from "../support/fake-ims";
import { resetLoginRateLimit } from "./support/db";
import { E2E_BASE_URL, E2E_PORT } from "./support/env";

/**
 * Phase 13 slice 2: a linked shop sells at the till. The owner links a fresh shop to the inventory
 * system (a fake on E2E_PORT + 2), maps its branch to a warehouse and switches; the till shows the
 * IMS's stock, a sale takes it in the IMS, an outage refuses the sale with the I17 message (Arabic,
 * RTL) and Retry sells once the IMS is back.
 */

const en = MESSAGES.en;
const ar = MESSAGES.ar;
const IMS_PORT = E2E_PORT + 2;
const API_KEY = `ims_e2e_sale_${Date.now().toString(36)}_secret`;
const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SKU = `E2E-SALE-${run().toUpperCase()}`;
const NAME = `Synced Dates ${SKU}`;
const VARIANT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b6c";
const WAREHOUSE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b7d";

const ims = fakeIms(API_KEY, [
  {
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b5b",
    name: NAME,
    type: "simple",
    status: "active",
    isSerialized: false,
    baseUom: "each",
    variants: [
      {
        id: VARIANT,
        sku: SKU,
        barcode: `${SKU}-BC`,
        name: null,
        status: "active",
        sellPrice: "10.0000",
        costPrice: "6.0000",
      },
    ],
  },
]);
ims.warehouses = [{ id: WAREHOUSE, code: "W1", name: "Main warehouse", status: "active" }];
ims.stock.set(`${VARIANT}|${WAREHOUSE}`, 5);
const imsOnHand = () => ims.stock.get(`${VARIANT}|${WAREHOUSE}`);

async function setUpShop(page: Page, id: string) {
  await resetLoginRateLimit();
  await page.goto("/onboarding");
  await page.getByLabel(en["onboarding.shopName"]).fill(`Selling shop ${id}`);
  await page.getByLabel(en["onboarding.ownerName"]).fill("Owner");
  await page.getByLabel(en["onboarding.email"]).fill(`owner-sale-${id}@example.test`);
  await page.getByLabel(en["onboarding.password"].replace("{min}", "10")).fill("e2e owner password");
  await page.getByLabel(en["onboarding.confirm"]).fill("e2e owner password");
  await page.getByRole("button", { name: en["onboarding.create"] }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("a linked shop sells at the till, is refused during an outage, and sells again (EN, AR)", async ({ browser }) => {
  const server = await startFakeIms(ims, IMS_PORT);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await setUpShop(page, run());

    // Link, map the branch to the warehouse, switch.
    await page.goto("/settings/inventory");
    await page.getByLabel(en["settings.inventory.baseUrl"]).fill(`http://127.0.0.1:${IMS_PORT}`);
    await page.getByLabel(en["settings.inventory.apiKey"]).fill(API_KEY);
    await page.getByRole("button", { name: en["settings.inventory.save"] }).click();
    await expect(page.getByRole("status")).toHaveText(en["settings.inventory.check.ok"]);
    await expect(page.getByRole("heading", { name: en["settings.inventory.branches"] })).toBeVisible();
    await page.getByRole("combobox").selectOption({ label: "W1 · Main warehouse" });
    await page.getByRole("button", { name: en["settings.inventory.branches.save"] }).click();
    await expect(page.getByRole("status")).toHaveText(en["settings.inventory.branches.saved"]);
    await page.getByRole("button", { name: en["settings.inventory.enable"] }).click();
    await page.getByRole("dialog").getByRole("button", { name: en["settings.inventory.confirm"] }).click();
    await expect(page.getByTestId("inventory-source")).toHaveText(en["settings.inventory.source.EXTERNAL"]);

    // The till shows the IMS's stock and the sale takes one unit there.
    await page.goto("/pos");
    await page.getByLabel(en["pos.shift.float"]).fill("0");
    await page.getByRole("button", { name: en["pos.shift.open"] }).click();
    const search = page.getByRole("textbox", { name: en["pos.search.label"] });
    await search.fill(SKU);
    await search.press("Enter");
    await expect(page.getByTestId("till-stock").first()).toHaveText(en["pos.stock.onHand"].replace("{qty}", "5"));
    await page.getByLabel(en["pos.pay.received"]).fill("10");
    await page.getByRole("button", { name: /^Charge/ }).click();
    await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
    await expect.poll(imsOnHand).toBe(4);
    expect(ims.reservations.size).toBe(1);

    // In Arabic: the IMS stops, the sale is refused with the outage message and nothing is taken.
    await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
    await page.goto("/pos");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const searchAr = page.getByRole("textbox", { name: ar["pos.search.label"] });
    await searchAr.fill(SKU);
    await searchAr.press("Enter");
    await expect(page.getByTestId("till-stock").first()).toHaveText(ar["pos.stock.onHand"].replace("{qty}", "4"));
    await page.getByLabel(ar["pos.pay.received"]).fill("10");
    ims.down = "503";
    const charge = page.getByRole("button", { name: new RegExp(`^${ar["pos.pay.charge"].split(" ")[0]}`) });
    await charge.click();
    await expect(page.getByRole("alert").filter({ hasText: ar["pos.error.inventoryUnavailable"] })).toBeVisible();
    expect(imsOnHand()).toBe(4);

    // Back up: the same cart and key go through.
    ims.down = false;
    await charge.click();
    await expect(page.getByRole("heading", { name: /\d{6}/ })).toBeVisible();
    await expect.poll(imsOnHand).toBe(3);
    expect(ims.keysSeen.every((key) => key === API_KEY)).toBe(true);
    expect(await page.content()).not.toContain(API_KEY);
  } finally {
    await context.close();
    server.close();
  }
});
