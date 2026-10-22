import { expect, test } from "@playwright/test";
import { MESSAGES } from "../../lib/i18n";
import { signIn, storageStateFor } from "./support/auth";

/** Offline till slice 1: the owner turns "Allow offline sales" on and off; an admin only reads it. */

const en = MESSAGES.en;

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
