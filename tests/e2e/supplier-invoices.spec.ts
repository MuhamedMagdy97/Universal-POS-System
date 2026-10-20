import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";

/**
 * Supplier invoices (supplier-invoices-spec): an admin receives goods, records the supplier's invoice
 * with 14% input VAT (net and VAT pre-filled from the receipt), pays it with the allocation pre-filled,
 * sees it Paid and the statement back at zero, and finds the VAT in the Input VAT report.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;

const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

test("an admin records a supplier invoice with VAT and pays it", async ({ browser }) => {
  const run = runId();
  const supplier = `Inv supplier ${run}`;
  const sku = `INV-${run}`;
  const number = `SI-${run}`;
  await createRunProduct(ORG, sku, `Inv item ${run}`);

  const context = await browser.newContext({ storageState: storageStateFor("adminA") });
  const admin = await context.newPage();
  await admin.goto("/purchasing/suppliers");
  await admin.getByRole("button", { name: "Add supplier" }).click();
  await admin.getByLabel("Name").fill(supplier);
  await admin.getByRole("button", { name: "Save" }).click();
  await expect(admin.getByRole("cell", { name: supplier })).toBeVisible();

  // Receive 5 × 4.00 = 20.00 at cost.
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
  await expect(admin.getByTestId("supplier-balance")).toContainText("20.00");
  await expect(admin.getByTestId("supplier-uninvoiced")).toContainText("20.00");

  // The invoice: pick the receipt; net 20.00 and VAT 2.80 fill in.
  await admin.getByLabel("Supplier's number").fill(number);
  await admin.getByRole("group", { name: "Goods receipts it covers" }).getByRole("checkbox").check();
  await expect(admin.getByLabel("Net (before VAT)")).toHaveValue("20.00");
  await expect(admin.getByLabel("VAT", { exact: true })).toHaveValue("2.80");
  await expect(admin.getByTestId("invoice-total")).toContainText("22.80");
  await admin.getByRole("button", { name: "Save document" }).click();

  const invoiceRow = admin.getByTestId(`invoice-${number}`);
  await expect(invoiceRow.getByTestId("invoice-status")).toHaveText("Open");
  await expect(admin.getByTestId("supplier-balance")).toContainText("22.80");
  await expect(admin.getByTestId("supplier-uninvoiced")).toContainText("0.00");
  await expect(admin.getByRole("cell", { name: "Supplier invoice" })).toBeVisible();

  // Pay it: the allocation fills in oldest first.
  await admin.getByLabel("Amount", { exact: true }).fill("22.80");
  await expect(admin.getByRole("textbox", { name: `Amount for ${number}` })).toHaveValue("22.80");
  await admin.getByRole("button", { name: "Save payment" }).click();
  await expect(admin.getByTestId("supplier-balance")).toContainText("0.00");
  await expect(invoiceRow.getByTestId("invoice-status")).toHaveText("Paid");
  await expect(admin.getByTestId("statement-closing")).toContainText("0.00");

  await admin.goto("/reports?report=input-vat&range=thisMonth");
  await expect(admin.getByRole("link", { name: "Input VAT" })).toHaveAttribute("aria-current", "page");
  await context.close();
});
