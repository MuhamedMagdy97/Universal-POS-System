import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E_ORGS, E2E_USERS, type E2EUserKey } from "../../prisma/seed-e2e";
import { MESSAGES } from "../../lib/i18n";
import { E2E_BASE_URL } from "./support/env";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";

/**
 * T10 hardening: printed receipts (original, copy, Arabic), receipt settings, the Z-report,
 * security headers, and Arabic RTL on the screens earlier phases did not cover.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;
const CASHIER = E2E_USERS.cashierA.email;
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;

/** English UI phrases (two words or more, no placeholders) that must not show on an Arabic screen. */
const ENGLISH_PHRASES = Object.entries(MESSAGES.en)
  .filter(
    ([key, text]) =>
      !text.includes("{") && text.trim().includes(" ") && MESSAGES.ar[key as keyof typeof MESSAGES.ar] !== text,
  )
  .map(([, text]) => text);

async function expectArabic(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  const text = await page.locator("main").innerText();
  const leftovers = ENGLISH_PHRASES.filter((phrase) => text.includes(phrase));
  expect(leftovers, "English UI text on an Arabic screen").toEqual([]);
}

async function contextAs(browser: Browser, user: E2EUserKey, locale: "en" | "ar" = "en"): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: storageStateFor(user) });
  if (locale === "ar") await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
  return context;
}

/** Opens a shift (float 0) on a fresh till and sells one unit (EGP 10.00) for cash 20. Leaves the receipt on screen. */
async function sellOne(page: Page, arabic = false) {
  const m = MESSAGES[arabic ? "ar" : "en"];
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const sku = `PRN-${run}`;
  const name = `Print Item ${run}`;
  // createRunProduct prices the item at 1000 minor units (EGP 10.00), VAT included.
  const productId = await createRunProduct(ORG, sku, name);
  await openRunStock(ORG, MAIN, productId, 5, CASHIER);
  const registerId = await createRunRegister(ORG, MAIN, `Print ${run}`);
  await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
  await page.getByLabel(m["pos.shift.float"], { exact: false }).fill("0");
  await page.getByRole("button", { name: m["pos.shift.open"] }).click();
  const search = page.getByRole("textbox", { name: m["pos.search.label"] });
  await search.fill(sku);
  await search.press("Enter");
  await page.getByLabel(m["pos.pay.received"], { exact: false }).fill("20");
  const charge = m["pos.pay.charge"].replace(" {total}", "");
  await page.getByRole("button", { name: new RegExp(`^${charge}`) }).click();
  const heading = page.locator("#receipt-title");
  await expect(heading).toBeVisible();
  return { number: ((await heading.textContent()) ?? "").replace(/\D/g, ""), name };
}

/** The slip in the print root that prints now (the last one printed on the page). */
const slipIn = (page: Page, testId = "receipt-slip") =>
  page.locator(`.print-root[data-active] [data-testid=${testId}]`);

test.describe("receipts", () => {
  test("settings flow onto the printed receipt; a reprint is marked Copy", async ({ browser }) => {
    const footer = `Thanks ${Date.now()}`;
    const admin = await contextAs(browser, "adminA");
    const settings = await admin.newPage();
    await settings.goto("/settings/receipt");
    await settings.getByLabel("VAT number").fill("300-123-456");
    await settings.getByLabel("Footer line").fill(footer);
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await admin.close();

    const cashier = await contextAs(browser, "cashierA");
    const page = await cashier.newPage();
    const { number } = await sellOne(page);

    await page.getByRole("button", { name: "Print", exact: true }).click();
    const slip = slipIn(page);
    await expect(slip).toContainText("Receipt");
    await expect(slip).toContainText(`Sale ${number}`);
    await expect(slip).toContainText("VAT no. 300-123-456");
    await expect(slip).toContainText(footer);
    await expect(slip).toContainText("VAT 14%");
    await expect(slip).not.toContainText("Copy");

    // In print only the slip shows; on screen it stays hidden.
    await page.emulateMedia({ media: "print" });
    await expect(slip).toBeVisible();
    await expect(page.locator("main")).toBeHidden();
    // "Save as PDF" gets an 80 mm page as tall as the slip, not an A4 sheet.
    const pdf = (await page.pdf({ preferCSSPageSize: true })).toString("latin1");
    const box = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf);
    expect(box, "PDF MediaBox").not.toBeNull();
    const [widthMm, heightMm] = [Number(box?.[1]), Number(box?.[2])].map((pt) => (pt * 25.4) / 72);
    expect(widthMm).toBeCloseTo(80, 0);
    expect(heightMm).toBeGreaterThan(40);
    expect(heightMm).toBeLessThan(200);
    expect(pdf.match(/\/Type\s*\/Page[^s]/g)).toHaveLength(1);

    await page.emulateMedia({ media: "screen" });
    await expect(slip).toBeHidden();

    // A second press of the original Print button prints a copy, never a second original.
    await page.getByRole("button", { name: "Print", exact: true }).click();
    await expect(slipIn(page)).toContainText("Receipt · Copy");

    await page.getByRole("button", { name: "New sale" }).click();
    await page.getByRole("button", { name: "Reprint last receipt" }).click();
    await expect(slipIn(page)).toContainText("Receipt · Copy");
    await cashier.close();
  });

  test("prints in Arabic, right-to-left, with Latin digits", async ({ browser }) => {
    const cashier = await contextAs(browser, "cashierA", "ar");
    const page = await cashier.newPage();
    const { number } = await sellOne(page, true);
    await page.getByRole("button", { name: MESSAGES.ar["pos.receipt.print"], exact: true }).click();
    const slip = slipIn(page);
    await expect(slip).toHaveAttribute("dir", "rtl");
    await expect(slip).toContainText("إيصال");
    await expect(slip).toContainText(`فاتورة رقم ${number}`);
    expect(await slip.textContent()).not.toMatch(ARABIC_INDIC_DIGITS);
    await cashier.close();
  });

  test("a manager reprints a sale and prints the refund from the Returns screen", async ({ browser }) => {
    const cashier = await contextAs(browser, "cashierA");
    const { number, name } = await sellOne(await cashier.newPage());
    await cashier.close();

    const manager = await contextAs(browser, "managerA");
    const page = await manager.newPage();
    await page.goto(`/returns?number=${number}`);
    await page.getByRole("button", { name: "Reprint receipt" }).click();
    await expect(slipIn(page)).toContainText("Receipt · Copy");

    await page.getByRole("textbox", { name: `Refund quantity for ${name}` }).fill("1");
    await page.getByLabel("Reason", { exact: true }).fill("Damaged");
    await page.getByRole("button", { name: /^Refund EGP/ }).click();
    await expect(page.getByTestId("returns-message")).toContainText("Refunded EGP 10.00.");
    await page.getByRole("button", { name: "Print", exact: true }).click();
    const slip = slipIn(page);
    await expect(slip).toContainText("Refund");
    await expect(slip).toContainText("Reason: Damaged");
    await expect(slip).not.toContainText("Copy");
    // Two slips are mounted on this page, but only the last one printed goes to paper.
    await expect(page.locator(".print-root")).toHaveCount(2);
    await page.emulateMedia({ media: "print" });
    await expect(slip).toBeVisible();
    await expect(page.locator(".print-root:not([data-active])")).toBeHidden();
    await manager.close();
  });
});

