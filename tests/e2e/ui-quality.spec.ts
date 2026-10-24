import { expect, test, type Page } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";

/** UI refresh A review fixes: dark-mode contrast, touch targets, phone menu focus, till layout. */

const ORG = E2E_ORGS.A.id;
const MAIN = E2E_ORGS.A.branchId;

function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text and background colour of a throwaway element with these classes. */
async function colours(page: Page, tag: string, className: string): Promise<[string, string]> {
  return page.evaluate(
    ([t, c]) => {
      const el = document.createElement(t);
      el.className = c;
      el.textContent = "x";
      document.body.append(el);
      const style = getComputedStyle(el);
      const out: [string, string] = [style.color, style.backgroundColor];
      el.remove();
      return out;
    },
    [tag, className] as const,
  );
}

test.describe("admin", () => {
  test.use({ storageState: storageStateFor("adminA") });

  test("filled buttons and the on-screen receipt stay readable in dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/dashboard");
    for (const className of ["btn btn-danger", "btn btn-primary"]) {
      const [fg, bg] = await colours(page, "button", className);
      expect(contrast(fg, bg), className).toBeGreaterThanOrEqual(4.5);
    }
    const [fg, bg] = await colours(page, "div", "print-receipt");
    expect(contrast(fg, bg), "print-receipt").toBeGreaterThanOrEqual(4.5);
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 375, height: 800 } });

    test("the menu takes focus, gives it back, and closes on a same-page link", async ({ page }) => {
      await page.goto("/reports?report=payments&range=today");
      const menu = page.getByRole("button", { name: "Menu" });
      await menu.click();
      await expect(page.locator("#app-sidebar :focus")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(menu).toBeFocused();

      await menu.click();
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports" }).click();
      await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    });

    test("top bar controls are at least 40 px tall", async ({ page }) => {
      await page.goto("/dashboard");
      const controls = page.getByRole("banner").locator("button, a");
      for (const control of await controls.all()) {
        const box = await control.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      }
    });
  });
});

test.describe("cashier till", () => {
  test.use({ storageState: storageStateFor("cashierA") });

  test("touch targets are 48 px and the pay card fits a short screen", async ({ page }) => {
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const sku = `UIQ-${run}`;
    const productId = await createRunProduct(ORG, sku, `UI Item ${run}`);
    await openRunStock(ORG, MAIN, productId, 5, E2E_USERS.cashierA.email);
    const registerId = await createRunRegister(ORG, MAIN, `Till ${run}`);

    await page.goto(`/pos?branch=${MAIN}&register=${registerId}`);
    await page.getByLabel(/Opening cash in the drawer/).fill("100");
    await page.getByRole("button", { name: "Open shift" }).click();
    const search = page.getByRole("textbox", { name: "Scan or search items" });
    await search.fill(sku);
    await search.press("Enter");
    await expect(page.getByRole("textbox", { name: `Quantity for UI Item ${run}` })).toHaveValue("1");

    const controls = await page
      .getByTestId("till")
      .locator("button, input:not([type=radio]):not([type=checkbox])")
      .all();
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) {
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box?.height ?? 0, await control.evaluate((el) => el.outerHTML.slice(0, 120))).toBeGreaterThanOrEqual(48);
    }

    // A retail till has no tiles (business-profiles-spec §2).
    await expect(page.getByTestId("till-tiles")).toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 520 });
    await page.getByText("Split", { exact: true }).click();
    const form = page.getByRole("form", { name: "Payment method" });
    const box = await form.boundingBox();
    expect(box?.height ?? Infinity).toBeLessThanOrEqual(520 - 80);
  });
});
