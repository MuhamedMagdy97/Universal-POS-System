import { expect, test } from "@playwright/test";
import { storageStateFor } from "./support/auth";

/**
 * C-1, C-4, C-5, C-22, C-24: an Admin creates a product with a scanned barcode,
 * finds it, edits the price, archives and restores it — keyboard only (no mouse).
 */
test.use({ storageState: storageStateFor("adminA") });

test("admin creates, finds, edits, archives and restores a product with the keyboard", async ({ page }) => {
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
  const name = `Keyboard Kettle ${run}`;
  const sku = `E2E-KB-${run}`;
  const barcode = `29${Date.now()}`.slice(0, 13);

  // List: the search box is autofocused; Shift+Tab reaches "Add product".
  await page.goto("/catalog/products");
  const search = page.getByRole("searchbox", { name: "Search" });
  await expect(search).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("link", { name: "Add product" })).toBeFocused();
  await page.keyboard.press("Enter");

  // New product: name is autofocused; Tab moves to the Arabic name.
  await expect(page).toHaveURL(/\/catalog\/products\/new$/);
  await expect(page.getByRole("heading", { name: "New product" })).toBeVisible();
  const nameField = page.getByRole("textbox", { name: /Name \(English\)/ });
  await expect(nameField).toBeFocused();
  await page.keyboard.type(name);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: /Name \(Arabic\)/ })).toBeFocused();
  await page.keyboard.type("غلاية كهربائية");

  await page.getByRole("textbox", { name: /^SKU/ }).focus();
  await page.keyboard.type(sku);
  await page.getByRole("textbox", { name: /^Price/ }).focus();
  await page.keyboard.type("12.50");

  // A keyboard-wedge scanner types the code and sends Enter: chip added, field cleared, focus kept.
  const scan = page.getByRole("textbox", { name: "Scan or type barcode" });
  await scan.focus();
  await page.keyboard.type(barcode);
  await page.keyboard.press("Enter");
  await expect(page.getByText(barcode, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(scan).toHaveValue("");
  await expect(scan).toBeFocused();
  await expect(page).toHaveURL(/\/catalog\/products\/new$/); // Enter did not submit the form

  // Ctrl+S saves and opens the edit page.
  await page.keyboard.press("Control+s");
  await expect(page).toHaveURL(/\/catalog\/products\/[0-9a-f-]{36}\?saved=1/);
  await expect(page.getByRole("heading", { name: "Edit product" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect(page.getByText(barcode, { exact: true }).filter({ visible: true })).toBeVisible();
  const productUrl = new URL(page.url()).pathname;

  // Find it via search (partial name) and open it from the results with the keyboard.
  await page.goto("/catalog/products");
  await expect(search).toBeFocused();
  await page.keyboard.type(run);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`q=${run}`));
  const row = page.getByRole("row").filter({ hasText: sku });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(name);
  await expect(row).toContainText("EGP 12.50");

  // Scanning the barcode into the search box opens the product directly.
  await page.goto("/catalog/products");
  await expect(search).toBeFocused();
  await page.keyboard.type(barcode);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(productUrl);

  // Edit the price.
  const price = page.getByRole("textbox", { name: /^Price/ });
  await price.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("15.75");
  await expect(page.getByText("Past sales keep their original price.").filter({ visible: true })).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect(price).toHaveValue("15.75");

  // Archive through the confirm dialog.
  await page.getByRole("button", { name: "Archive", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: new RegExp(`Archive ${name}`) });
  await expect(dialog).toBeVisible();
  // Escape closes the dialog without archiving.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Archive", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  // The confirm button has initial focus, so Enter archives (Cancel must not be the default).
  await expect(dialog.getByRole("button", { name: "Archive", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Product archived").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("This product is archived.", { exact: false }).filter({ visible: true })).toBeVisible();

  // Archived: gone from the default list, listed under the Archived filter.
  await page.goto(`/catalog/products?q=${run}`);
  await expect(page.getByText(`No match for “${run}”`).filter({ visible: true })).toBeVisible();
  await page.goto(`/catalog/products?q=${run}&status=archived`);
  const archivedRow = page.getByRole("row").filter({ hasText: sku });
  await expect(archivedRow).toContainText("Archived");
  await expect(archivedRow).toContainText("EGP 15.75");

  // Restore.
  await page.goto(productUrl);
  await page.getByRole("button", { name: "Restore" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Product restored").filter({ visible: true })).toBeVisible();
  await page.goto(`/catalog/products?q=${run}`);
  const restoredRow = page.getByRole("row").filter({ hasText: sku });
  await expect(restoredRow).toContainText("Active");
  await expect(restoredRow).toContainText("EGP 15.75");
});
