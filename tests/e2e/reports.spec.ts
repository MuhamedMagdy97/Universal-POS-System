import { expect, test, type Browser } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";

/**
 * Reports (T9): a cashier sells a run-specific item, then an admin finds it in today's reports.
 * Other specs sell in parallel, so assertions look at this run's own rows only.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;
const CASHIER = E2E_USERS.cashierA.email;

async function sellTwo(browser: Browser) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const sku = `REP-${run}`;
  const name = `Report Item ${run}`;
  const registerName = `Reports ${run}`;
  // createRunProduct prices the item at 1000 minor units (EGP 10.00), VAT included.
  const productId = await createRunProduct(ORG, sku, name);
  await openRunStock(ORG, MAIN, productId, 5, CASHIER);
  const registerId = await createRunRegister(ORG, MAIN, registerName);

  const context = await browser.newContext({ storageState: storageStateFor("cashierA") });
  const page = await context.newPage();
  await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
  await page.getByLabel(/Opening cash in the drawer/).fill("50");
  await page.getByRole("button", { name: "Open shift" }).click();
  const search = page.getByRole("textbox", { name: "Scan or search items" });
  for (let i = 1; i <= 2; i++) {
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByRole("textbox", { name: `Quantity for ${name}` })).toHaveValue(String(i));
  }
  await page.getByLabel(/Cash received/).fill("20");
  await page.getByRole("button", { name: /^Charge/ }).click();
  await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
  await context.close();
  return { sku, registerName };
}

test.describe("admin", () => {
  test.use({ storageState: storageStateFor("adminA") });

  test("finds today's sale in the products and shifts reports and exports CSV", async ({ page, browser }) => {
    const { sku, registerName } = await sellTwo(browser);

    await page.goto("/dashboard");
    await expect(page.getByText("Net sales")).toBeVisible();
    await page.getByRole("link", { name: "Reports" }).click();
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(page.getByText("Cairo time")).toBeVisible();

    await page.getByRole("link", { name: "Products", exact: true }).click();
    await expect(page).toHaveURL(/report=products/);
    await page.getByRole("link", { name: "Today" }).click();
    await expect(page).toHaveURL(/report=products&range=today/);
    const row = page.getByRole("row").filter({ hasText: sku });
    await expect(row).toBeVisible();
    await expect(row.getByRole("cell").nth(2)).toHaveText("2");
    await expect(row).toContainText("20.00");

    await page.getByRole("link", { name: "Shifts" }).click();
    await expect(page).toHaveURL(/report=shifts/);
    const shift = page.getByRole("row").filter({ hasText: registerName });
    await expect(shift).toContainText("Open");
    await expect(shift).toContainText("70.00"); // 50.00 float + 20.00 cash sales

    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export CSV" }).click();
    expect((await download).suggestedFilename()).toMatch(/^shifts_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test("shows an error for an inverted range and Arabic right to left", async ({ page, context }) => {
    await page.goto("/reports?report=vat&from=2026-03-10&to=2026-03-01");
    await expect(page.getByText(/^Check the dates/)).toBeVisible();

    await context.addCookies([{ name: "pos_locale", value: "ar", url: page.url() }]);
    await page.goto("/reports?report=payments&range=today");
    await expect(page.getByRole("heading", { name: "التقارير" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("columnheader", { name: "طريقة الدفع" })).toBeVisible();
  });
});

test.describe("profit (P12)", () => {
  test.use({ storageState: storageStateFor("adminA") });

  test("shows today's profit by product with its cost, margin and CSV, then in Arabic", async ({
    page,
    browser,
    context,
  }) => {
    // createRunProduct costs the item 500 (EGP 5.00): 2 × 10.00 incl. 14% VAT = 17.54 net, 10.00 cost.
    const { sku } = await sellTwo(browser);

    await page.goto("/reports?report=profit-products&range=today");
    await expect(page.getByRole("link", { name: "Profit by product" })).toHaveAttribute("aria-current", "page");
    const row = page.getByRole("row").filter({ hasText: sku });
    await expect(row).toBeVisible();
    await expect(row.getByRole("cell").nth(2)).toHaveText("2");
    await expect(row).toContainText("17.54");
    await expect(row).toContainText("10.00");
    await expect(row).toContainText("7.54");
    await expect(row).toContainText("43.0%");

    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export CSV" }).click();
    expect((await download).suggestedFilename()).toMatch(/^profit-products_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);

    await context.addCookies([{ name: "pos_locale", value: "ar", url: page.url() }]);
    await page.goto("/reports?report=profit-days&range=today");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("link", { name: "الربح حسب اليوم" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("columnheader", { name: "إجمالي الربح" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "هامش الربح" })).toBeVisible();
  });

  for (const user of ["managerA", "reportingA"] as const) {
    test.describe(user, () => {
      test.use({ storageState: storageStateFor(user) });

      test("sees no profit report and is sent to the default one", async ({ page }) => {
        await page.goto("/reports?report=profit-products&range=today");
        await expect(page.getByRole("link", { name: "Sales summary" })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("link", { name: /^Profit by/ })).toHaveCount(0);
        await expect(page.getByRole("columnheader", { name: "Gross profit" })).toHaveCount(0);
      });
    });
  }
});

test.describe("cashier", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("has no reports link and is refused", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: "Reports" })).toHaveCount(0);
    await expect(page.getByText("Net sales")).toHaveCount(0);
    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "You can't view reports" })).toBeVisible();
  });
});
