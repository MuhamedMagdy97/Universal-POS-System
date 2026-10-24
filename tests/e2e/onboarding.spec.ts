import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { E2E_BASE_URL } from "./support/env";
import { resetLoginRateLimit } from "./support/db";

/**
 * Onboarding spec acceptance 1, 3, 5 and 6: a fresh owner sets up a shop from the Welcome page,
 * adds a branch, a till and a cashier; the cashier signs in and is signed out on deactivation.
 */

const PASSWORD = "e2e owner password";
const en = MESSAGES.en;
const ar = MESSAGES.ar;

const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** English UI phrases (two words or more, no placeholders) that must not show on an Arabic screen. */
const ENGLISH_PHRASES = Object.entries(en)
  .filter(([key, text]) => !text.includes("{") && text.trim().includes(" ") && ar[key as keyof typeof ar] !== text)
  .map(([, text]) => text);

async function expectArabic(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const text = await page.locator("main").innerText();
  expect(ENGLISH_PHRASES.filter((phrase) => text.includes(phrase))).toEqual([]);
}

async function setUpShop(page: Page, m: typeof en | typeof ar, shopName: string, email: string) {
  await resetLoginRateLimit();
  await page.goto("/onboarding");
  await page.getByLabel(m["onboarding.shopName"]).fill(shopName);
  await page.getByLabel(m["onboarding.ownerName"]).fill("Owner");
  await page.getByLabel(m["onboarding.email"]).fill(email);
  await page.getByLabel(m["onboarding.password"].replace("{min}", "10")).fill(PASSWORD);
  await page.getByLabel(m["onboarding.confirm"]).fill(PASSWORD);
  await page.getByRole("button", { name: m["onboarding.create"] }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test("an owner sets up a shop, adds a branch, a till and a cashier, and deactivates the cashier", async ({
  browser,
}) => {
  const id = run();
  const shopName = `Shop ${id}`;
  const cashierEmail = `cashier-${id}@example.test`;
  const owner = await (await browser.newContext()).newPage();

  await owner.goto("/welcome");
  await owner.getByRole("link", { name: "Set up a new business" }).click();
  await expect(owner).toHaveURL(/\/onboarding$/);
  await expect(owner.getByRole("radio", { name: "General retail" })).toBeChecked();
  await expect(owner.getByRole("radio", { name: /Grocery/ })).toBeEnabled();
  await setUpShop(owner, en, shopName, `owner-${id}@example.test`);
  await expect(owner.getByRole("banner")).toContainText(shopName);

  // A second branch, and a second till at Main.
  await owner.getByRole("link", { name: en["settings.nav"] }).click();
  await owner.getByRole("link", { name: en["settings.tab.branches"] }).click();
  await owner.getByRole("button", { name: en["branches.add"] }).click();
  await owner.getByRole("textbox", { name: en["branches.name"], exact: true }).fill("North");
  await owner.getByRole("textbox", { name: en["branches.code"], exact: true }).fill("nrt");
  await owner.getByRole("button", { name: en["branches.save"] }).click();
  await expect(owner.getByRole("heading", { name: "North" })).toBeVisible();
  const main = owner.getByRole("listitem").filter({ has: owner.getByRole("heading", { name: "Main" }) });
  await main.getByRole("button", { name: en["branches.addTill"] }).click();
  await owner.getByRole("textbox", { name: en["branches.tillName"], exact: true }).fill("Till 2");
  await owner.getByRole("button", { name: en["branches.save"] }).click();
  await expect(main.getByText("Till 2")).toBeVisible();

  // A cashier login for all branches.
  await owner.getByRole("link", { name: en["settings.tab.staff"] }).click();
  await owner.getByRole("button", { name: en["staff.add"] }).click();
  await owner.getByRole("textbox", { name: en["staff.name"], exact: true }).fill("Casey");
  await owner.getByRole("textbox", { name: en["staff.email"], exact: true }).fill(cashierEmail);
  await owner
    .getByRole("textbox", { name: en["staff.tempPassword"].replace("{min}", "10"), exact: true })
    .fill(PASSWORD);
  await owner.getByRole("combobox", { name: en["staff.role"], exact: true }).selectOption("CASHIER");
  await owner.getByRole("button", { name: en["staff.add"] }).click();
  await expect(owner.getByRole("status")).toContainText(cashierEmail);

  // The hidden onboarding page stays mounted, so these queries go by role (visible elements only).
  // The cashier signs in and sees both branches and both tills on the till screen.
  await resetLoginRateLimit();
  const cashier = await (await browser.newContext()).newPage();
  await cashier.goto("/login");
  await cashier.getByLabel("Email").fill(cashierEmail);
  await cashier.getByLabel("Password").fill(PASSWORD);
  await cashier.getByRole("button", { name: "Sign in" }).click();
  await expect(cashier).toHaveURL(/\/dashboard$/);
  await expect(cashier.getByRole("link", { name: en["settings.nav"] })).toHaveCount(0);
  await cashier.goto("/pos");
  await expect(cashier.getByLabel(en["pos.branch"]).locator("option")).toHaveText(["Main (MAIN)", "North (NRT)"]);
  await expect(cashier.getByLabel(en["pos.register"]).locator("option")).toHaveText(["Till 1", "Till 2"]);

  // Deactivation signs the cashier out at once.
  const row = owner.getByRole("row").filter({ hasText: cashierEmail });
  await row.getByRole("button", { name: en["staff.deactivate"] }).click();
  await expect(row).toContainText(en["staff.inactive"]);
  await cashier.reload();
  await expect(cashier).toHaveURL(/\/login/);
});

test("setup, staff and branches work in Arabic, right to left", async ({ browser }) => {
  const id = run();
  const context = await browser.newContext();
  await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
  const page = await context.newPage();

  await page.goto("/onboarding");
  await expectArabic(page);
  await expect(page.getByLabel(ar["onboarding.branchName"])).toHaveValue(ar["onboarding.branchDefault"]);
  await setUpShop(page, ar, `متجر ${id}`, `owner-ar-${id}@example.test`);

  await page.goto("/settings/staff");
  await expect(page.getByRole("heading", { name: ar["staff.title"] })).toBeVisible();
  await expectArabic(page);
  await page.goto("/settings/branches");
  await expect(page.getByRole("heading", { name: ar["branches.title"] })).toBeVisible();
  await expectArabic(page);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: ar["account.title"] })).toBeVisible();
  await expectArabic(page);
});
