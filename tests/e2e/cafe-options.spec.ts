import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { e2eQuery } from "./support/db";
import { E2E_BASE_URL } from "./support/env";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";
import { newShop, run } from "./support/shop";

/**
 * Options and notes (restaurant-cafe-spec R7, R8, R13): a café owner makes a Size group (Regular, Large +5.00) and
 * an Extras group (Extra shot +3.00) in Catalog → Options, links them to the cappuccino, and the till sells a large
 * cappuccino with an extra shot and a croissant with a note.
 */

const en = MESSAGES.en;
const ar = MESSAGES.ar;

test("a café sells a cappuccino with options and a croissant with a note", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { orgId, branchId, email } = await newShop(page, "Restaurant / café");
  const sku = `CAP-${run().toUpperCase()}`;
  const coffee = await createRunProduct(orgId, sku, "Cappuccino");
  const croissantSku = `CRO-${run().toUpperCase()}`;
  const croissant = await createRunProduct(orgId, croissantSku, "Croissant");
  await e2eQuery(`UPDATE "Product" SET "priceMinor" = 3000, "nameAr" = 'كابتشينو' WHERE "id" = $1`, [coffee]);
  await openRunStock(orgId, branchId, coffee, 20, email);
  await openRunStock(orgId, branchId, croissant, 20, email);
  const registerId = await createRunRegister(orgId, branchId, "Counter");

  // Catalog → Options: two groups.
  await page.goto("/catalog/options");
  const fresh = page.getByRole("form", { name: en["catalog.options.new"] });
  await fresh.getByLabel(en["catalog.form.name"]).fill("Size");
  await fresh.getByLabel(en["catalog.form.nameAr"]).first().fill("الحجم");
  await fresh.getByLabel(en["catalog.options.min"]).fill("1");
  await fresh.getByLabel("Choice 1 name", { exact: true }).fill("Regular");
  await fresh.getByRole("button", { name: en["catalog.options.addChoice"] }).click();
  await fresh.getByLabel("Choice 2 name", { exact: true }).fill("Large");
  await fresh.getByLabel("Choice 2 extra price").fill("5");
  await fresh.getByRole("button", { name: en["catalog.options.create"] }).click();
  await expect(page.getByRole("form", { name: "Size" })).toBeVisible();
  await fresh.getByLabel(en["catalog.form.name"]).fill("Extras");
  await fresh.getByLabel(en["catalog.options.max"]).fill("2");
  await fresh.getByLabel("Choice 1 name", { exact: true }).fill("Extra shot");
  await fresh.getByLabel("Choice 1 extra price").fill("3");
  await fresh.getByRole("button", { name: en["catalog.options.create"] }).click();
  await expect(page.getByRole("form", { name: "Extras" })).toBeVisible();

  // The cappuccino's page: tick both groups.
  await page.goto(`/catalog/products/${coffee}`);
  const groups = page.getByRole("region", { name: en["catalog.options.groups"] });
  await groups.getByRole("checkbox", { name: "Size" }).check();
  await groups.getByRole("checkbox", { name: "Extras" }).check();
  await groups.getByRole("button", { name: en["catalog.options.save"] }).click();
  await expect(groups.getByRole("status")).toHaveText(en["catalog.options.groupsSaved"]);

  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await page.getByLabel(/Opening cash in the drawer/).fill("100");
  await page.getByRole("button", { name: "Open shift" }).click();
  const search = page.getByRole("textbox", { name: "Scan or search items" });
  await search.fill(sku);
  await search.press("Enter");

  // The picker: Regular is preselected; Large and an extra shot make 38.00.
  const picker = page.getByTestId("options-picker");
  await expect(picker.getByRole("radio", { name: "Regular" })).toBeChecked();
  await picker.getByRole("radio", { name: /Large/ }).check();
  await picker.getByRole("checkbox", { name: /Extra shot/ }).check();
  await picker.getByRole("button", { name: /^Add, EGP 38\.00/ }).click();
  await expect(page.getByText("Large · Extra shot")).toBeVisible();

  await search.fill(croissantSku);
  await search.press("Enter");
  await page.getByRole("button", { name: "Note for Croissant" }).click();
  const note = page.getByRole("textbox", { name: "Note for Croissant" });
  await note.fill("warm it");
  await note.press("Enter");
  await expect(page.getByTestId("line-note")).toHaveText("“warm it”");
  await expect(page.getByTestId("till-total")).toContainText("48.00");

  await page.getByLabel(/Cash received/).fill("50");
  await page.getByRole("button", { name: /^Charge/ }).click();
  await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
  await expect(page.getByText("Large · Extra shot")).toBeVisible();
  await expect(page.getByText("“warm it”")).toBeVisible();
  const lines = await e2eQuery<{ unitPriceMinor: number; note: string | null }>(
    `SELECT "unitPriceMinor", "note" FROM "SaleItem" WHERE "orgId" = $1 ORDER BY "unitPriceMinor" DESC`,
    [orgId],
  );
  expect(lines).toEqual([
    { unitPriceMinor: 3_800, note: null },
    { unitPriceMinor: 1_000, note: "warm it" },
  ]);

  // In Arabic the picker reads the Arabic group name.
  await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  const searchAr = page.getByRole("textbox", { name: ar["pos.search.label"] });
  await searchAr.fill(sku);
  await searchAr.press("Enter");
  await expect(page.getByTestId("options-picker")).toContainText("الحجم");
  await context.close();
});
