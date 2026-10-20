import { expect, test } from "@playwright/test";
import { E2E_ORGS, E2E_SECOND_BRANCH_A } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";

/**
 * Two-step transfer (transit-transfers-spec §5): send in transit from Main, the goods show as
 * incoming at the second branch, receive them there with one unit short, print the transfer note.
 */
test.use({ storageState: storageStateFor("adminA") });

const MAIN = E2E_ORGS.A.branchId;
const SECOND = E2E_SECOND_BRANCH_A.id;

test("sends stock in transit and receives it with a shortfall", async ({ page }) => {
  const run = Date.now().toString(36).toUpperCase();
  const sku = `TRN-${run}`;
  const name = `Transit Item ${run}`;
  await createRunProduct(E2E_ORGS.A.id, sku, name);

  await page.goto(`/inventory/opening?branch=${MAIN}&q=${sku}`);
  await page.getByRole("textbox", { name: `${name} Quantity` }).fill("5");
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toContainText("Opening stock saved");

  // 1. Send 3 in transit.
  await page.goto(`/inventory/transfer?branch=${MAIN}`);
  await page.getByRole("textbox", { name: "Search items" }).fill(sku);
  await page.getByRole("textbox", { name: "Search items" }).press("Enter");
  await page.getByRole("button", { name: "Add item" }).first().click();
  await page.getByRole("textbox", { name: "Quantity" }).fill("3");
  await page.getByLabel("To branch").selectOption({ label: E2E_SECOND_BRANCH_A.name });
  await page.getByRole("radio", { name: /Send in transit/ }).check();
  await page.getByRole("button", { name: "Send transfer" }).click();

  await expect(page).toHaveURL(/\/inventory\/transfers\/[0-9a-f-]{36}\?sent=1$/);
  await expect(page.getByTestId("transfer-status")).toHaveText("In transit");
  const transferUrl = page.url().replace(/\?.*$/, "");

  // 2. Main has 2 left; the second branch has nothing on hand and 3 incoming.
  await page.goto(`/inventory?branch=${MAIN}&q=${sku}`);
  await expect(page.getByRole("row").filter({ hasText: sku }).getByRole("cell").nth(2)).toHaveText("2");
  await page.goto(`/inventory?branch=${SECOND}&q=${sku}`);
  const secondRow = page.getByRole("row").filter({ hasText: sku });
  await expect(secondRow.getByRole("cell").nth(2)).toHaveText("0");
  await expect(secondRow.getByTestId("incoming")).toHaveText("3");

  // 3. It is listed as incoming at the second branch.
  await page.goto(`/inventory/transfers?branch=${SECOND}&dir=incoming`);
  await page.getByRole("link", { name: /^TR-/ }).first().click();
  await expect(page).toHaveURL(transferUrl);

  // 4. Receive 2 of 3; the short unit needs a reason before Receive is enabled.
  await page.getByRole("textbox", { name: `Received quantity: ${name}` }).fill("2");
  const receive = page.getByRole("button", { name: "Receive", exact: true });
  await expect(receive).toBeDisabled();
  await page.getByLabel(`Shortfall reason: ${name}`).selectOption("DAMAGED");
  await receive.click();
  await expect(page.getByTestId("transfer-status")).toHaveText("Received");
  await expect(page.getByRole("status")).toHaveText("Transfer received.");

  // 5. The note prints with the received and short quantities.
  await page.getByRole("button", { name: "Print transfer note" }).click();
  const print = page.locator(".print-root[data-active] [data-testid=transfer-print]");
  await expect(print).toContainText("Stock transfer note");
  await expect(print).toContainText(sku);
  await expect(print).toContainText("1 (Damaged)");

  // 6. Second branch: 2 on hand, nothing incoming.
  await page.goto(`/inventory?branch=${SECOND}&q=${sku}`);
  await expect(secondRow.getByRole("cell").nth(2)).toHaveText("2");
  await expect(secondRow.getByTestId("incoming")).toHaveText("—");
});

test("the transfers list renders right-to-left in Arabic", async ({ page }) => {
  await page.goto(`/inventory/transfers?branch=${MAIN}`);
  await page.getByRole("button", { name: "Switch to Arabic" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "التحويلات", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "صادر" })).toHaveAttribute("aria-current", "page");
});
