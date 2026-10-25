import { expect, test, type Page } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { e2eQuery } from "./support/db";
import { E2E_BASE_URL } from "./support/env";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";
import { newShop, run } from "./support/shop";

/**
 * Tables and open tickets (restaurant-cafe-spec R2-R6, R10, R13): a café sets up four tables, opens table 4, sends
 * two teas and a croissant to the kitchen, a second till sees the open table, a water is added and sent later, and
 * the ticket is paid. A takeaway is held and paid.
 */

const en = MESSAGES.en;
const ar = MESSAGES.ar;

/** Scans a code and waits for its line, so the next scan does not race it. */
async function scan(page: Page, code: string, name: string, qty: string) {
  const search = page.getByRole("textbox", { name: "Scan or search items" });
  await search.fill(code);
  await search.press("Enter");
  await expect(page.getByRole("textbox", { name: `Quantity for ${name}` })).toHaveValue(qty);
}

test("a café runs table 4 from order to payment, and holds a takeaway", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { orgId, branchId, email } = await newShop(page, "Restaurant / café");
  const skus = {
    tea: `TEA-${run().toUpperCase()}`,
    croissant: `CRO-${run().toUpperCase()}`,
    water: `WAT-${run().toUpperCase()}`,
  };
  for (const [key, sku] of Object.entries(skus)) {
    const id = await createRunProduct(orgId, sku, key === "tea" ? "Tea" : key === "croissant" ? "Croissant" : "Water");
    await openRunStock(orgId, branchId, id, 20, email);
  }
  const registerId = await createRunRegister(orgId, branchId, "Counter");

  // Settings → Tables: four tables.
  await page.goto("/settings/tables");
  const card = page.getByRole("form").first();
  for (let i = 0; i < 4; i += 1) await card.getByRole("button", { name: en["settings.tables.add"] }).click();
  await card.getByRole("button", { name: en["settings.shop.save"] }).click();
  await expect(card.getByRole("status")).toHaveText(en["settings.shop.saved"]);

  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await page.getByLabel(/Opening cash in the drawer/).fill("100");
  await page.getByRole("button", { name: "Open shift" }).click();

  // The floor is the start screen: open table 4.
  await page.getByRole("button", { name: "Table 4, free" }).click();
  await expect(page.getByTestId("ticket-place")).toHaveText("Table 4 · Ticket 1");
  await scan(page, skus.tea, "Tea", "1");
  await scan(page, skus.tea, "Tea", "2");
  await scan(page, skus.croissant, "Croissant", "1");
  await page.getByRole("button", { name: "Note for Croissant" }).click();
  await page.getByRole("textbox", { name: "Note for Croissant" }).fill("warm it");
  await page.getByRole("textbox", { name: "Note for Croissant" }).press("Enter");
  await page.getByRole("button", { name: en["pos.ticket.send"] }).click();
  const slip = page.getByTestId("kitchen-slip");
  await expect(slip).toContainText("Table 4");
  await expect(slip).toContainText("2 × Tea");
  await expect(slip).toContainText("“warm it”");
  await expect(page.getByTestId("line-sent").first()).toHaveText("Sent 2");

  // A second till in the same shop sees table 4 as open.
  const other = await browser.newContext({ storageState: await context.storageState() });
  const second = await other.newPage();
  await second.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await expect(second.getByRole("button", { name: /^Table 4, open, EGP 30\.00/ })).toBeVisible();
  await other.close();

  // A water later: only it goes to the kitchen.
  await scan(page, skus.water, "Water", "1");
  await page.getByRole("button", { name: en["pos.ticket.send"] }).click();
  await expect(slip).toContainText("1 × Water");
  await expect(slip).not.toContainText("Tea");

  await page.getByLabel(/Cash received/).fill("50");
  await page.getByRole("button", { name: /^Charge/ }).click();
  await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
  const [paid] = await e2eQuery<{ status: string; orderType: string; tableName: string; lines: number }>(
    `SELECT t."status"::text AS "status", s."orderType"::text AS "orderType", s."tableName",
            (SELECT COUNT(*)::int FROM "SaleItem" i WHERE i."saleId" = s."id") AS "lines"
       FROM "Ticket" t JOIN "Sale" s ON s."id" = t."saleId" WHERE t."orgId" = $1 AND t."number" = 1`,
    [orgId],
  );
  expect(paid).toEqual({ status: "PAID", orderType: "DINE_IN", tableName: "4", lines: 3 });

  // A takeaway: held, picked up from the floor, paid.
  await page.getByRole("button", { name: /New sale/ }).click();
  await expect(page.getByRole("button", { name: "Table 4, free" })).toBeVisible();
  await scan(page, skus.tea, "Tea", "1");
  await page.getByRole("button", { name: en["pos.ticket.hold"] }).click();
  await page.getByRole("button", { name: /^Takeaway #2/ }).click();
  await expect(page.getByTestId("ticket-place")).toHaveText("Takeaway · Ticket 2");
  await page.getByLabel(/Cash received/).fill("10");
  await page.getByRole("button", { name: /^Charge/ }).click();
  await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
  const [takeaway] = await e2eQuery<{ orderType: string }>(
    `SELECT s."orderType"::text AS "orderType" FROM "Ticket" t JOIN "Sale" s ON s."id" = t."saleId"
      WHERE t."orgId" = $1 AND t."number" = 2`,
    [orgId],
  );
  expect(takeaway.orderType).toBe("TAKEAWAY");

  // In Arabic the floor reads in Arabic.
  await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await expect(page.getByRole("region", { name: ar["pos.tables.title"] })).toBeVisible();
  await context.close();
});
