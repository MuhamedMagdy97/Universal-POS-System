import { expect, test } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";

/**
 * Customer records (docs/planning/customers/customers-spec.md): a manager adds a B2B customer, a
 * cashier picks them at the till from the keyboard and prints a receipt with their VAT number,
 * quick-adds another, and the manager sees the sale on the customer's page.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;
const CASHIER = E2E_USERS.cashierA.email;

test("a till sale with a customer prints them on the receipt and lands in their history", async ({ browser }) => {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const digits = String(Date.now()).slice(-8);
  const phone = `010 ${digits.slice(0, 4)} ${digits.slice(4)}`;
  const quickPhone = `011${digits}`;
  const customer = `Buyer ${run}`;
  const sku = `CUS-${run}`;
  const productId = await createRunProduct(ORG, sku, `Customer Item ${run}`);
  await openRunStock(ORG, MAIN, productId, 5, CASHIER);
  const registerId = await createRunRegister(ORG, MAIN, `Customers ${run}`);

  // The manager adds a B2B customer in the back office.
  const back = await browser.newContext({ storageState: storageStateFor("managerA") });
  const office = await back.newPage();
  await office.goto("/customers");
  await office.getByRole("button", { name: "Add customer" }).click();
  const form = office.getByRole("form", { name: "Add customer" });
  await form.getByLabel("Name").fill(customer);
  await form.getByLabel("Phone").fill(phone);
  await form.getByLabel("VAT number").fill("310123456700003");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(office.getByRole("heading", { name: customer })).toBeVisible();
  await expect(office.getByText(`+2010${digits}`)).toBeVisible();

  // The cashier finds them by phone with F9, picks with Enter, and sells.
  const till = await browser.newContext({ storageState: storageStateFor("cashierA") });
  const pos = await till.newPage();
  await pos.goto(`/pos?branch=${MAIN}&register=${registerId}`);
  await pos.getByLabel(/Opening cash in the drawer/).fill("0");
  await pos.getByRole("button", { name: "Open shift" }).click();
  await expect(pos.getByTestId("till-keys")).toContainText("F9 customer");

  const search = pos.getByRole("textbox", { name: "Scan or search items" });
  await search.fill(sku);
  await search.press("Enter");
  await pos.keyboard.press("F9");
  const picker = pos.getByRole("combobox", { name: "Customer (F9)" });
  await expect(picker).toBeFocused();
  await picker.fill(digits);
  await expect(pos.getByRole("option", { name: new RegExp(customer) })).toBeVisible();
  await picker.press("Enter");
  await expect(pos.getByTestId("till-customer")).toContainText(customer);
  await expect(search).toBeFocused();

  await pos.keyboard.press("F8");
  await pos.getByRole("button", { name: /^Charge/ }).click();
  const heading = pos.getByRole("heading", { name: /^Sale \d{6}$/ });
  await expect(heading).toBeVisible();
  const number = ((await heading.textContent()) ?? "").replace(/\D/g, "");
  await expect(pos.getByTestId("receipt-customer")).toContainText(customer);
  await pos.getByRole("button", { name: "Print", exact: true }).click();
  const slip = pos.locator(".print-root[data-active] [data-testid=receipt-slip]");
  await expect(slip).toContainText(`Customer: ${customer}`);
  await expect(slip).toContainText("Customer VAT no. 310123456700003");

  // Next sale: walk-in by default; quick-add a new customer by phone.
  await pos.getByRole("button", { name: "New sale" }).click();
  await expect(pos.getByTestId("till-customer")).toHaveCount(0);
  await search.fill(sku);
  await search.press("Enter");
  await pos.keyboard.press("F9");
  await picker.fill(quickPhone);
  await expect(pos.getByText("No customer found.")).toBeVisible();
  await pos.getByRole("button", { name: "Add customer" }).click();
  const quick = pos.getByRole("form", { name: "Add customer" });
  await expect(quick.getByLabel("Phone")).toHaveValue(quickPhone);
  await quick.getByLabel("Name").fill(`Walk Up ${run}`);
  await quick.getByRole("button", { name: "Add and use" }).click();
  await expect(pos.getByTestId("till-customer")).toContainText(`Walk Up ${run}`);
  await pos.keyboard.press("F8");
  await pos.getByRole("button", { name: /^Charge/ }).click();
  await expect(pos.getByTestId("receipt-customer")).toContainText(`Walk Up ${run}`);
  await till.close();

  // The manager sees the first sale in the customer's history.
  await office.goto(`/customers?q=${encodeURIComponent(customer)}`);
  await office.getByRole("link", { name: customer }).click();
  await expect(office.getByTestId("customer-sales")).toContainText(number);
  await expect(office.getByTestId("customer-totals")).toContainText("10.00");
  await back.close();
});
