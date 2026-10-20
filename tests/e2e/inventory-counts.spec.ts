import { expect, test } from "@playwright/test";
import { E2E_ORGS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { e2eQuery } from "./support/db";
import { createRunProduct } from "./support/inventory";

/** Full stock count (stock-counts-spec): scan, type a quantity, review, post, and the stock follows. */
test.use({ storageState: storageStateFor("adminA") });

const ORG = E2E_ORGS.A.id;

test("counts a branch by scan and typed quantity, reviews and posts the differences", async ({ page }) => {
  const run = Date.now().toString(36).toUpperCase();
  const sku = `CNT-${run}`;
  const name = `Count Item ${run}`;
  const barcode = `99${Date.now()}`;
  // A branch of its own: only one count may be open per branch, and earlier runs leave posted counts.
  const [branch] = await e2eQuery<{ id: string }>(
    `INSERT INTO "Branch" ("id", "orgId", "name", "code", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, true, now(), now()) RETURNING "id"`,
    [ORG, `Count ${run}`, `CNT-${run}`],
  );
  const productId = await createRunProduct(ORG, sku, name);
  await createRunProduct(ORG, `${sku}-B`, `${name} B`);
  await e2eQuery(
    `INSERT INTO "Barcode" ("id", "orgId", "code", "productId", "isPrimary") VALUES (gen_random_uuid(), $1, $2, $3, true)`,
    [ORG, barcode, productId],
  );

  // Opening stock: 5 and 3.
  await page.goto(`/inventory/opening?branch=${branch.id}&q=${sku}`);
  await page.getByRole("textbox", { name: `${name} Quantity`, exact: true }).fill("5");
  await page.getByRole("textbox", { name: `${name} B Quantity` }).fill("3");
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toContainText("Opening stock saved");

  // New full count → draft → counting.
  await page.goto(`/inventory/counts?branch=${branch.id}`);
  await page.getByRole("button", { name: "Create count" }).click();
  await expect(page.getByTestId("count-status")).toHaveText("Draft");
  await page.getByRole("button", { name: "Start counting" }).click();
  await expect(page.getByTestId("count-status")).toHaveText("Counting");

  // Two scans of the barcode: 2 counted.
  const scan = page.getByRole("textbox", { name: "Scan a barcode or search" });
  await scan.fill(barcode);
  await scan.press("Enter");
  await expect(page.getByRole("status")).toHaveText(`${name}: 1`);
  await scan.fill(barcode);
  await scan.press("Enter");
  await expect(page.getByRole("status")).toHaveText(`${name}: 2`);

  // Item B by its SKU (two items match the prefix; the exact SKU wins), then a typed 4 replaces it.
  await scan.fill(`${sku}-B`);
  await scan.press("Enter");
  await expect(page.getByRole("status")).toHaveText(`${name} B: 1`);
  const qtyB = page.getByRole("textbox", { name: `Counted: ${name} B` });
  await qtyB.fill("4");
  await qtyB.press("Enter");
  await expect(page.getByRole("textbox", { name: `Counted: ${name} B` })).toHaveValue("4");
  await expect(page.getByRole("textbox", { name: `Counted: ${name}`, exact: true })).toHaveValue("2");

  // Review: expected, moved since, counted, difference.
  await page.getByRole("button", { name: "Review" }).click();
  const lineA = page
    .getByTestId("review-line")
    .filter({ hasText: sku })
    .filter({ hasNotText: `${sku}-B` });
  const lineB = page.getByTestId("review-line").filter({ hasText: `${sku}-B` });
  await expect(lineA.getByRole("cell")).toHaveText([name, sku, "5", "0", "2", "-3"]);
  await expect(lineB.getByRole("cell")).toHaveText([`${name} B`, `${sku}-B`, "3", "0", "4", "+1"]);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Post count" }).click();
  await expect(page.getByRole("status")).toHaveText("Count posted. Items changed: 2");
  await expect(page.getByTestId("count-status")).toHaveText("Posted");

  // Stock follows, and the item history names the count.
  await page.goto(`/inventory?branch=${branch.id}&q=${sku}`);
  const rowA = page
    .getByRole("row")
    .filter({ hasText: sku })
    .filter({ hasNotText: `${sku}-B` });
  await expect(rowA.getByRole("cell").nth(2)).toHaveText("2");
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: `${sku}-B` })
      .getByRole("cell")
      .nth(2),
  ).toHaveText("4");
  await page.goto(`/inventory/items/${productId}?branch=${branch.id}`);
  await expect(page.getByRole("table").getByText("Stock count")).toBeVisible();
});

