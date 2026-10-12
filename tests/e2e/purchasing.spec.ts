import { expect, test, type Page } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { e2eQuery } from "./support/db";
import { createRunProduct } from "./support/inventory";
import { onHand } from "./support/pos";

/**
 * Purchasing (T5): an admin raises and orders a PO, a manager receives it in two parts, stock and
 * cost follow. A cashier has no purchasing; the list renders right-to-left in Arabic.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;

const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

async function addItem(page: Page, sku: string, qty: string, cost: string) {
  await page.getByRole("textbox", { name: "Add items" }).fill(sku);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("listitem").filter({ hasText: sku }).getByRole("button", { name: "Add" }).click();
  await page.getByRole("textbox", { name: `Ordered ${sku}` }).fill(qty);
  await page.getByRole("textbox", { name: `Unit cost ${sku}` }).fill(cost);
}

async function costOf(productId: string): Promise<number> {
  const rows = await e2eQuery<{ costMinor: number }>(`SELECT "costMinor" FROM "Product" WHERE "id" = $1`, [productId]);
  return rows[0]?.costMinor ?? -1;
}

test("an admin orders, a manager receives in two parts, stock and cost follow", async ({ browser }) => {
  const run = runId();
  const supplier = `Supplier ${run}`;
  const skuA = `PUR-A-${run}`;
  const skuB = `PUR-B-${run}`;
  const productA = await createRunProduct(ORG, skuA, `Purchase A ${run}`);
  const productB = await createRunProduct(ORG, skuB, `Purchase B ${run}`);

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
  await addItem(admin, skuA, "6", "5.50");
  await addItem(admin, skuB, "2", "12.50");
  // 6 × 5.50 + 2 × 12.50 = 58.00
  await expect(admin.getByRole("row").filter({ hasText: "Total" })).toContainText("58.00");
  await admin.getByRole("button", { name: "Create draft" }).click();
  await expect(admin).toHaveURL(/\/purchasing\/[0-9a-f-]{36}$/);
  const poUrl = new URL(admin.url()).pathname;
  await expect(admin.getByTestId("po-status")).toHaveText("Draft");

  await admin.getByRole("button", { name: "Mark as ordered" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Mark as ordered" }).click();
  await expect(admin.getByTestId("po-status")).toHaveText("Ordered");
  await adminContext.close();

  const managerContext = await browser.newContext({ storageState: storageStateFor("managerA") });
  const manager = await managerContext.newPage();
  await manager.goto(poUrl);
  // Managers receive but do not manage POs.
  await expect(manager.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  await manager.getByRole("link", { name: "Receive goods" }).click();

  await manager.getByRole("textbox", { name: `Receiving now ${skuA}` }).fill("4");
  await manager.getByRole("textbox", { name: `Receiving now ${skuB}` }).fill("0");
  await manager.getByRole("button", { name: "Receive 4 units" }).click();
  await expect(manager).toHaveURL(new RegExp(`${poUrl}\\?received=1$`));
  await expect(manager.getByTestId("po-status")).toHaveText("Partly received");
  expect(await onHand(ORG, MAIN, productA)).toBe(4);
  expect(await onHand(ORG, MAIN, productB)).toBe(0);
  expect(await costOf(productA)).toBe(550);

  await manager.getByRole("link", { name: "Receive goods" }).click();
  await expect(manager.getByRole("textbox", { name: `Receiving now ${skuA}` })).toHaveValue("2");
  await manager.getByRole("textbox", { name: `Unit cost ${skuB}` }).fill("13");
  await manager.getByRole("button", { name: "Receive 4 units" }).click();
  await expect(manager.getByTestId("po-status")).toHaveText("Received");
  expect(await onHand(ORG, MAIN, productA)).toBe(6);
  expect(await onHand(ORG, MAIN, productB)).toBe(2);
  expect(await costOf(productB)).toBe(1300);
  await expect(manager.getByRole("link", { name: "Receive goods" })).toHaveCount(0);
  await managerContext.close();
});

test.describe("cashier", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("has no purchasing link and is refused at /purchasing", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Purchasing" })).toHaveCount(
      0,
    );
    await page.goto("/purchasing");
    await expect(page.getByRole("heading", { name: "No access to purchasing" })).toBeVisible();
  });
});

test.describe("arabic", () => {
  test.use({ storageState: storageStateFor("adminA") });

  test("the purchase order list renders right-to-left", async ({ page }) => {
    await page.goto("/purchasing?status=all");
    await page.getByRole("button", { name: "Switch to Arabic" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: "أوامر الشراء", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "أمر شراء جديد" })).toBeVisible();
  });
});
