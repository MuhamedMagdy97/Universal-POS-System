import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { onHand } from "./support/pos";

/**
 * Purchase returns (purchase-returns-spec): an admin receives a PO, returns part of it to the
 * supplier, stock follows, the return page prints, and a manager gets no return button.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;

const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

test("an admin returns received goods to the supplier", async ({ browser }) => {
  const run = runId();
  const supplier = `Return supplier ${run}`;
  const sku = `RET-${run}`;
  const productId = await createRunProduct(ORG, sku, `Return item ${run}`);

  const adminContext = await browser.newContext({ storageState: storageStateFor("adminA") });
  const admin = await adminContext.newPage();
  await admin.goto("/purchasing/suppliers");
  await admin.getByRole("button", { name: "Add supplier" }).click();
  await admin.getByLabel("Name").fill(supplier);
  await admin.getByRole("button", { name: "Save" }).click();
  await expect(admin.getByRole("cell", { name: supplier })).toBeVisible();

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
  const poUrl = new URL(admin.url()).pathname;
  // Nothing received yet: nothing to return.
  await expect(admin.getByRole("link", { name: "Return to supplier" })).toHaveCount(0);
  await admin.getByRole("button", { name: "Mark as ordered" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Mark as ordered" }).click();
  await admin.getByRole("link", { name: "Receive goods" }).click();
  await admin.getByRole("button", { name: "Receive 5 units" }).click();
  await expect(admin.getByTestId("po-status")).toHaveText("Received");
  expect(await onHand(ORG, MAIN, productId)).toBe(5);

  await admin.getByRole("link", { name: "Return to supplier" }).click();
  // Next keeps the receive form mounted (hidden) after navigating, so scope to the return form.
  const form = admin.locator("form").filter({ has: admin.getByLabel("Reason") });
  await admin.getByRole("textbox", { name: `Returning now ${sku}` }).fill("6");
  await expect(admin.getByRole("button", { name: /^Return \d+ units$/ })).toBeDisabled();
  await admin.getByRole("textbox", { name: `Returning now ${sku}` }).fill("2");
  await admin.getByLabel("Reason").selectOption("WRONG_ITEM");
  await form.getByLabel("Note (optional)").fill("Sent the wrong size");
  await admin.getByRole("button", { name: "Return 2 units" }).click();

  await expect(admin).toHaveURL(/\/returns\/[0-9a-f-]{36}\?returned=1$/);
  await expect(admin.getByRole("status")).toHaveText("Returned to the supplier.");
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(/^PO-\d{6}-R1$/);
  await expect(admin.getByTestId("return-reason")).toHaveText("Wrong item");
  expect(await onHand(ORG, MAIN, productId)).toBe(3);

  await admin.getByRole("button", { name: "Print return" }).click();
  const print = admin.locator(".print-root[data-active] [data-testid=return-print]");
  await expect(print).toContainText("Purchase return");
  await expect(print).toContainText(supplier);
  // 2 × 4.00 = 8.00
  await expect(print).toContainText("8.00");

  await admin.goto(poUrl);
  await expect(admin.getByRole("heading", { name: "Returns to supplier" })).toBeVisible();
  await expect(admin.getByRole("link", { name: /-R1: 2 units/ })).toBeVisible();
  await adminContext.close();

  const managerContext = await browser.newContext({ storageState: storageStateFor("managerA") });
  const manager = await managerContext.newPage();
  await manager.goto(poUrl);
  await expect(manager.getByRole("heading", { name: "Returns to supplier" })).toBeVisible();
  await expect(manager.getByRole("link", { name: "Return to supplier" })).toHaveCount(0);
  await manager.goto(`${poUrl}/return`);
  await expect(manager.getByRole("heading", { name: "No access to purchasing" })).toBeVisible();
  await managerContext.close();
});
