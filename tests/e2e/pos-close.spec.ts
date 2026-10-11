import { expect, test } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";

/** The shift close screen (T7): expected cash before the count, a note for a difference, then the summary. */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;
const CASHIER = E2E_USERS.cashierA.email;

async function runFixtures() {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const sku = `CLS-${run}`;
  const name = `Close Item ${run}`;
  // createRunProduct prices the item at 1000 minor units (EGP 10.00), VAT included.
  const productId = await createRunProduct(ORG, sku, name);
  await openRunStock(ORG, MAIN, productId, 5, CASHIER);
  const registerId = await createRunRegister(ORG, MAIN, `Close ${run}`);
  return { sku, name, registerId };
}

test.describe("cashier closing a shift", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("shows the expected cash, asks for a note on a short count, and closes", async ({ page }) => {
    const { sku, name, registerId } = await runFixtures();

    // Open with 100 in the drawer, then sell two units for cash: 20 taken, 50 tendered, 30 change.
    await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
    await page.getByLabel(/Opening cash in the drawer/).fill("100");
    await page.getByRole("button", { name: "Open shift" }).click();

    const search = page.getByRole("textbox", { name: "Scan or search items" });
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByRole("textbox", { name: `Quantity for ${name}` })).toHaveValue("1");
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByRole("textbox", { name: `Quantity for ${name}` })).toHaveValue("2");
    await page.getByLabel(/Cash received/).fill("50");
    await page.getByRole("button", { name: /^Charge/ }).click();
    await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
    await page.getByRole("button", { name: "New sale" }).click();

    // The expected cash is opening 100 + cash sales 20 = 120, shown before the count.
    await page.getByRole("button", { name: "Close shift" }).click();
    await expect(page.getByTestId("close-expected")).toContainText("120.00");

    // Counting 110 is short by 10: the note is required and the submit waits for it.
    await page.getByLabel(/Cash counted/).fill("110");
    await expect(page.getByTestId("close-live-difference")).toContainText("-EGP 10.00");
    const submit = page.getByRole("button", { name: "Close shift", exact: true });
    await expect(submit).toBeDisabled();
    await page.getByLabel("Reason for the difference").fill("Counted coins twice");
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
    await expect(page.getByTestId("close-difference")).toContainText("-EGP 10.00");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "No open shift on this register" })).toBeVisible();
  });

  test("closes with an exact count and needs no note", async ({ page }) => {
    const { registerId } = await runFixtures();

    await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
    await page.getByLabel(/Opening cash in the drawer/).fill("250");
    await page.getByRole("button", { name: "Open shift" }).click();

    await page.getByRole("button", { name: "Close shift" }).click();
    await expect(page.getByTestId("close-expected")).toContainText("250.00");
    await expect(page.getByLabel("Reason for the difference")).toHaveCount(0);

    await page.getByLabel(/Cash counted/).fill("250");
    await page.getByRole("button", { name: "Close shift", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
    await expect(page.getByTestId("close-difference")).toContainText("0.00");
  });
});
