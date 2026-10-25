import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { e2eQuery, resetLoginRateLimit } from "./support/db";
import { E2E_BASE_URL } from "./support/env";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, onHand, openRunStock } from "./support/pos";

/**
 * Weighed selling (weighed-selling-spec W5, W8, W9): a fresh grocery shop sells tomatoes at EGP 12.00 per kg by
 * weight, steps the weight with +, refunds part of it, and the till reads in Arabic.
 */

const en = MESSAGES.en;
const PASSWORD = "e2e owner password";
const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function groceryShop(page: Page) {
  const shopName = `Grocer ${run()}`;
  const email = `owner-${run()}@example.test`;
  await resetLoginRateLimit();
  await page.goto("/onboarding");
  await page.getByRole("radio", { name: /Grocery/ }).check();
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
  const sku = `TOM-${run().toUpperCase()}`;
  const productId = await createRunProduct(shop.orgId, sku, "Tomatoes");
  await e2eQuery(`UPDATE "Product" SET "unitType" = 'KG', "priceMinor" = 1200, "nameAr" = 'طماطم' WHERE "id" = $1`, [
    productId,
  ]);
  await openRunStock(shop.orgId, shop.branchId, productId, 10_000, email);
  const registerId = await createRunRegister(shop.orgId, shop.branchId, "Scale till");
  return { ...shop, sku, productId, registerId };
}

test("a grocery sells by weight, steps the weight and refunds part of it", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { orgId, branchId, sku, productId, registerId } = await groceryShop(page);

  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await page.getByLabel(/Opening cash in the drawer/).fill("100");
  await page.getByRole("button", { name: "Open shift" }).click();

  const search = page.getByRole("textbox", { name: "Scan or search items" });
  await search.fill(sku);
  await search.press("Enter");
  // A weighed item asks for its weight first.
  const weight = page.getByTestId("weight-box").getByLabel(en["pos.weight.label"]);
  await expect(weight).toBeFocused();
  await weight.fill("0.7505");
  await weight.press("Enter");
  await expect(page.getByTestId("weight-box").getByRole("alert")).toBeVisible();
  await weight.fill("0.750");
  await weight.press("Enter");

  const qty = page.getByRole("textbox", { name: "Quantity for Tomatoes" });
  await expect(qty).toHaveValue("0.750");
  await expect(page.getByTestId("till-total")).toContainText("9.00");
  // + steps 0.1 kg on the selected line.
  await search.focus();
  await page.keyboard.press("+");
  await expect(qty).toHaveValue("0.850");
  await expect(page.getByTestId("till-total")).toContainText("10.20");

  await page.getByLabel(/Cash received/).fill("20");
  await page.getByRole("button", { name: /^Charge/ }).click();
  const heading = page.getByRole("heading", { name: /^Sale \d{6}$/ });
  await expect(heading).toBeVisible();
  await expect(page.getByText(/Tomatoes × 0\.850 kg/)).toBeVisible();
  expect(await onHand(orgId, branchId, productId)).toBe(9_150);
  const number = ((await heading.textContent()) ?? "").replace(/\D/g, "");

  // Refund 0.250 kg: 10.20 × 250 / 850 = 3.00.
  await page.goto("/returns");
  await page.getByLabel("Receipt number").fill(String(Number(number)));
  await page.getByRole("button", { name: "Find sale" }).click();
  await page.getByRole("textbox", { name: "Refund quantity for Tomatoes" }).fill("0.250");
  await expect(page.getByTestId("refund-total")).toContainText("3.00");
  await page.getByLabel("Reason", { exact: true }).fill("Bruised");
  await page.getByRole("button", { name: /^Refund EGP/ }).click();
  await expect(page.getByTestId("returns-message")).toContainText("Refunded EGP 3.00.");
  await expect(page.getByTestId(`refunded-${sku}`)).toHaveText("0.250 kg");
  expect(await onHand(orgId, branchId, productId)).toBe(9_400);

  // The till in Arabic shows the weight in كجم.
  await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  const searchAr = page.getByRole("textbox", { name: MESSAGES.ar["pos.search.label"] });
  await searchAr.fill(sku);
  await searchAr.press("Enter");
  await page.getByTestId("weight-box").getByLabel(MESSAGES.ar["pos.weight.label"]).fill("1.5");
  await page.getByTestId("weight-box").getByLabel(MESSAGES.ar["pos.weight.label"]).press("Enter");
  await expect(page.getByTestId("till-stock").first()).toContainText("كجم");
  await context.close();
});
