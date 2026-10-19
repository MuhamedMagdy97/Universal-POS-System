import { expect, test, type BrowserContext } from "@playwright/test";
import { E2E_ORGS, E2E_USERS } from "../../prisma/seed-e2e";
import { E2E_BASE_URL } from "./support/env";
import { signIn, storageStateFor } from "./support/auth";
import { createRunProduct } from "./support/inventory";
import { createRunRegister, openRunStock } from "./support/pos";

/**
 * Phase 13 nonce CSP (proxy.ts): the key pages and flows run without a single CSP violation.
 * Every `securitypolicyviolation` event and every console line that mentions the policy is
 * collected, and the test fails on any. One exception: Zod 4 probes `Function("")` once to pick
 * its JIT, catches the refusal and runs without it. Production never allows eval (checked on
 * the header below), so a refused eval is the policy working, not a page breaking.
 */
async function watchCsp(context: BrowserContext): Promise<string[]> {
  const violations: string[] = [];
  await context.exposeFunction("reportCspViolation", (text: string) => violations.push(text));
  await context.addInitScript(() => {
    const report = (window as unknown as { reportCspViolation: (text: string) => void }).reportCspViolation;
    document.addEventListener("securitypolicyviolation", (e) => {
      if (e.blockedURI !== "eval") report(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  context.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  return violations;
}

test("every page sends a fresh nonce CSP without unsafe-inline scripts", async ({ request }) => {
  const policies = await Promise.all(
    [1, 2].map(async () => (await request.get("/login")).headers()["content-security-policy"]),
  );
  for (const csp of policies) {
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(csp).toContain("frame-ancestors 'none'");
  }
  expect(policies[0]).not.toBe(policies[1]);
});

test("sign-in, till sale and receipt print raise no CSP violation", async ({ browser }) => {
  const context = await browser.newContext();
  const violations = await watchCsp(context);
  const page = await context.newPage();
  await signIn(page, "cashierA");

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const { id: org, branchId } = E2E_ORGS.A;
  const productId = await createRunProduct(org, `CSP-${run}`, `CSP Item ${run}`);
  await openRunStock(org, branchId, productId, 5, E2E_USERS.cashierA.email);
  const registerId = await createRunRegister(org, branchId, `CSP ${run}`);
  await page.goto(`/pos?branch=${branchId}&register=${registerId}`);
  await page.getByLabel("Opening cash in the drawer", { exact: false }).fill("0");
  await page.getByRole("button", { name: "Open shift" }).click();
  const search = page.getByRole("textbox", { name: "Scan or search items" });
  await search.fill(`CSP-${run}`);
  await search.press("Enter");
  await page.getByLabel("Cash received", { exact: false }).fill("20");
  await page.getByRole("button", { name: /^Charge/ }).click();
  await expect(page.locator("#receipt-title")).toBeVisible();
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await expect(page.locator(".print-root[data-active] [data-testid=receipt-slip]")).toContainText("Receipt");

  expect(violations).toEqual([]);
  await context.close();
});

test("reports, CSV export, purchasing, audit and Arabic RTL raise no CSP violation", async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStateFor("adminA") });
  const violations = await watchCsp(context);
  const page = await context.newPage();

  await page.goto("/reports?report=sales-summary&range=today");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);

  for (const path of ["/dashboard", "/catalog/categories", "/purchasing", "/audit", "/settings/receipt"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
  }

  await context.addCookies([{ name: "pos_locale", value: "ar", url: E2E_BASE_URL }]);
  for (const path of ["/pos", "/returns", "/reports?report=payments&range=today"]) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  }

  expect(violations).toEqual([]);
  await context.close();
});
