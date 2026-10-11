import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { E2E_USERS, type E2EUserKey } from "../../../prisma/seed-e2e";
import { activateOrganization, resetLoginRateLimit } from "./db";

/** Relative to the repo root (Playwright runs from there); git-ignored. */
const AUTH_DIR = path.resolve("playwright", ".auth");

/** Saved browser state (session cookie) of a seeded user, written by auth.setup.ts. */
export function storageStateFor(user: E2EUserKey): string {
  return path.join(AUTH_DIR, `${user}.json`);
}

/** Signs in through the real login form, then activates the user's organization. */
export async function signIn(page: Page, user: E2EUserKey, next?: string): Promise<void> {
  const { email, password } = E2E_USERS[user];
  await resetLoginRateLimit();
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(next ? new RegExp(`${escapeRegExp(next)}$`) : /\/dashboard$/);
  await activateOrganization(email);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
