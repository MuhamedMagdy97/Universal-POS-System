import { expect, test } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, onHand, openRunStock } from "./support/pos";

/** The till for a cashier (T6): open a shift, scan, take cash, see the receipt; and its refusals. */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;
const CASHIER = E2E_USERS.cashierA.email;

async function runFixtures(stock: number) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const sku = `POS-${run}`;
  const name = `Till Item ${run}`;
  // createRunProduct prices the item at 1000 minor units (EGP 10.00), VAT included.
  const productId = await createRunProduct(ORG, sku, name);
  if (stock > 0) await openRunStock(ORG, MAIN, productId, stock, CASHIER);
  const registerId = await createRunRegister(ORG, MAIN, `Till ${run}`);
  return { sku, name, productId, registerId };
}

test.describe("cashier", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("opens a shift, sells two units for cash, and gets change on the receipt", async ({ page }) => {
    const { sku, name, productId, registerId } = await runFixtures(5);

    await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
    await expect(page.getByRole("heading", { name: "No open shift on this register" })).toBeVisible();
    await page.getByLabel(/Opening cash in the drawer/).fill("100");
    await page.getByRole("button", { name: "Open shift" }).click();

    // Two scans of the same code: one line, quantity 2.
    const search = page.getByRole("textbox", { name: "Scan or search items" });
    await expect(search).toBeFocused();
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByRole("textbox", { name: `Quantity for ${name}` })).toHaveValue("1");
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByRole("textbox", { name: `Quantity for ${name}` })).toHaveValue("2");
    await expect(page.getByTestId("till-total")).toContainText("20.00");

    // Cash 50 → change 30.
    await page.getByLabel(/Cash received/).fill("50");
    await expect(page.getByTestId("till-change")).toContainText("30.00");
    await page.getByRole("button", { name: /^Charge/ }).click();

    await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
    await expect(page.getByTestId("receipt-change")).toContainText("30.00");
    expect(await onHand(ORG, MAIN, productId)).toBe(3);

    // A new sale starts empty with the scanner box ready.
    await page.getByRole("button", { name: "New sale" }).click();
    await expect(page.getByText("Scan an item to start a sale.")).toBeVisible();
    await expect(search).toBeFocused();
  });

  test("refuses a sale beyond the stock and names the item", async ({ page }) => {
    const { sku, name, productId, registerId } = await runFixtures(1);

    await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
    await page.getByLabel(/Opening cash in the drawer/).fill("0");
    await page.getByRole("button", { name: "Open shift" }).click();

    const search = page.getByRole("textbox", { name: "Scan or search items" });
    await search.fill(sku);
    await search.press("Enter");
    await page.getByRole("textbox", { name: `Quantity for ${name}` }).fill("2");
    await page.getByLabel(/Cash received/).fill("20");
    await page.getByRole("button", { name: /^Charge/ }).click();

    // Next.js adds its own empty role=alert route announcer, so match the message text.
    await expect(page.getByRole("alert").filter({ hasText: "Not enough stock" })).toContainText(name);
    expect(await onHand(ORG, MAIN, productId)).toBe(1);

    // Fixing the cart and retrying works (a fresh key, so no idempotency conflict).
    await page.getByRole("textbox", { name: `Quantity for ${name}` }).fill("1");
    await page.getByLabel(/Cash received/).fill("10");
    await page.getByRole("button", { name: /^Charge/ }).click();
    await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
    expect(await onHand(ORG, MAIN, productId)).toBe(0);
  });

  test("splits one sale across card and cash, with change from the cash", async ({ page }) => {
    const { sku, productId, registerId } = await runFixtures(2);

    await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
    await page.getByLabel(/Opening cash in the drawer/).fill("0");
    await page.getByRole("button", { name: "Open shift" }).click();

    const search = page.getByRole("textbox", { name: "Scan or search items" });
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByTestId("till-total")).toContainText("10.00");

    await page.getByRole("radio", { name: "Split" }).check();
    await page.getByLabel(/^Card amount/).fill("6");
    await page.getByLabel(/^Card reference/).fill("R-1");
    await expect(page.getByTestId("till-remaining")).toContainText("4.00");
    await expect(page.getByRole("button", { name: /^Charge/ })).toBeDisabled();

    // Card over the total is refused; only cash can give change.
    await page.getByLabel(/^Card amount/).fill("11");
    await expect(page.getByText(/only cash gives change/)).toBeVisible();
    await page.getByLabel(/^Card amount/).fill("6");

    // Arabic-Indic digits are read: ٥ = 5 cash for a 4.00 remainder.
    await page.getByLabel(/^Cash amount/).fill("٥");
    await expect(page.getByTestId("till-change")).toContainText("1.00");
    await page.getByRole("button", { name: /^Charge/ }).click();

    await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
    await expect(page.getByTestId("receipt-change")).toContainText("1.00");
    await expect(page.getByRole("definition").filter({ hasText: "6.00" })).toBeVisible();
    expect(await onHand(ORG, MAIN, productId)).toBe(1);
  });

  test("shows stock and works from the keyboard, with exact cash", async ({ page }) => {
    const { sku, name, registerId } = await runFixtures(1);
    // A second match with no stock, for the results list.
    await createRunProduct(ORG, sku.replace("POS-", "PSB-"), `${name} B`);

    await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
    await page.getByLabel(/Opening cash in the drawer/).fill("0");
    await page.getByRole("button", { name: "Open shift" }).click();
    await expect(page.getByTestId("till-keys")).toContainText("F8 exact cash");

    // Two matches: each shows the branch's on-hand; Esc closes the list.
    const search = page.getByRole("textbox", { name: "Scan or search items" });
    await search.fill(name);
    await search.press("Enter");
    const results = page.getByRole("list", { name: "Scan or search items" });
    await expect(results.getByRole("listitem").filter({ hasText: `${name} B` })).toContainText("On hand: 0");
    await page.keyboard.press("Escape");
    await expect(results).toHaveCount(0);

    // F2 returns to the search box; a scan shows the line's stock.
    await page.getByRole("button", { name: "Find" }).focus();
    await page.keyboard.press("F2");
    await expect(search).toBeFocused();
    await search.fill(sku);
    await search.press("Enter");
    const qty = page.getByRole("textbox", { name: `Quantity for ${name}` });
    await expect(qty).toHaveValue("1");
    await expect(page.getByTestId("till-stock")).toHaveText("On hand: 1");

    // + and - on the selected line; above the stock the note turns red but nothing is blocked here.
    await page.keyboard.press("+");
    await expect(qty).toHaveValue("2");
    await expect(page.getByTestId("till-stock")).toHaveClass(/text-danger/);
    await page.keyboard.press("-");
    await expect(qty).toHaveValue("1");
    await expect(page.getByTestId("till-stock")).not.toHaveClass(/text-danger/);

    // F4 goes to the cash box, F8 fills the exact amount.
    await page.keyboard.press("F4");
    const cash = page.getByLabel(/Cash received/);
    await expect(cash).toBeFocused();
    await page.keyboard.press("F8");
    await expect(cash).toHaveValue("10.00");
    await expect(page.getByTestId("till-change")).toContainText("0.00");

    // In a split, exact cash fills what the card leaves.
    await page.getByRole("radio", { name: "Split" }).check();
    await page.getByLabel(/^Card amount/).fill("3");
    await page.getByRole("button", { name: "Exact cash (F8)" }).click();
    await expect(page.getByLabel(/^Cash amount/)).toHaveValue("7.00");
    await expect(page.getByTestId("till-change")).toContainText("0.00");

    // Enter in the cash box charges.
    await page.getByLabel(/^Cash amount/).press("Enter");
    await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
    await expect(page.getByTestId("receipt-change")).toContainText("0.00");
  });

  test("renders right-to-left in Arabic", async ({ page }) => {
    const { registerId } = await runFixtures(0);
    await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
    await page.getByRole("button", { name: "Switch to Arabic" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: /نقطة البيع/, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "فتح الوردية" })).toBeVisible();
  });
});

test.describe("reporting user", () => {
  test.use({ storageState: storageStateFor("reportingA") });

  test("cannot use the till and sees no Till link", async ({ page }) => {
    await page.goto("/pos");
    await expect(page.getByRole("heading", { name: "You can't use the till" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Till" })).toHaveCount(0);
  });
});
