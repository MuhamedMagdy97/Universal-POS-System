import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";

/**
 * Supplier payments (supplier-payments-spec): an admin receives goods, pays part of the bill on the
 * supplier page, sees it in the statement with the new balance, reverses it, and finds the supplier
 * in the Supplier balances report. A manager has no access.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;

const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

test("an admin pays a supplier and reverses the payment", async ({ browser }) => {
  const run = runId();
  const supplier = `Pay supplier ${run}`;
  const sku = `PAY-${run}`;
  await createRunProduct(ORG, sku, `Pay item ${run}`);

  const adminContext = await browser.newContext({ storageState: storageStateFor("adminA") });
  const admin = await adminContext.newPage();
  await admin.goto("/purchasing/suppliers");
  await admin.getByRole("button", { name: "Add supplier" }).click();
  await admin.getByLabel("Name").fill(supplier);
  await admin.getByRole("button", { name: "Save" }).click();
  await expect(admin.getByRole("cell", { name: supplier })).toBeVisible();

  // Receive 5 × 4.00 = 20.00 from the supplier.
  await admin.goto("/purchasing/new");
  await admin.getByLabel("Supplier").selectOption({ label: supplier });
  const branchPicker = admin.getByLabel("Branch");
  if ((await branchPicker.count()) > 0) await branchPicker.selectOption(MAIN);
  await admin.getByRole("textbox", { name: "Add items" }).fill(sku);
  await admin.getByRole("button", { name: "Search", exact: true }).click();
  await admin.getByRole("listitem").filter({ hasText: sku }).getByRole("button", { name: "Add" }).click();
  await admin.getByRole("textbox", { name: `Ordered ${sku}` }).fill("5");
  await admin.getByRole("textbox", { name: `Unit cost ${sku}` }).fill("4");
  await admin.getByRole("button", { name: "Create draft" }).click();
  await expect(admin).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);
  await admin.getByRole("button", { name: "Mark as ordered" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Mark as ordered" }).click();
  await admin.getByRole("link", { name: "Receive goods" }).click();
  await admin.getByRole("button", { name: "Receive 5 units" }).click();
  await expect(admin.getByTestId("po-status")).toHaveText("Received");

  await admin.goto("/purchasing/suppliers");
  await admin.getByRole("row").filter({ hasText: supplier }).getByRole("link", { name: "Account" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(supplier);
  const accountUrl = new URL(admin.url()).pathname;
  await expect(admin.getByTestId("supplier-balance")).toContainText("20.00");
  await expect(admin.getByRole("cell", { name: "Goods received" })).toBeVisible();

  await admin.getByLabel("Amount").fill("7.5");
  await admin.getByLabel("Method").selectOption("CHEQUE");
  await admin.getByLabel("Reference").fill(`CHQ-${run}`);
  await admin.getByRole("button", { name: "Save payment" }).click();
  await expect(admin.getByTestId("supplier-balance")).toContainText("12.50");
  const paymentRow = admin.getByRole("row").filter({ hasText: `CHQ-${run}` });
  await expect(paymentRow).toContainText("Payment");
  await expect(paymentRow).toContainText("Cheque");
  await expect(admin.getByTestId("statement-closing")).toContainText("12.50");

  await paymentRow.getByRole("button", { name: /^Reverse / }).click();
  await admin.getByLabel("Reason for reversing").fill("Cheque bounced");
  await admin.getByRole("button", { name: "Reverse payment" }).click();
  await expect(admin.getByTestId("supplier-balance")).toContainText("20.00");
  await expect(admin.getByRole("cell", { name: "Payment reversed" })).toBeVisible();
  await expect(admin.getByText("Reversed", { exact: true })).toBeVisible();

  await admin.getByRole("link", { name: "All supplier balances" }).click();
  await expect(admin.getByRole("link", { name: "Supplier balances" })).toHaveAttribute("aria-current", "page");
  const reportRow = admin.getByRole("row").filter({ hasText: supplier });
  await expect(reportRow).toContainText("20.00");
  await adminContext.close();

  const managerContext = await browser.newContext({ storageState: storageStateFor("managerA") });
  const manager = await managerContext.newPage();
  await manager.goto(accountUrl);
  await expect(manager.getByRole("heading", { name: "No access to purchasing" })).toBeVisible();
  await managerContext.close();
});
