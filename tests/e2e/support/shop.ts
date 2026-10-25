import { expect, type Page } from "@playwright/test";
import { MESSAGES } from "../../../lib/i18n";
import { e2eQuery, resetLoginRateLimit } from "./db";

const en = MESSAGES.en;
const PASSWORD = "e2e owner password";

/** A short unique suffix for names, SKUs and emails made in one run. */
export const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Sets up a shop of this business type through onboarding, signed in as its owner; returns its ids and email. */
export async function newShop(page: Page, type: string) {
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
