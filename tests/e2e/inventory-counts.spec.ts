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
