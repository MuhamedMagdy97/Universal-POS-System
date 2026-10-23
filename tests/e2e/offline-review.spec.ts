import { expect, test } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { MESSAGES } from "../../lib/i18n";
import { storageStateFor } from "./support/auth";
import { e2eQuery } from "./support/db";
import { createRunRegister } from "./support/pos";

/**
 * Offline till slice 4: a manager sees a flagged offline sale on "Offline sales to review" and marks it reviewed;
 * a cashier is refused. The till cannot sell offline yet, so the sale and its flag row are seeded as slice 1
 * writes them.
 */

const en = MESSAGES.en;
const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;

async function seedFlaggedSale(): Promise<string> {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const registerId = await createRunRegister(ORG, MAIN, `Review ${run}`);
  const number = `R${run}-000001`;
  await e2eQuery(
    `WITH cashier AS (SELECT "id" FROM "User" WHERE "email" = $4),
     shift AS (
       INSERT INTO "RegisterShift" ("id", "orgId", "branchId", "registerId", "status", "openedById", "openingFloatMinor")
       SELECT gen_random_uuid(), $1, $2, $3, 'OPEN', cashier."id", 0 FROM cashier RETURNING "id", "openedById"
     ),
     sale AS (
       INSERT INTO "Sale" ("id", "orgId", "branchId", "registerId", "shiftId", "cashierId", "number", "idempotencyKey",
                           "status", "currency", "subtotalMinor", "vatMinor", "totalMinor", "receivedAt", "offlineFlags")
       SELECT gen_random_uuid(), $1, $2, $3, shift."id", shift."openedById", $5, $5, 'COMPLETED', 'EGP', 877, 123, 1000,
              now(), ARRAY['PRICE_CHANGED']
         FROM shift RETURNING "id"
     )
     INSERT INTO "AuditEvent" ("id", "orgId", "branchId", "actorUserId", "action", "entityType", "entityId", "metadata")
     SELECT gen_random_uuid(), $1, $2, NULL, 'sale.offline.flagged', 'Sale', sale."id"::text,
            jsonb_build_object('number', $5::text, 'flag', 'PRICE_CHANGED',
                               'lines', jsonb_build_array(jsonb_build_object('sku', 'SKU-' || $5::text,
                                                                             'soldMinor', 1000, 'currentMinor', 1200)))
       FROM sale`,
    [ORG, MAIN, registerId, E2E_USERS.cashierA.email, number],
  );
  return number;
}

test.describe("offline sales to review", () => {
  test("a manager sees the flag details and marks the sale reviewed", async ({ browser }) => {
    const number = await seedFlaggedSale();

    const manager = await browser.newContext({ storageState: storageStateFor("managerA") });
    const page = await manager.newPage();
    await page.goto("/dashboard");
    await page.getByRole("link", { name: en["review.nav"] }).click();
    await expect(page.getByRole("heading", { name: en["review.title"] })).toBeVisible();

    const row = page.getByTestId("review-row").filter({ hasText: number });
    await expect(row).toContainText(en["review.flag.PRICE_CHANGED"]);
    await expect(row).toContainText(E2E_USERS.cashierA.name);
    await expect(row).toContainText(/sold at EGP\s?10\.00, now EGP\s?12\.00, difference -EGP\s?2\.00/);
    await row.getByRole("button", { name: en["review.mark"] }).click();
    await expect(page.getByTestId("review-row").filter({ hasText: number })).toHaveCount(0);
    await manager.close();

    const cashier = await browser.newContext({ storageState: storageStateFor("cashierA") });
    const cashierPage = await cashier.newPage();
    await cashierPage.goto("/reports/offline-review");
    await expect(cashierPage.getByRole("heading", { name: en["review.state.forbidden"] })).toBeVisible();
    await cashier.close();
  });
});
