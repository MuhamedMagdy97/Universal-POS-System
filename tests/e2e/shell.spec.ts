import { expect, test, type Page } from "@playwright/test";
import { storageStateFor } from "./support/auth";
import { E2E_BASE_URL } from "./support/env";

/** App shell (ui-refresh design-system-spec DS8): sidebar side, collapse on the till, phone menu, overflow. */

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function noPageScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test.describe("admin", () => {
  test.use({ storageState: storageStateFor("adminA") });

  test("sidebar is on the start side in English and the end side in Arabic", async ({ page, context }) => {
    await page.goto("/dashboard");
    const en = await nav(page).boundingBox();
    expect(en?.x ?? Infinity).toBeLessThan(100);

    await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
    await page.goto("/dashboard");
    const ar = await nav(page).boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect((ar?.x ?? 0) + (ar?.width ?? 0)).toBeGreaterThan(width - 100);
  });

  test("till collapses the sidebar but keeps link names", async ({ page }) => {
    await page.goto("/pos");
    await expect(page.locator("aside[data-collapsed='true']")).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "Reports" })).toBeVisible();
  });

  test("the current section's link is marked", async ({ page }) => {
    await page.goto("/reports");
    await expect(nav(page).getByRole("link", { name: "Reports" })).toHaveAttribute("aria-current", "page");
    await expect(nav(page).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current", "page");
  });

  test("phone width opens and closes the menu", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/dashboard");
    await expect(nav(page)).toBeHidden();
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(nav(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(nav(page)).toBeHidden();
    await noPageScroll(page);
  });

  test("reports fit a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/reports?report=sales-summary&range=today");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await noPageScroll(page);
  });

  test("a long shop name does not scroll the page", async ({ page }) => {
    await page.goto("/dashboard");
    await page
      .getByRole("banner")
      .getByText("E2E Org A (Egypt)")
      .evaluate((el) => {
        el.textContent = "متجر الأمل للمواد الغذائية والخضروات والفواكه الطازجة فرع مدينة نصر";
      });
    await noPageScroll(page);
  });
});

test.describe("cashier", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("sees only the links their role allows", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(nav(page).getByRole("link", { name: "Till" })).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "Purchasing" })).toHaveCount(0);
  });
});
