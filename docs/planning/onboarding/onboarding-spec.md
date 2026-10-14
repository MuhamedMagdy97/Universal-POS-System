# T2 completion — Shop Onboarding, Staff, Branches and Tills: Specification

Status: **approved by the owner (2026-10-14), every decision as recommended. BUILT on `t2/onboarding`** — see §6.

Source: `docs/planning/task-breakdown.md` (T2 "Org/Branch/Register + EG/SA preset seed"), `docs/product/vision.md`
and `target-customers.md` (onboarding business-type selector, only Retail working in the MVP),
`docs/product/user-roles-permissions.md` (`users.manage`, `settings.manage`), and the as-built auth and tenancy.

## 1. Key facts

- T2 was built only as tables and test data. **Nothing in the app creates a shop (organization), a branch, a till
  (register) or a staff login.** Every phase since was tested against seeded shops (`prisma/seed-e2e.ts`); a fresh
  install has nothing a person can use. `npm run db:seed:dev` (added 2026-10-13) is a development stopgap only.
- `/onboarding` lists the six business types with Included / Coming soon and does nothing else.
- Better-Auth email + password sign-up is on (`/api/auth/sign-up/email`, 5 per minute per IP, password 10–128).
  A user with no membership can sign in but every screen refuses them ("No active organization").
- New sessions pick the user's organization automatically (`pickActiveOrganization`).
- Market presets exist (`MARKET_PRESETS`): EG → EGP, 14% VAT; SA → SAR, 15% VAT. Timezone follows the country.
- `users.manage` and `settings.manage` exist (Owner, Admin) but no screen uses them beyond the audit trail and the
  receipt settings.

## 2. Goal and success

A shop owner opens the app, picks General retail, enters the shop and their own account, and lands on the dashboard
of a working shop: one branch, one till, ready to add products and sell. The owner (or an admin) then adds staff
logins with a role and branches, and adds branches and tills as the shop grows. Nothing is half-created on a failure,
and every step is audited.

Out of scope: email verification and password reset by email (no mail provider yet), inviting by email link, one user
in several shops, changing country or currency after setup, billing, deleting a shop.

## 3. Decisions

| # | Topic | Decision |
|---|---|---|
| O1 | Who can create a shop | **Self-serve**: anyone can open `/onboarding` and create a shop with themselves as Owner. Abuse is limited by the existing sign-up rate limit (5 per minute per IP). Alternative: operator-only (you create shops for customers). **Owner: confirm self-serve, or say operator-only.** |
| O2 | Setup form | One page: business type (only General retail selectable; the others shown "Coming soon"), shop name, country (Egypt or Saudi Arabia, which sets currency, VAT and timezone), first branch name (default "Main"), owner name, email, password (twice). One till named "Till 1" is created. VAT and currency are not editable here. **Owner: confirm the fields.** |
| O3 | Staff logins | A **Staff** screen (`/settings/staff`, `users.manage`): add a person with name, email, a temporary password set by the owner, role (Admin, Manager, Cashier, Reporting) and branches (all or chosen). Change role and branches; deactivate (signs them out everywhere at once). No email invites (no mail provider). **Owner: confirm.** |
| O4 | Who manages whom | Only an Owner may add, change or deactivate an Admin or another Owner. Admins manage Managers, Cashiers and Reporting. Nobody can deactivate or demote the last active Owner, and nobody can change their own role. **Owner: confirm.** |
| O5 | Branches and tills | A **Branches** screen (`/settings/branches`, `settings.manage`): add a branch (name, short code), rename, deactivate (refused while it has stock or an open shift); add, rename and deactivate tills (deactivate refused while a shift is open). **Owner: confirm, or keep one branch for the MVP.** |
| O6 | Atomic setup | The account is created through Better-Auth, then the shop, branch, till and Owner membership in one transaction. If the shop step fails, the new account is deleted again, so no orphan login is left. **(rec)** |
| O7 | Resume | A signed-in user with no shop (for example one who signed up directly through the API) is sent to `/onboarding`, which skips the account fields and creates the shop for them. **(rec)** |
| O8 | One shop per account | A user who already belongs to a shop cannot create another from onboarding (403). Multi-shop owners are a later feature. **(rec)** |
| O9 | Validation | Shop name 1–120, branch name 1–60, branch code 1–12 (A–Z, 0–9, dash; unique per shop, case-insensitive), till name 1–40 (unique per branch). Email unique across the system (409 `EMAIL_TAKEN`). Password 10–128 (the auth rule). **(rec)** |
| O10 | Temporary passwords | Staff passwords set by the owner are shown once. The person can change it from a **My account** page (current password plus new). Forcing a change at first sign-in is left for later. **(rec)** |
| O11 | Audit | `org.created`, `staff.added/updated/deactivated/reactivated`, `branch.created/updated/deactivated`, `register.created/updated/deactivated`, `account.password_changed`, plus `*.permission.denied` for refused attempts. **(rec)** |
| O12 | Defaults | Shop gets `pricesIncludeVat = true`, `blockNegativeStock = true`, business type RETAIL, receipt fields empty (set later in Receipt settings). **(rec)** |
| O13 | Navigation | The Welcome page's "Set up a new business" opens the working form. A "Settings" menu groups Receipt, Staff and Branches for the roles that may see each. **(rec)** |

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Self-serve sign-up fills the database with junk shops. | Rate limit per IP; shops can be listed and cleaned by an operator later. Switch O1 to operator-only if this matters before launch. |
| R2 | A removed staff member keeps working on an open session. | Deactivation deletes their sessions in the same transaction; the tenant guard already rejects inactive memberships. |
| R3 | The last Owner locks themselves out. | O4: the last active Owner cannot be demoted or deactivated. |
| R4 | No password reset by email: a forgotten password needs the owner. | Owner or Admin sets a new temporary password from the Staff screen. A forgotten Owner password needs an operator; noted for Phase 13 (mail provider). |

