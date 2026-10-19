import { expect, test } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, onHand, openRunStock } from "./support/pos";

/** Discounts at the till (docs/planning/discounts/discounts-spec.md): a cashier discounts a sale, a manager refunds it. */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;
const CASHIER = E2E_USERS.cashierA.email;

test("a cashier discounts a line and the sale from the keyboard, and a manager refunds the paid amount", async ({
  browser,
}) => {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const sku = `DSC-${run}`;
  const name = `Discount Item ${run}`;
  // createRunProduct prices the item at 1000 minor units (EGP 10.00), VAT included.
  const productId = await createRunProduct(ORG, sku, name);
  await openRunStock(ORG, MAIN, productId, 5, CASHIER);
  const registerId = await createRunRegister(ORG, MAIN, `Discounts ${run}`);

  const till = await browser.newContext({ storageState: storageStateFor("cashierA") });
  const pos = await till.newPage();
  await pos.goto(`/pos?branch=${MAIN}&register=${registerId}`);
  await pos.getByLabel(/Opening cash in the drawer/).fill("0");
  await pos.getByRole("button", { name: "Open shift" }).click();
  await expect(pos.getByTestId("till-keys")).toContainText("F6 line discount");

  const search = pos.getByRole("textbox", { name: "Scan or search items" });
  await search.fill(sku);
  await search.press("Enter");
  await pos.getByRole("textbox", { name: `Quantity for ${name}` }).fill("2");
  await expect(pos.getByTestId("till-total")).toContainText("20.00");

  // F6: 10% off the selected line (the default kind is percent). Enter applies.
  await search.focus();
  await pos.keyboard.press("F6");
  const box = pos.getByTestId("discount-box");
  await expect(box).toContainText(`Discount on ${name}`);
  await expect(box).toContainText("Your limit: 10%");
  await box.getByLabel("Discount", { exact: true }).fill("10");
  await box.getByLabel("Discount", { exact: true }).press("Enter");
  await expect(box).toHaveCount(0);
  await expect(pos.getByTestId("line-discount")).toContainText("2.00");
  await expect(pos.getByTestId("till-total")).toContainText("18.00");

  // F7: a 50% sale discount is past the cashier's limit: shown, and the charge stays off.
  await pos.keyboard.press("F7");
  await expect(box).toContainText("Discount on the whole sale");
  await box.getByLabel("Discount", { exact: true }).fill("50");
  await box.getByLabel("Discount", { exact: true }).press("Enter");
  await expect(pos.getByRole("alert").filter({ hasText: "over your limit of 10%" })).toBeVisible();
  await pos.getByLabel(/Cash received/).fill("20");
  await expect(pos.getByRole("button", { name: /^Charge/ })).toBeDisabled();

  // 10% off the line plus anything off the sale is past 10% too: remove the line discount, then EGP 1.00 off the sale.
  await pos.getByRole("button", { name: `Discount on ${name}` }).click();
  await box.getByRole("button", { name: "Remove" }).click();
  await pos.keyboard.press("F7");
  await box.getByRole("radio", { name: /Amount/ }).check();
  await box.getByLabel("Discount", { exact: true }).fill("1");
  await box.getByLabel("Discount", { exact: true }).press("Enter");
  await expect(pos.getByTestId("till-discount")).toContainText("1.00");
  await expect(pos.getByTestId("till-total")).toContainText("19.00");

  await pos.getByLabel(/Cash received/).fill("20");
  await pos.getByRole("button", { name: /^Charge/ }).click();
  const heading = pos.getByRole("heading", { name: /^Sale \d{6}$/ });
  await expect(heading).toBeVisible();
  await expect(pos.getByTestId("receipt-discount")).toContainText("1.00");
  await expect(pos.getByTestId("receipt-change")).toContainText("1.00");
  const number = ((await heading.textContent()) ?? "").replace(/\D/g, "");
  await till.close();
  expect(await onHand(ORG, MAIN, productId)).toBe(3);

  // The manager refunds one of the two units: half of the 19.00 paid.
  const back = await browser.newContext({ storageState: storageStateFor("managerA") });
  const returns = await back.newPage();
  await returns.goto(`/returns?number=${number}`);
  await expect(returns.getByText(/Discounted EGP\s1\.00 · paid EGP\s19\.00/)).toBeVisible();
  await returns.getByRole("textbox", { name: `Refund quantity for ${name}` }).fill("1");
  await expect(returns.getByTestId("refund-total")).toContainText("9.50");
  await returns.getByLabel("Reason", { exact: true }).fill("Changed mind");
  await returns.getByRole("button", { name: /^Refund EGP/ }).click();
  await expect(returns.getByTestId("returns-message")).toContainText("Refunded EGP 9.50.");
  expect(await onHand(ORG, MAIN, productId)).toBe(4);
  await back.close();
});
