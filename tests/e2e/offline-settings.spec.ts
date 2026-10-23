import { expect, test, type Browser, type Page } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { signIn, storageStateFor } from "./support/auth";
import { e2eQuery } from "./support/db";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, onHand, openRunStock } from "./support/pos";

/** Offline till slice 1: the owner turns "Allow offline sales" on and off; an admin only reads it. */

const en = MESSAGES.en;
const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;
const OWNER = E2E_USERS.ownerA.email;

// Both tests flip the shop's offline setting: never run them side by side.
test.describe.configure({ mode: "serial" });

test.describe("offline settings", () => {
  test("the owner toggles offline sales; an admin sees it read-only", async ({ browser }) => {
    const owner = await browser.newContext();
    const page = await owner.newPage();
    await signIn(page, "ownerA", "/settings/offline");
    await expect(page.getByRole("heading", { name: en["settings.offline.tills"] })).toBeVisible();
    const allow = page.getByLabel(en["settings.offline.allow"]);
    // Off by default; a rerun against the same database may find it on, so start from off.
    if (await allow.isChecked()) {
      await allow.uncheck();
      await expect(page.getByText(en["settings.offline.saved"])).toBeVisible();
    }
    await allow.check();
    await expect(page.getByText(en["settings.offline.saved"])).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(en["settings.offline.allow"])).toBeChecked();

    const admin = await browser.newContext({ storageState: storageStateFor("adminA") });
    const adminPage = await admin.newPage();
    await adminPage.goto("/settings/offline");
    await expect(adminPage.getByLabel(en["settings.offline.allow"])).toBeDisabled();
    await expect(adminPage.getByText(en["settings.offline.ownerOnly"])).toBeVisible();

    // Back off, so the seeded shop stays as other specs expect.
    await page.getByLabel(en["settings.offline.allow"]).uncheck();
    await expect(page.getByText(en["settings.offline.saved"])).toBeVisible();
    await expect(page.getByLabel(en["settings.offline.allow"])).not.toBeChecked();
    await owner.close();
    await admin.close();
  });
});

/**
 * Offline till slice 2: the owner sets a till up for offline sales, the connection drops, a cash sale prints as
 * T…-000001 "Offline sale" from the device, and it reaches the server once the connection is back. In this file so
 * it never runs while the test above toggles the shop setting.
 */
