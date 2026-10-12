import { expect, test, type Browser } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, onHand, openRunStock } from "./support/pos";

/** Returns (T8): a cashier sells on the till, then a manager refunds part of the sale or voids it. */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;
const CASHIER = E2E_USERS.cashierA.email;

/** Sells `qty` units for cash as the cashier, in its own browser session, and returns the receipt number. */
async function sellAsCashier(browser: Browser, qty: number) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const sku = `RET-${run}`;
  const name = `Return Item ${run}`;
  // createRunProduct prices the item at 1000 minor units (EGP 10.00), VAT included.
  const productId = await createRunProduct(ORG, sku, name);
  await openRunStock(ORG, MAIN, productId, 5, CASHIER);
  const registerId = await createRunRegister(ORG, MAIN, `Returns ${run}`);

  const context = await browser.newContext({ storageState: storageStateFor("cashierA") });
  const page = await context.newPage();
  await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
  await page.getByLabel(/Opening cash in the drawer/).fill("0");
  await page.getByRole("button", { name: "Open shift" }).click();
  const search = page.getByRole("textbox", { name: "Scan or search items" });
  for (let i = 1; i <= qty; i++) {
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByRole("textbox", { name: `Quantity for ${name}` })).toHaveValue(String(i));
  }
  await page.getByLabel(/Cash received/).fill(String(qty * 10));
  await page.getByRole("button", { name: /^Charge/ }).click();
  const heading = page.getByRole("heading", { name: /^Sale \d{6}$/ });
  await expect(heading).toBeVisible();
  const number = ((await heading.textContent()) ?? "").replace(/\D/g, "");
  await context.close();
  return { number, sku, name, productId };
}

test.describe("manager", () => {
  test.use({ storageState: storageStateFor("managerA") });

  test("refunds one of two units for cash and sees what is left", async ({ page, browser }) => {
    const { number, sku, name, productId } = await sellAsCashier(browser, 2);
    expect(await onHand(ORG, MAIN, productId)).toBe(3);

    await page.goto("/returns");
    // Leading zeros are optional.
    await page.getByLabel("Receipt number").fill(String(Number(number)));
    await page.getByRole("button", { name: "Find sale" }).click();
    await expect(page.getByRole("heading", { name: `Sale ${number}` })).toBeVisible();

    await page.getByRole("textbox", { name: `Refund quantity for ${name}` }).fill("1");
    await expect(page.getByTestId("refund-total")).toContainText("10.00");
    const submit = page.getByRole("button", { name: /^Refund EGP/ });
    await expect(submit).toBeDisabled();
    await page.getByLabel("Reason", { exact: true }).fill("Damaged box");
    await submit.click();

    await expect(page.getByTestId("returns-message")).toContainText("Refunded EGP 10.00.");
    await expect(page.getByTestId(`refunded-${sku}`)).toHaveText("1");
    await expect(page.getByText("Refunds on this sale")).toBeVisible();
    expect(await onHand(ORG, MAIN, productId)).toBe(4);
    // The sale has a refund now, so the void is no longer offered.
    await expect(page.getByRole("button", { name: "Void sale" })).toHaveCount(0);
  });

  test("voids a sale on its open shift and gets the stock back", async ({ page, browser }) => {
    const { number, productId } = await sellAsCashier(browser, 1);
    expect(await onHand(ORG, MAIN, productId)).toBe(4);

    await page.goto(`/returns?number=${number}`);
    await page.getByRole("button", { name: "Void sale" }).click();
    const confirm = page.getByRole("button", { name: "Confirm void" });
    await expect(confirm).toBeDisabled();
    await page.getByLabel("Reason for the void").fill("Wrong customer");
    await confirm.click();

    await expect(page.getByTestId("returns-message")).toContainText(`Sale ${number} was voided.`);
    await expect(page.getByText("This sale was voided.")).toBeVisible();
    expect(await onHand(ORG, MAIN, productId)).toBe(5);
  });

  test("is told when no sale has that number", async ({ page }) => {
    await page.goto("/returns?number=999999");
    await expect(page.getByText("No sale with that number.")).toBeVisible();
  });
});

test.describe("cashier", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("cannot use returns and sees no Returns link", async ({ page }) => {
    await page.goto("/returns");
    await expect(page.getByRole("heading", { name: "You can't use returns" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Returns" })).toHaveCount(0);
  });
});
