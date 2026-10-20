import { expect, test, type Browser } from "@playwright/test";
import { E2E_ORGS, E2E_USERS, type E2EUserKey } from "../../prisma/seed-e2e";
import { storageStateFor } from "./support/auth";
import { e2eQuery } from "./support/db";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";

/**
 * ZATCA Phase 1 (docs/planning/zatca/zatca-phase1-spec.md): a Saudi shop is warned until it sets a valid VAT
 * number, then its till receipt prints as a simplified tax invoice with the QR; an Egyptian receipt has no QR.
 */

const VAT = "310122393500003";

/** Sells one run product at a fresh till and opens the printed slip. */
async function sellAndPrint(browser: Browser, org: "A" | "B", user: E2EUserKey) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const { id: orgId, branchId } = E2E_ORGS[org];
  const sku = `ZQR-${run}`;
  const productId = await createRunProduct(orgId, sku, `QR Item ${run}`);
  await openRunStock(orgId, branchId, productId, 5, E2E_USERS[user].email);
  const registerId = await createRunRegister(orgId, branchId, `ZATCA ${run}`);

  const context = await browser.newContext({ storageState: storageStateFor(user) });
  const pos = await context.newPage();
  await pos.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await pos.getByLabel(/Opening cash in the drawer/).fill("0");
  await pos.getByRole("button", { name: "Open shift" }).click();
  const search = pos.getByRole("textbox", { name: "Scan or search items" });
  await expect(search).toBeFocused();
  await search.fill(sku);
  await search.press("Enter");
  await expect(pos.getByRole("textbox", { name: `Quantity for QR Item ${run}` })).toHaveValue("1");
  await pos.keyboard.press("F8");
  await expect(pos.getByLabel(/Cash received/)).toHaveValue("10.00");
  await pos.getByRole("button", { name: /^Charge/ }).click();
  await expect(pos.getByRole("heading", { name: /^Sale \d{6}$/ })).toBeVisible();
  await pos.getByRole("button", { name: "Print", exact: true }).click();
  const slip = pos.locator(".print-root[data-active] [data-testid=receipt-slip]");
  await expect(slip).toBeAttached();
  return { context, slip };
}

test("a Saudi receipt prints as a simplified tax invoice with the ZATCA QR once the VAT number is set", async ({
  browser,
}) => {
  await e2eQuery(`UPDATE "Organization" SET "taxNumber" = NULL WHERE "id" = $1`, [E2E_ORGS.B.id]);

  const back = await browser.newContext({ storageState: storageStateFor("adminB") });
  const settings = await back.newPage();
  await settings.goto("/settings/receipt");
  await expect(settings.getByTestId("zatca-warning")).toBeVisible();
  const vat = settings.getByRole("textbox", { name: "VAT number" });
  await vat.fill("300-111-222");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("alert").filter({ hasText: "starts and ends with 3" })).toBeVisible();
  await vat.fill(VAT);
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("status")).toHaveText("Saved.");
  await expect(settings.getByTestId("zatca-warning")).toHaveCount(0);
  await back.close();

  const { context, slip } = await sellAndPrint(browser, "B", "cashierB");
  await expect(slip.getByTestId("receipt-title")).toContainText("Simplified Tax Invoice / فاتورة ضريبية مبسطة");
  await expect(slip).toContainText(`VAT no. ${VAT}`);
  const qr = slip.getByTestId("receipt-qr");
  await expect(qr).toBeAttached();
  expect(await qr.locator("path").getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
  await context.close();
});

test("an Egyptian receipt has no ZATCA QR", async ({ browser }) => {
  const { context, slip } = await sellAndPrint(browser, "A", "cashierA");
  await expect(slip.getByTestId("receipt-title")).toHaveText("Receipt");
  await expect(slip.getByTestId("receipt-qr")).toHaveCount(0);
  await context.close();
});
