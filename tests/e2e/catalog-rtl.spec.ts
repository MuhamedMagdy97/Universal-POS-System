import { expect, test } from "@playwright/test";
import { E2E_FIXTURES } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";

/** C-7: Arabic UI is RTL, shows Arabic names, keeps SKUs LTR and formats prices in the org currency. */
test.use({ storageState: storageStateFor("adminA") });

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;

test("switching to Arabic renders the catalog right-to-left", async ({ page }) => {
  const { sku, name, nameAr, priceMinor } = E2E_FIXTURES.arabic;
  // Same formatter settings as lib/money.ts formatMinor (Latin digits, 2 decimals for EGP).
  const expectedPrice = new Intl.NumberFormat("ar", {
    style: "currency",
    currency: "EGP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    numberingSystem: "latn",
  }).format(priceMinor / 100);

  await page.goto("/catalog/products");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.getByRole("button", { name: "Switch to Arabic" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");

  // Server-rendered in Arabic after a full load too.
  await page.goto(`/catalog/products?q=${encodeURIComponent("قهوة")}`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");

  const row = page.getByRole("row").filter({ hasText: sku });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("link", { name: nameAr })).toBeVisible();
  await expect(row).not.toContainText(name);

  const skuCell = row.getByRole("cell").filter({ hasText: sku });
  await expect(skuCell).toHaveAttribute("dir", "ltr");

  await expect(row).toContainText(expectedPrice);
  await expect(row).toContainText("12.50");
  expect(await row.textContent()).not.toMatch(ARABIC_INDIC_DIGITS);

  // Back to English.
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