## 5. Acceptance

1. From a fresh database: Welcome → Set up a new business → form → dashboard, signed in as Owner of a shop with a
   Main branch and Till 1; the till opens a shift and sells after a product is added.
2. A failed setup (duplicate email, bad branch code) leaves no user, shop or membership behind.
3. The owner adds a Cashier who can sign in, sees only the till, and is signed out the moment they are deactivated.
4. An Admin cannot add an Owner or Admin; nobody can remove the last Owner.
5. A second branch and a second till appear on the till's branch and register pickers.
6. Every screen works in Arabic, right to left. lint, tsc, vitest, `next build`, full Playwright green.

## 6. As built (2026-10-14)

Services in `modules/org` (`setup.ts`, `staff.ts`, `branches.ts`, `account.ts`, rules in `schemas.ts`), Server Actions
for the screens, `/onboarding`, `/settings/staff`, `/settings/branches` and `/account` in EN/AR. No migration.
Tests: `tests/integration/onboarding.test.ts` (acceptance 1–5 at the service level), `tests/unit/org-helpers.test.ts`,
`tests/e2e/onboarding.spec.ts` (acceptance 1, 3, 5, 6 in the browser).

Deviations and additions:

- **O6, stronger than specified:** the login (user + Better-Auth "credential" account, argon2id) is written in the same
  transaction as the shop, branch, till and membership, so there is nothing to delete after a failure. The owner is
  then signed in with Better-Auth's `signInEmail` (the session picks the new shop).
- **Rate limit:** Better-Auth's 5/min sign-up limit only covers its HTTP routes, so setup has its own: 5 per minute per
  IP in the `ApiRateLimit` table (keys `ip:onboarding:<ip>`), via `enforceIpRateLimit` in `lib/rate-limit.ts`.
- **Branch codes** are stored upper-case; the first branch gets code `MAIN`. The till is "Till 1" in both languages.
- **Staff screen:** nobody edits their own row there (reason `SELF`; own password under My account). A new temporary
  password (R4) signs the person out everywhere, like deactivation; audited as `staff.password_reset`. Staff changes
  queue on the shop row (`FOR UPDATE`), so two owners removing each other at once leave one active owner.
- **Branches:** also refused for the last active branch (`LAST_BRANCH`). Branches and tills can be reactivated
  (`branch.reactivated`, `register.reactivated`); a till cannot be added to or reactivated on an inactive branch.
- **Till deactivation vs. a new shift:** `openShift` now holds the till row `FOR SHARE`; deactivation takes it
  `FOR UPDATE` before checking for an open shift. Known ceiling: a delivery received at the moment a branch is
  deactivated can land on it; its stock stays on the ledger and shows again on reactivation.
- **Open purchase orders** for a branch are not checked on deactivation; they cannot be received until the branch is
  reactivated. Add a guard (or cancel them) if this bites.
- **Client IP** for the setup limit is the first `x-forwarded-for` entry (as Better-Auth uses): the hosting proxy must
  set that header, or a client could rotate it to get past the limit.
- **My account** ends the user's other sessions on a password change.
- **No Route Handlers** for these screens (Server Actions only); add `/api/org/*` routes when an API client needs them.
- Not built (as scoped out): email invites and verification, forced password change at first sign-in, several shops per
  account, changing country or currency.