test.describe("Z-report", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("prints after the shift close", async ({ page }) => {
    await sellOne(page);
    await page.getByRole("button", { name: "New sale" }).click();
    await page.getByRole("button", { name: "Close shift" }).click();
    await page.getByLabel(/Cash counted/).fill("10");
    await page.getByRole("button", { name: "Close shift", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
    await page.getByRole("button", { name: "Print Z-report" }).click();
    const slip = slipIn(page, "zreport-slip");
    await expect(slip).toContainText("Z-report");
    await expect(slip).toContainText("Cash sales");
    await expect(slip).toContainText("10.00");
  });
});

test.describe("settings access", () => {
  test.use({ storageState: storageStateFor("managerA") });

  test("a manager cannot open receipt settings and sees no Settings link", async ({ page }) => {
    await page.goto("/settings/receipt");
    await expect(page.getByRole("heading", { name: "You cannot change settings" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  });
});

test("every response carries the security headers", async ({ request }) => {
  for (const path of ["/login", "/api/health"]) {
    const headers = (await request.get(path)).headers();
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(headers["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(headers["strict-transport-security"], path).toContain("max-age=");
  }
});

test.describe("Arabic RTL (H12)", () => {
  test("returns, reports, audit, purchasing and settings render in Arabic", async ({ browser }) => {
    const admin = await contextAs(browser, "adminA", "ar");
    const page = await admin.newPage();
    for (const path of [
      "/returns",
      "/reports?report=sales-summary&range=today",
      "/audit",
      "/purchasing",
      "/settings/receipt",
    ]) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      await expectArabic(page);
    }
    await admin.close();
  });
});

test.describe("purchase order print (H10)", () => {
  test.use({ storageState: storageStateFor("adminA") });

  test("prints the PO on A4 with supplier, lines and total", async ({ page }) => {
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const supplier = `Print Supplier ${run}`;
    const sku = `POP-${run}`;
    await createRunProduct(ORG, sku, `PO Print ${run}`);

    await page.goto("/purchasing/suppliers");
    await page.getByRole("button", { name: "Add supplier" }).click();
    await page.getByLabel("Name").fill(supplier);
    await page.getByLabel("Tax number").fill("TAX-77");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("cell", { name: supplier })).toBeVisible();

    await page.goto("/purchasing/new");
    await page.getByLabel("Supplier").selectOption({ label: supplier });
    const branchPicker = page.getByLabel("Branch");
    if ((await branchPicker.count()) > 0) await branchPicker.selectOption(MAIN);
    await page.getByRole("textbox", { name: "Add items" }).fill(sku);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("listitem").filter({ hasText: sku }).getByRole("button", { name: "Add" }).click();
    await page.getByRole("textbox", { name: `Ordered ${sku}` }).fill("3");
    await page.getByRole("textbox", { name: `Unit cost ${sku}` }).fill("4.25");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(page).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);

    await page.getByRole("button", { name: "Print order" }).click();
    const sheet = page.locator(".print-root [data-testid=po-print]");
    await expect(sheet).toContainText("Purchase order");
    await expect(sheet).toContainText(/PO-\d{6}/);
    await expect(sheet).toContainText(supplier);
    await expect(sheet).toContainText("TAX-77");
    await expect(sheet).toContainText(sku);
    // 3 × 4.25 = 12.75
    await expect(sheet).toContainText("12.75");

    await page.emulateMedia({ media: "print" });
    await expect(sheet).toBeVisible();
    await expect(page.locator("main")).toBeHidden();
  });
});
