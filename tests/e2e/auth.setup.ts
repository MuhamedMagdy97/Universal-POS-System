import { test as setup } from "@playwright/test";
import type { E2EUserKey } from "../../prisma/seed-e2e";
import { signIn, storageStateFor } from "./support/auth";

/** Signs each seeded user in once through the login form and saves the session for the specs. */
const USERS: E2EUserKey[] = ["adminA", "managerA", "cashierA", "reportingA", "adminB"];

for (const user of USERS) {
  setup(`sign in ${user}`, async ({ page }) => {
    await signIn(page, user);
    await page.context().storageState({ path: storageStateFor(user) });
  });
}
