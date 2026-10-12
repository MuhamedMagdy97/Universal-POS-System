import { expect, test } from "@playwright/test";
import { storageStateFor } from "./support/auth";

/** Audit trail (T9): Owner and Admin only; denied attempts can be found (as the seeded admin). */

test.describe("admin", () => {
  test.use({ storageState: storageStateFor("adminA") });

  test("finds a denied report attempt by a cashier", async ({ page, browser }) => {
    // A cashier asking for a report is refused and the refusal is recorded.
    const cashier = await browser.newContext({ storageState: storageStateFor("cashierA") });
    const response = await cashier.request.get("/api/reports/payments");
    expect(response.status()).toBe(403);
    await cashier.close();

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Audit trail" }).click();
    await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible();
    await page.getByLabel("Action").selectOption({ label: "Denied attempts" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/action=\*\.permission\.denied/);
    const row = page.getByRole("row").filter({ hasText: "Denied attempts (reports)" }).first();
    await expect(row).toBeVisible();
    await row.getByText("Show").click();
    await expect(row).toContainText("reports.view");
  });
});

test.describe("manager", () => {
  test.use({ storageState: storageStateFor("managerA") });

  test("has no audit link and is refused", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: "Reports" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Audit trail" })).toHaveCount(0);
    await page.goto("/audit");
    await expect(page.getByRole("heading", { name: "You can't view the audit trail" })).toBeVisible();
  });
});