test.describe("offline till", () => {
  /** A stocked item at 10.00, a fresh register, the shop allowing offline; the owner opens a shift and enrols. */
  async function enrolledTill(browser: Browser, stock: number) {
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const sku = `OFF-${run}`;
    const productId = await createRunProduct(ORG, sku, `Offline Item ${run}`);
    await openRunStock(ORG, MAIN, productId, stock, OWNER);
    const registerId = await createRunRegister(ORG, MAIN, `Till ${run}`);
    await e2eQuery(`UPDATE "Organization" SET "allowOfflineSales" = true WHERE "id" = $1`, [ORG]);
    const context = await browser.newContext();
    const page = await context.newPage();
    return { sku, productId, registerId, context, page };
  }

  async function openAndEnrol(page: Page, registerId: string): Promise<string> {
    await signIn(page, "ownerA", `/pos?branch=${MAIN}&register=${registerId}`);
    await page.getByLabel(/Opening cash in the drawer/).fill("0");
    await page.getByRole("button", { name: "Open shift" }).click();
    await page.getByRole("button", { name: en["pos.offline.enrol"] }).click();
    await expect(page.getByTestId("offline-ready")).toBeVisible();
    const rows = await e2eQuery<{ offlineCode: string }>(`SELECT "offlineCode" FROM "Register" WHERE "id" = $1`, [
      registerId,
    ]);
    return rows[0].offlineCode;
  }

  async function scan(page: Page, sku: string) {
    const search = page.getByRole("textbox", { name: "Scan or search items" });
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByTestId("till-total")).toContainText("10.00");
  }

  test.afterAll(async () => {
    await e2eQuery(`UPDATE "Organization" SET "allowOfflineSales" = false WHERE "id" = $1`, [ORG]);
  });

  test("sells cash, card and split offline, survives a reload offline, and syncs on reconnect", async ({ browser }) => {
    const { sku, productId, registerId, context, page } = await enrolledTill(browser, 5);
    try {
      const code = await openAndEnrol(page, registerId);
      // The service worker has the till's page before the connection drops (slice 3).
      await expect.poll(() => page.evaluate(async () => !!(await caches.match("/pos?__last")))).toBe(true);

      await context.setOffline(true);
      await scan(page, sku);
      await page.getByLabel(/Cash received/).fill("20");
      await page.getByRole("button", { name: /^Charge/ }).click();
      await expect(page.getByRole("heading", { name: `Sale ${code}-000001` })).toBeVisible();
      await expect(page.getByTestId("receipt-offline")).toHaveText(en["receipt.offline"]);
      // Cash applied 10.00 and change 10.00, as the server stores it.
      await expect(page.getByTestId("receipt-slip")).toContainText(/Change\s*EGP\s?10\.00/);
      await page.getByRole("button", { name: "New sale" }).click();
      // The price changes on the server while the till is offline: the sales keep 10.00 and are flagged.
      await e2eQuery(`UPDATE "Product" SET "priceMinor" = 1200 WHERE "id" = $1`, [productId]);

      await scan(page, sku);
      await page.getByRole("radio", { name: "Card" }).check();
      await page.getByRole("button", { name: /^Charge/ }).click();
      await expect(page.getByRole("heading", { name: `Sale ${code}-000002` })).toBeVisible();
      await page.getByRole("button", { name: "New sale" }).click();

      await scan(page, sku);
      await page.getByRole("radio", { name: "Split" }).check();
      await page.getByLabel(/^Card amount/).fill("6");
      await page.getByLabel(/^Cash amount/).fill("5");
      await expect(page.getByTestId("till-change")).toContainText("1.00");
      await page.getByRole("button", { name: /^Charge/ }).click();
      await expect(page.getByRole("heading", { name: `Sale ${code}-000003` })).toBeVisible();
      await page.getByRole("button", { name: "New sale" }).click();
      await expect(page.getByTestId("offline-bar")).toContainText("Offline — 3 sales waiting");

      // A reload with no connection still opens the till, with the queue intact.
      await page.reload();
      await expect(page.getByTestId("offline-bar")).toContainText("Offline — 3 sales waiting");
      expect(await onHand(ORG, MAIN, productId)).toBe(5);

      await context.setOffline(false);
      await expect(page.getByTestId("offline-ready")).toBeVisible({ timeout: 45_000 });
      const sales = await e2eQuery<{ number: string; totalMinor: number; flags: string[]; open: boolean }>(
        `SELECT s."number", s."totalMinor", s."offlineFlags" AS "flags", sh."status" = 'OPEN' AS "open"
           FROM "Sale" s JOIN "RegisterShift" sh ON sh."id" = s."shiftId"
          WHERE s."registerId" = $1 ORDER BY s."number"`,
        [registerId],
      );
      expect(sales).toEqual(
        [1, 2, 3].map((n) => ({
          number: `${code}-00000${n}`,
          totalMinor: 1000,
          flags: ["PRICE_CHANGED"],
          open: true,
        })),
      );
      expect(await onHand(ORG, MAIN, productId)).toBe(2);

      // The manager finds them on the review list.
      await page.goto("/reports/offline-review");
      for (const n of [1, 2, 3]) {
        await expect(page.getByTestId("review-row").filter({ hasText: `${code}-00000${n}` })).toContainText(
          en["review.flag.PRICE_CHANGED"],
        );
      }
    } finally {
      await context.close();
    }
  });

  test("stops selling offline after the 12-hour limit", async ({ browser }) => {
    const { sku, registerId, context, page } = await enrolledTill(browser, 2);
    try {
      await page.clock.install();
      await openAndEnrol(page, registerId);
      await scan(page, sku);
      await page.getByLabel(/Cash received/).fill("10");
      await context.setOffline(true);
      await page.clock.fastForward("12:01:00");
      await page.getByRole("button", { name: /^Charge/ }).click();
      // Session and contact limits both pass 12 h here; either one stops the sale.
      await expect(page.getByRole("alert").filter({ hasText: /Reconnect/ })).toBeVisible();
      await expect(page.getByRole("heading", { name: /^Sale / })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
