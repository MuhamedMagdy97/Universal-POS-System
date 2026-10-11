import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";

/** Inventory in Arabic (T4.8, I-20): RTL layout, LTR quantities and SKUs, Arabic-Indic digits accepted. */
test.use({ storageState: storageStateFor("adminA") });

const MAIN = E2E_ORGS.A.branchId;

test("the stock screens render right-to-left and take Arabic-Indic quantities", async ({ page }) => {
  const run = Date.now().toString(36).toUpperCase();
  const sku = `RTL-${run}`;
  const name = `Rtl Item ${run}`;
  await createRunProduct(E2E_ORGS.A.id, sku, name);

  await page.goto(`/inventory?branch=${MAIN}`);
  await page.getByRole("button", { name: "Switch to Arabic" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "المخزون", level: 1 })).toBeVisible();

  // The opening grid takes ٣ (Arabic-Indic three) and stores 3.
  await page.goto(`/inventory/opening?branch=${MAIN}&q=${sku}`);
  await page.getByRole("textbox", { name: `${name} الكمية` }).fill("٣");
  await page.getByRole("button", { name: "حفظ الرصيد الافتتاحي" }).click();
  await expect(page.getByRole("status")).toContainText("تم حفظ الرصيد الافتتاحي");

  // The SKU and the quantity stay left-to-right, with Latin digits.
  await page.goto(`/inventory?branch=${MAIN}&q=${sku}`);
  const row = page.getByRole("row").filter({ hasText: sku });
  await expect(row.locator('td[dir="ltr"]').first()).toHaveText(sku);
  await expect(row.locator('td[dir="ltr"]').nth(1)).toHaveText("3");
});
