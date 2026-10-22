import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { e2eQuery } from "./support/db";
import { createRunProduct } from "./support/inventory";
import { onHand } from "./support/pos";

/**
 * Returns against a direct receipt (direct-receipt-returns-spec): an admin receives without a PO,
 * returns part of it from the receipt page, stock follows, the return prints, and it reads in Arabic.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;

const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

test("an admin returns goods from a direct receipt", async ({ browser }) => {
  const run = runId();
  const supplier = `Direct return ${run}`;
  const sku = `DRR-${run}`;
  const productId = await createRunProduct(ORG, sku, `Direct return item ${run}`);
  await e2eQuery(
    `INSERT INTO "Supplier" ("id", "orgId", "name", "updatedAt") VALUES (gen_random_uuid(), $1, $2, now())`,
    [ORG, supplier],
  );

  const context = await browser.newContext({ storageState: storageStateFor("adminA") });
  const admin = await context.newPage();
  await admin.goto("/purchasing/receive");
  await admin.getByLabel("Supplier").selectOption({ label: supplier });
  const branchPicker = admin.getByLabel("Branch");
  if ((await branchPicker.count()) > 0) await branchPicker.selectOption(MAIN);
  await admin.getByRole("textbox", { name: "Add items" }).fill(sku);
  await admin.getByRole("button", { name: "Search", exact: true }).click();
  await admin.getByRole("listitem").filter({ hasText: sku }).getByRole("button", { name: "Add" }).click();
  await admin.getByRole("textbox", { name: `Received ${sku}` }).fill("4");
  await admin.getByRole("textbox", { name: `Unit cost ${sku}` }).fill("5");
  await admin.getByRole("button", { name: "Receive stock" }).click();
  await expect(admin).toHaveURL(/\/purchasing\?received=1$/);
  expect(await onHand(ORG, MAIN, productId)).toBe(4);

  await admin
    .getByRole("region", { name: "Direct receipts" })
    .getByRole("row")
    .filter({ hasText: supplier })
    .getByRole("link", { name: /^GR-/ })
    .click();
  await expect(admin).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
  const receiptUrl = new URL(admin.url()).pathname;
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(/^GR-[0-9A-F]{8}$/);

  await admin.getByRole("link", { name: "Return to supplier" }).click();
  const form = admin.locator("form").filter({ has: admin.getByLabel("Reason") });
  await form.getByRole("textbox", { name: `Returning now ${sku}` }).fill("5");
  await expect(form.getByRole("button", { name: /^Return \d+ units$/ })).toBeDisabled();
  await form.getByRole("textbox", { name: `Returning now ${sku}` }).fill("1");
  await form.getByLabel("Reason").selectOption("DAMAGED");
  await form.getByRole("button", { name: "Return 1 units" }).click();

  await expect(admin).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}\/returns\/[0-9a-f-]{36}\?returned=1$/);
  await expect(admin.getByRole("status")).toHaveText("Returned to the supplier.");
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(/^GR-[0-9A-F]{8}-R1$/);
  await expect(admin.getByTestId("return-reason")).toHaveText("Damaged");
  expect(await onHand(ORG, MAIN, productId)).toBe(3);
  const returnUrl = new URL(admin.url()).pathname;

  await admin.getByRole("button", { name: "Print return" }).click();
  const print = admin.locator(".print-root[data-active] [data-testid=return-print]");
  await expect(print).toContainText("Purchase return");
  await expect(print).toContainText("Goods receipt");
  await expect(print).toContainText(supplier);
  await expect(print).toContainText("5.00");

  await admin.goto(receiptUrl);
  await expect(admin.getByRole("heading", { name: "Returns to supplier" })).toBeVisible();
  await expect(admin.getByRole("link", { name: /-R1: 1 units/ })).toBeVisible();

  await admin.goto(returnUrl);
  await admin.getByRole("button", { name: "Switch to Arabic" }).click();
  await expect(admin.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(admin.getByText("إيصال الاستلام", { exact: true }).first()).toBeVisible();
  await context.close();
});