test("prints a blind count sheet of the category, sorted by name, with expected on request (C15)", async ({ page }) => {
  const run = Date.now().toString(36).toUpperCase();
  const sku = `SHT-${run}`;
  const barcode = `98${Date.now()}`;
  const [branch] = await e2eQuery<{ id: string }>(
    `INSERT INTO "Branch" ("id", "orgId", "name", "code", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, true, now(), now()) RETURNING "id"`,
    [ORG, `Sheet ${run}`, `SHT-${run}`],
  );
  const category = `Sheet Cat ${run}`;
  const [cat] = await e2eQuery<{ id: string }>(
    `INSERT INTO "Category" ("id", "orgId", "name", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, true, now(), now()) RETURNING "id"`,
    [ORG, category],
  );
  // Created in reverse order: the sheet sorts by name.
  const second = await createRunProduct(ORG, `${sku}-2`, `Sheet Zeta ${run}`);
  const first = await createRunProduct(ORG, `${sku}-1`, `Sheet Alpha ${run}`);
  await createRunProduct(ORG, `${sku}-X`, `Sheet Outside ${run}`);
  await e2eQuery(`UPDATE "Product" SET "categoryId" = $1 WHERE id = ANY($2::uuid[])`, [cat.id, [first, second]]);
  await e2eQuery(
    `INSERT INTO "Barcode" ("id", "orgId", "code", "productId", "isPrimary") VALUES (gen_random_uuid(), $1, $2, $3, true)`,
    [ORG, barcode, first],
  );
  await page.goto(`/inventory/opening?branch=${branch.id}&q=${sku}-1`);
  await page.getByRole("textbox", { name: `Sheet Alpha ${run} Quantity` }).fill("7");
  await page.getByRole("button", { name: "Save opening stock" }).click();
  await expect(page.getByRole("status")).toContainText("Opening stock saved");

  await page.goto(`/inventory/counts?branch=${branch.id}`);
  await page.getByRole("radio", { name: "One category" }).check();
  await page.getByRole("combobox", { name: /^Category/ }).selectOption({ label: category });
  await page.getByRole("button", { name: "Create count" }).click();
  await expect(page.getByTestId("count-status")).toHaveText("Draft");

  // Blind by default: no expected column, a blank counted column.
  await page.getByRole("button", { name: "Print count sheet" }).click();
  const sheet = page.locator(".print-root[data-active] [data-testid=count-sheet]");
  await expect(sheet).toContainText("Count sheet");
  await expect(sheet.locator("th")).toHaveText(["#", "Category", "Item", "SKU", "Barcode", "Counted"]);
  const rows = sheet.getByTestId("sheet-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("td")).toHaveText(["1", category, `Sheet Alpha ${run}`, `${sku}-1`, barcode, ""]);
  await expect(rows.nth(1).locator("td")).toHaveText(["2", category, `Sheet Zeta ${run}`, `${sku}-2`, "—", ""]);

  await page.emulateMedia({ media: "print" });
  await expect(sheet).toBeVisible();
  await expect(page.locator("main")).toBeHidden();
  await page.emulateMedia({ media: "screen" });

  await page.getByRole("checkbox", { name: "Show expected quantities" }).check();
  await page.getByRole("button", { name: "Print count sheet" }).click();
  await expect(sheet.locator("th")).toHaveText(["#", "Category", "Item", "SKU", "Barcode", "Expected", "Counted"]);
  await expect(rows.nth(0).locator("td").nth(5)).toHaveText("7");
  await expect(rows.nth(1).locator("td").nth(5)).toHaveText("0");
});
