import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";

/** Reorder point → stock drops below it → the item is on Low stock (low-stock-spec §4). */
test.use({ storageState: storageStateFor("adminA") });

const MAIN = E2E_ORGS.A.branchId;

test("sets a reorder point, adjusts below it and finds the item on Low stock", async ({ page }) => {
  const run = Date.now().toString(36).toUpperCase();
  const sku = `LOW-${run}`;
  const name = `Low Item ${run}`;
  await createRunProduct(E2E_ORGS.A.id, sku, name);

  await page.goto(`/inventory/opening?branch=${MAIN}&q=${sku}`);
  await page.getByRole("textbox", { name: `${name} Quantity` }).fill("5");
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toContainText("Opening stock saved");

  // 1. Reorder point 3 on the stock list.
  await page.goto(`/inventory?branch=${MAIN}&q=${sku}`);
  const row = page.getByRole("row").filter({ hasText: sku });
  const pointCell = row.getByRole("cell").nth(4); // after On hand and Incoming
  await expect(pointCell).toHaveText("—");
  await row.getByRole("button", { name: "Reorder point", exact: true }).click();
  const pointDialog = page.getByRole("dialog", { name: `Reorder point: ${name}` });
  await pointDialog.getByLabel("Minimum quantity").fill("3");
  await pointDialog.getByRole("button", { name: "Save" }).click();
  await expect(pointDialog).toBeHidden();
  await expect(pointCell).toHaveText("3");

  // Not low yet at 5 on hand.
  await page.goto(`/inventory/low-stock?branch=${MAIN}`);
  await expect(page.getByRole("row").filter({ hasText: sku })).toHaveCount(0);

  // 2. Two damaged: 3 on hand, at the point.
  await page.goto(`/inventory?branch=${MAIN}&q=${sku}`);
  await row.getByRole("button", { name: "Adjust", exact: true }).click();
  const adjust = page.getByRole("dialog", { name: `Adjust stock: ${name}` });
  await adjust.getByLabel("Reason").selectOption("DAMAGED");
  await adjust.getByLabel("Quantity").fill("2");
  await adjust.getByRole("button", { name: "Save adjustment" }).click();
  await expect(adjust).toBeHidden();
  await expect(pointCell).toContainText("Low");

  // 3. Low stock lists it with the shortfall and offers a CSV export; the dashboard counts it.
  await page.goto(`/inventory/low-stock?branch=${MAIN}`);
  const lowRow = page.getByRole("row").filter({ hasText: sku });
  await expect(lowRow.getByRole("cell")).toHaveText([name, sku, "3", "3", "0"]);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe(`low-stock_${MAIN}.csv`);

  await page.goto("/dashboard");
  const tile = page.getByRole("link", { name: /Low stock at/ });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("href", /\/inventory\/low-stock\?branch=/);
});
