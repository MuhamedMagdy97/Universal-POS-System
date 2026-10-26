import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { storageStateFor } from "./support/auth";
import { e2eQuery } from "./support/db";
import { E2E_BASE_URL } from "./support/env";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";
import { newShop, run } from "./support/shop";

/**
 * A salon (salon-spec S2-S10): a 45-minute Haircut service, Sara at 40 % on the Team, Mona booked at 10:00 with Sara,
 * checked out at the till with a shampoo added; the receipt says "by Sara" and the commission report shows her.
 */

const en = MESSAGES.en;
const ar = MESSAGES.ar;

test("a salon books, checks out and pays commission", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { orgId, branchId, email } = await newShop(page, "Barbershop / beauty salon");
  await e2eQuery(
    `INSERT INTO "Product" ("id", "orgId", "sku", "name", "unitType", "priceMinor", "costMinor", "vatApplicable",
                            "vatCategory", "hasVariants", "isActive", "isService", "durationMin", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 'Haircut', 'EACH', 15000, 0, true, 'STANDARD', false, true, true, 45, now(), now())
     RETURNING "id"`,
    [orgId, `CUT-${run().toUpperCase()}`],
  );
  const shampooSku = `SHA-${run().toUpperCase()}`;
  const shampoo = await createRunProduct(orgId, shampooSku, "Shampoo");
  await openRunStock(orgId, branchId, shampoo, 5, email);
  const registerId = await createRunRegister(orgId, branchId, "Front desk");

  // Settings → Team: Sara at 40 %.
  await page.goto("/settings/team");
  const add = page.getByRole("form", { name: en["settings.team.new"] });
  await add.getByLabel(en["catalog.form.name"]).fill("Sara");
  await add.getByLabel(en["settings.team.commission"]).fill("40");
  await add.getByRole("button", { name: en["settings.team.add"] }).click();
  await expect(add.getByRole("status")).toHaveText(en["settings.shop.saved"]);

  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await page.getByLabel(/Opening cash in the drawer/).fill("100");
  await page.getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByTestId("till-staff")).toBeVisible();

  // The calendar: book Mona with Sara at 10:00.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: en["appointments.nav"] }).click();
  await page.getByRole("button", { name: "Book Sara at 10:00" }).click();
  const booking = page.getByRole("form", { name: en["appointments.book"] });
  await booking.getByLabel(en["appointments.customer"]).fill("Mona");
  await booking.getByLabel(en["appointments.phone"]).fill("01001234567");
  await booking.getByRole("checkbox", { name: /Haircut/ }).check();
  await booking.getByRole("button", { name: en["appointments.book"] }).click();
  const block = page.getByRole("button", { name: /^Mona/ });
  await expect(block).toBeVisible();
  // A taken slot sits under the block, so it cannot be booked again from the calendar (the server refuses it too).

  // Check out: the haircut by Sara is in the cart; a shampoo is added.
  await block.click();
  await page.getByTestId("appointment-detail").getByRole("link", { name: en["appointments.checkOut"] }).click();
  await expect(page.getByTestId("till-appointment")).toHaveText("Checking out Mona's appointment");
  await expect(page.getByRole("combobox", { name: "Staff for Haircut" })).toHaveValue(/.+/);
  const search = page.getByRole("textbox", { name: "Scan or search items" });
  await search.fill(shampooSku);
  await search.press("Enter");
  await expect(page.getByRole("textbox", { name: "Quantity for Shampoo" })).toHaveValue("1");
  await page.getByLabel(/Cash received/).fill("200");
  await page.getByRole("button", { name: /^Charge/ }).click();
  await expect(page.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
  await expect(page.getByText("by Sara").first()).toBeVisible();
  const [done] = await e2eQuery<{ status: string }>(
    `SELECT "status"::text AS "status" FROM "Appointment" WHERE "orgId" = $1 AND "customerName" = 'Mona'`,
    [orgId],
  );
  expect(done.status).toBe("DONE");

  // Commission: the haircut (150.00, 131.58 net) and the shampoo added while Sara was chosen (10.00, 8.77 net) at 40 %.
  await page.goto(`/reports?report=staff-commission&branch=${branchId}`);
  const row = page.getByRole("row", { name: /Sara/ });
  await expect(row).toContainText("140.35");
  await expect(row).toContainText("56.14");

  // The calendar in Arabic.
  await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
  await page.goto("/appointments");
  await expect(page.getByRole("heading", { name: ar["appointments.title"] })).toBeVisible();
  await context.close();
});

test.describe("a retail shop", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("has no Appointments", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: en["appointments.nav"] }),
    ).toHaveCount(0);
  });
});
