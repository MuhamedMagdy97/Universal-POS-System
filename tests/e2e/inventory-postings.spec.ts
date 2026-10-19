import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { fakeIms, startFakeIms } from "../support/fake-ims";
import { resetLoginRateLimit } from "./support/db";
import { E2E_BASE_URL, E2E_PORT } from "./support/env";

/**
 * Phase 13 slice 4: a linked shop sells while the inventory system refuses the fulfil (a fake on
 * E2E_PORT + 3). Settings → Inventory system lists the refused posting with its sale number; in
 * Arabic (RTL) the owner presses Retry once the IMS accepts it, and the stock is taken there.
 */

const en = MESSAGES.en;
const ar = MESSAGES.ar;
const IMS_PORT = E2E_PORT + 3;
const API_KEY = `ims_e2e_postings_${Date.now().toString(36)}_secret`;
const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SKU = `E2E-POST-${run().toUpperCase()}`;
const VARIANT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c6c";
const WAREHOUSE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c7d";

const ims = fakeIms(API_KEY, [
  {
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c5b",
    name: `Synced Figs ${SKU}`,
    type: "simple",
    status: "active",
    isSerialized: false,
    baseUom: "each",
    variants: [
      { id: VARIANT, sku: SKU, barcode: `${SKU}-BC`, name: null, status: "active", sellPrice: "10", costPrice: "6" },
    ],
  },
]);
ims.warehouses = [{ id: WAREHOUSE, code: "W1", name: "Main warehouse", status: "active" }];
ims.stock.set(`${VARIANT}|${WAREHOUSE}`, 5);
const imsOnHand = () => ims.stock.get(`${VARIANT}|${WAREHOUSE}`);

test("a refused posting is listed and Retry sends it (EN, AR)", async ({ browser }) => {
  const server = await startFakeIms(ims, IMS_PORT);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const id = run();
    await resetLoginRateLimit();
    await page.goto("/onboarding");
    await page.getByLabel(en["onboarding.shopName"]).fill(`Posting shop ${id}`);
    await page.getByLabel(en["onboarding.ownerName"]).fill("Owner");
    await page.getByLabel(en["onboarding.email"]).fill(`owner-postings-${id}@example.test`);
    await page.getByLabel(en["onboarding.password"].replace("{min}", "10")).fill("e2e owner password");
    await page.getByLabel(en["onboarding.confirm"]).fill("e2e owner password");
    await page.getByRole("button", { name: en["onboarding.create"] }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    // Link, map the branch, switch.
    await page.goto("/settings/inventory");
    await page.getByLabel(en["settings.inventory.baseUrl"]).fill(`http://127.0.0.1:${IMS_PORT}`);
    await page.getByLabel(en["settings.inventory.apiKey"]).fill(API_KEY);
    await page.getByRole("button", { name: en["settings.inventory.save"] }).click();
    await expect(page.getByRole("status")).toHaveText(en["settings.inventory.check.ok"]);
    await page.getByRole("combobox").selectOption({ label: "W1 · Main warehouse" });
    await page.getByRole("button", { name: en["settings.inventory.branches.save"] }).click();
    await expect(page.getByRole("status")).toHaveText(en["settings.inventory.branches.saved"]);
    await page.getByRole("button", { name: en["settings.inventory.enable"] }).click();
    await page.getByRole("dialog").getByRole("button", { name: en["settings.inventory.confirm"] }).click();
    await expect(page.getByTestId("inventory-source")).toHaveText(en["settings.inventory.source.EXTERNAL"]);
    await expect(page.getByTestId("inventory-postings-list")).toHaveCount(0);

    // Sell while the IMS refuses the fulfil: the sale completes, the posting is refused.
    ims.intercept = (_method, path) =>
      path.endsWith("/fulfil")
        ? { status: 422, body: { code: "validation_failed", message: "no", details: null } }
        : undefined;
    await page.goto("/pos");
    await page.getByLabel(en["pos.shift.float"]).fill("0");
    await page.getByRole("button", { name: en["pos.shift.open"] }).click();
    const search = page.getByRole("textbox", { name: en["pos.search.label"] });
    await search.fill(SKU);
    await search.press("Enter");
    await page.getByLabel(en["pos.pay.received"]).fill("10");
    await page.getByRole("button", { name: /^Charge/ }).click();
    const heading = page.getByRole("heading", { name: /^Sale \d{6}$/ });
    await expect(heading).toBeVisible();
    const saleNumber = ((await heading.textContent()) ?? "").replace(/\D/g, "");
    expect(imsOnHand()).toBe(5);

    await page.goto("/settings/inventory");
    const list = page.getByTestId("inventory-postings-list");
    const row = list.getByRole("row").filter({ hasText: saleNumber });
    await expect(row).toContainText(en["settings.inventory.postingsList.kind.FULFIL"]);
    await expect(row).toContainText(en["settings.inventory.postingsList.status.FAILED"]);
    await expect(row).toContainText("validation_failed");

    // In Arabic: the IMS accepts it now; Retry sends it and the list empties.
    ims.intercept = undefined;
    await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
    await page.goto("/settings/inventory");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: ar["settings.inventory.postingsList"] })).toBeVisible();
    await expect(list.getByRole("row").filter({ hasText: saleNumber })).toContainText(
      ar["settings.inventory.postingsList.status.FAILED"],
    );
    await list.getByRole("button", { name: ar["settings.inventory.postingsList.retry"] }).click();
    await expect(
      page.getByRole("status").filter({ hasText: ar["settings.inventory.postingsList.retried.DONE"] }),
    ).toBeVisible();
    await expect.poll(imsOnHand).toBe(4);
    await expect(page.getByTestId("inventory-postings-list")).toHaveCount(0);
    expect(await page.content()).not.toContain(API_KEY);
  } finally {
    await context.close();
    server.close();
  }
});
