import { expect, test } from "@playwright/test";

test("health endpoint reports the database is up", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok", db: "up" });
});

test("welcome page renders", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page.getByRole("heading", { name: "Welcome to Universal POS" })).toBeVisible();
});

test("app shell requires a session", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
});

test("protected API without a session returns the error envelope", async ({ request }) => {
  const response = await request.get("/api/products");
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ code: "UNAUTHENTICATED", message: "Authentication required", details: null });
});
