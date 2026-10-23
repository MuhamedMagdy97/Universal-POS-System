import { expect, test } from "@playwright/test";
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
  test("sells through a dropped connection and syncs on reconnect", async ({ browser }) => {
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const sku = `OFF-${run}`;
    const productId = await createRunProduct(ORG, sku, `Offline Item ${run}`);
    await openRunStock(ORG, MAIN, productId, 5, OWNER);
    const registerId = await createRunRegister(ORG, MAIN, `Till ${run}`);
    await e2eQuery(`UPDATE "Organization" SET "allowOfflineSales" = true WHERE "id" = $1`, [ORG]);

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(page, "ownerA", `/pos?branch=${MAIN}&register=${registerId}`);
      await page.getByLabel(/Opening cash in the drawer/).fill("0");
      await page.getByRole("button", { name: "Open shift" }).click();
      await page.getByRole("button", { name: en["pos.offline.enrol"] }).click();
      await expect(page.getByTestId("offline-ready")).toBeVisible();
      const code = (
        await e2eQuery<{ offlineCode: string }>(`SELECT "offlineCode" FROM "Register" WHERE "id" = $1`, [registerId])
      )[0].offlineCode;

      await context.setOffline(true);
      const search = page.getByRole("textbox", { name: "Scan or search items" });
      await search.fill(sku);
      await search.press("Enter");
      await expect(page.getByTestId("till-total")).toContainText("10.00");
      await page.getByLabel(/Cash received/).fill("20");
      await page.getByRole("button", { name: /^Charge/ }).click();

      await expect(page.getByRole("heading", { name: `Sale ${code}-000001` })).toBeVisible();
      await expect(page.getByTestId("receipt-offline")).toHaveText(en["receipt.offline"]);
      await page.getByRole("button", { name: "New sale" }).click();
      await expect(page.getByTestId("offline-bar")).toContainText("Offline — 1 sales waiting");
      expect(await onHand(ORG, MAIN, productId)).toBe(5);

      await context.setOffline(false);
      await expect(page.getByTestId("offline-ready")).toBeVisible({ timeout: 15_000 });
      const sales = await e2eQuery<{ number: string; totalMinor: number; synced: boolean }>(
        `SELECT "number", "totalMinor", "receivedAt" IS NOT NULL AS "synced" FROM "Sale" WHERE "registerId" = $1`,
        [registerId],
      );
      expect(sales).toEqual([{ number: `${code}-000001`, totalMinor: 1000, synced: true }]);
      expect(await onHand(ORG, MAIN, productId)).toBe(4);
    } finally {
      await context.close();
      await e2eQuery(`UPDATE "Organization" SET "allowOfflineSales" = false WHERE "id" = $1`, [ORG]);
    }
  });
});
