import { expect, test } from "@playwright/test";
import { E2E_ORGS, E2E_SECOND_BRANCH_A } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";

/** Inventory happy path for an admin: opening stock, adjustment, transfer and item history (T4.8). */
test.use({ storageState: storageStateFor("adminA") });

const MAIN = E2E_ORGS.A.branchId;
const SECOND = E2E_SECOND_BRANCH_A.id;

test("opens stock, adjusts it, transfers one unit and shows the history", async ({ page }) => {
  const run = Date.now().toString(36).toUpperCase();
  const sku = `INV-${run}`;
  const name = `Inv Item ${run}`;
  const productId = await createRunProduct(E2E_ORGS.A.id, sku, name);

  // 1. Opening stock on Main: 5 units.
  await page.goto(`/inventory/opening?branch=${MAIN}&q=${sku}`);
  await page.getByRole("textbox", { name: `${name} Quantity` }).fill("5");
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toContainText("Opening stock saved");

  // 2. Adjust: 2 damaged, so 3 remain. The search also lists a second item (same SKU prefix), so the
  //    page holds two dialogs; the one that opens must be named after the clicked row.
  await createRunProduct(E2E_ORGS.A.id, `${sku}-B`, `${name} B`);
  await page.goto(`/inventory?branch=${MAIN}&q=${sku}`);
  const adjustButton = { name: "Adjust", exact: true } as const;
  const otherDialog = page.getByRole("dialog", { name: `Adjust stock: ${name} B` });
  await page
    .getByRole("row")
    .filter({ hasText: `${sku}-B` })
    .getByRole("button", adjustButton)
    .click();
  await expect(otherDialog).toBeVisible();
  await otherDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(otherDialog).toBeHidden();

  const mainRow = page
    .getByRole("row")
    .filter({ hasText: sku })
    .filter({ hasNotText: `${sku}-B` });
  // The on-hand column (the row's text also contains the closed dialog, so assert on the cell).
  const onHandCell = mainRow.getByRole("cell").nth(2);
  await expect(onHandCell).toHaveText("5");
  await mainRow.getByRole("button", adjustButton).click();
  const dialog = page.getByRole("dialog", { name: `Adjust stock: ${name}`, exact: true });
  await dialog.getByLabel("Reason").selectOption("DAMAGED");
  await dialog.getByLabel("Quantity").fill("2");
  await dialog.getByRole("button", { name: "Save adjustment" }).click();
  await expect(dialog).toBeHidden();
  await expect(onHandCell).toHaveText("3");

  // Re-opening starts a fresh form: the last reason and quantity are not kept.
  await mainRow.getByRole("button", adjustButton).click();
  await expect(dialog.getByLabel("Reason")).toHaveValue("COUNT_CORRECTION");
  await expect(dialog.getByRole("textbox", { name: "Counted quantity", exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // 3. Transfer one unit to the second branch.
  await page.goto(`/inventory/transfer?branch=${MAIN}`);
  await page.getByRole("textbox", { name: "Search items" }).fill(sku);
  await page.getByRole("textbox", { name: "Search items" }).press("Enter");
  await page.getByRole("button", { name: "Add item" }).first().click();
  await page.getByLabel("To branch").selectOption({ label: E2E_SECOND_BRANCH_A.name });
  await page.getByRole("button", { name: "Transfer stock" }).click();
  await expect(page.getByRole("status")).toContainText("Transfer saved. Items moved: 1");

  // 4. The second branch holds the unit; Main's history shows each step.
  await page.goto(`/inventory?branch=${SECOND}&q=${sku}`);
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: sku })
      .filter({ hasNotText: `${sku}-B` }),
  ).toContainText("1");
  await page.goto(`/inventory/items/${productId}?branch=${MAIN}`);
  const history = page.getByRole("table");
  await expect(history.getByText("Opening stock")).toBeVisible();
  await expect(history.getByText("Damaged")).toBeVisible();
  await expect(history.getByText("Transfer out")).toBeVisible();
});
