import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { e2eQuery } from "./support/db";
import { createRunProduct } from "./support/inventory";
import { onHand } from "./support/pos";

/**
 * Receiving without a PO (direct-receipt-spec): a manager receives stock straight from a supplier;
 * stock and last cost follow and the receipt is listed under direct receipts.
 */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;

const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

test.use({ storageState: storageStateFor("managerA") });

test("a manager receives stock without a PO; stock, cost and the list follow", async ({ page }) => {
  const run = runId();
  const supplier = `Direct ${run}`;
  const sku = `DRC-${run}`;
  const productId = await createRunProduct(ORG, sku, `Direct item ${run}`);
  // Managers receive but do not manage suppliers: the supplier is set up directly.
  await e2eQuery(
    `INSERT INTO "Supplier" ("id", "orgId", "name", "updatedAt") VALUES (gen_random_uuid(), $1, $2, now())`,
    [ORG, supplier],
  );

  await page.goto("/purchasing");
  await expect(page.getByRole("link", { name: "Receive without PO" })).toHaveAttribute("href", "/purchasing/receive");
  // A full load: the list stays mounted (hidden) after a client navigation and has a Supplier filter too.
  await page.goto("/purchasing/receive");
  await expect(page.getByRole("heading", { name: "Receive stock without a purchase order" })).toBeVisible();
  await page.getByLabel("Supplier").selectOption({ label: supplier });
  const branchPicker = page.getByLabel("Branch");
  if ((await branchPicker.count()) > 0) await branchPicker.selectOption(MAIN);
  await page.getByRole("textbox", { name: "Add items" }).fill(sku);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("listitem").filter({ hasText: sku }).getByRole("button", { name: "Add" }).click();
  await page.getByRole("textbox", { name: `Received ${sku}` }).fill("3");
  await page.getByRole("textbox", { name: `Unit cost ${sku}` }).fill("7.25");
  await page.getByRole("button", { name: "Receive stock" }).click();

  await expect(page).toHaveURL(/\/purchasing\?received=1$/);
  await expect(page.getByRole("status")).toHaveText("Stock received.");
  await expect(
    page.getByRole("region", { name: "Direct receipts" }).getByRole("row").filter({ hasText: supplier }),
  ).toContainText("21.75");
  expect(await onHand(ORG, MAIN, productId)).toBe(3);
  const [row] = await e2eQuery<{ costMinor: number }>(`SELECT "costMinor" FROM "Product" WHERE "id" = $1`, [productId]);
  expect(row?.costMinor).toBe(725);
});
