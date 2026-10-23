# Business Profiles (UI Refresh B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each business type gets its accent, icon, item word, dashboard tiles and till layout; all six types can be
chosen at setup and changed by the Owner.

**Architecture:** Profiles are config in `modules/presets`. Server Components read `Organization.businessType`, pick
the profile and pass plain values down (accent `<style>`, item word, tile list, `tillLayout`). The till gets a
`TilePanel` fed by a browse mode of the catalog search.

**Tech Stack:** Next.js 16.4 (Cache Components, nonce CSP), Prisma 7, zod 4, Tailwind 4, Vitest, Playwright.

**Spec:** [business-profiles-spec.md](business-profiles-spec.md)

## Global Constraints

- No migration. No new dependency.
- Selling, totals, offline replay and printing unchanged; every existing E2E stays green (the seeded shops are
  `RETAIL`, so retail must look and behave as today apart from the accent tokens it already has).
- Accent text contrast ≥ 4.5:1 on the accent fill in light (`#ffffff`) and dark (`#0b1220`) for every profile.
- EN and AR for every new string; logical properties only.
- Owner-only writes go through `requireOwner` and are audited like `settings.offline.updated`.

## Review Focus

- A shop whose type changes while a cashier has the till open: the next page load shows the new layout; nothing
  breaks mid-sale. Test: Task 5 E2E changes the type, reloads `/pos`, sees tiles, sells.
- A category with no sellable items, or a shop with no categories: tiles show "No items" / only "All". Test: Task 6
  E2E opens an empty category.
- Offline with a snapshot saved before this change (no `categoryId`, no `categories`): tiles show "All" only and
  still add items. Test: Task 6 unit test of `snapshotTiles` with an old snapshot.
- Long Arabic item names on tiles: two lines then ellipsis, tile height fixed. Test: Task 6 E2E with a 60-character
  Arabic name asserts tile height ≤ 96 px.
- Dashboard "Average ticket" with zero sales shows "—", never NaN. Test: Task 4 unit test of `averageTicketMinor`.

---

### Task 1: Profiles and onboarding

**Files:**
- Modify: `modules/presets/index.ts`, `modules/org/schemas.ts`, `app/(public)/onboarding/setup-form.tsx`,
  `app/_ui/icons.tsx`, `lib/i18n/messages/{en,ar}.ts`
- Test: `tests/unit/presets.test.ts` (create), `tests/integration/onboarding.test.ts` (one case)

**Interfaces:**
- Produces:
  `type TillLayout = "scan" | "tiles"`;
  `type DashboardTile = "netSales" | "sales" | "refunds" | "openShifts" | "lowStock" | "averageTicket" | "topItems"`;
  `type BusinessPreset = { id: BusinessTypeId; label: {en;ar}; icon: IconName; accent: { light: string; dark: string; softLight: string; softDark: string }; tillLayout: TillLayout; itemWord: "products" | "items" | "menuItems" | "services"; dashboardTiles: readonly DashboardTile[] }`
  (values exactly as the spec §2 table; soft tints: retail `#e8f0fd`/`#14233a`, grocery `#e6f4ec`/`#0f2a1d`,
  fruit-veg `#eef6e0`/`#1c2a0c`, bakery `#fbf3dc`/`#2e2508`, café `#fdeee6`/`#331a0e`, salon `#f4e9fc`/`#26143a`);
  `profileOf(type: BusinessTypeId): BusinessPreset`; `contrastRatio(a: string, b: string): number` (hex, WCAG).
  `IconName` gains `basket apple wheat coffee scissors` (Lucide). `presets` must not import from `app/`: `icon` is
  typed as a string union declared in presets and `app/_ui/icons.tsx` uses that same union for these five names.
- i18n keys `catalog.word.{products,items,menuItems,services}` and `catalog.add.{...}` in EN/AR (spec §2 words;
  add: "Add product" / "Add item" / "Add menu item" / "Add service", AR "إضافة منتج" / "إضافة صنف" / "إضافة صنف للقائمة" / "إضافة خدمة").

- [ ] **Step 1: Failing unit tests** `tests/unit/presets.test.ts`: every `BUSINESS_PRESETS` entry has all fields;
  `contrastRatio("#ffffff", accent.light) >= 4.5` and `contrastRatio("#0b1220", accent.dark) >= 4.5` for each;
  `profileOf("SALON").tillLayout === "tiles"`, `profileOf("RETAIL").tillLayout === "scan"`,
  `profileOf("RESTAURANT_CAFE").itemWord === "menuItems"`; `SetupInput.parse({...valid, businessType: "SALON"})` ok.
- [ ] **Step 2:** `npx vitest run tests/unit/presets.test.ts` → FAIL (no `profileOf`).
- [ ] **Step 3:** Implement; `SetupInput.businessType` = `z.enum([...six])`; onboarding radios all enabled (drop
  "coming soon" badge), RETAIL preselected. Integration case in `onboarding.test.ts`: a SALON shop is created with
  `businessType = SALON`.
- [ ] **Step 4:** unit + `npx vitest run tests/integration/onboarding.test.ts` → PASS.
- [ ] **Step 5:** Commit "UI refresh B: business profiles and setup for every type".

### Task 2: Shop setting (Owner changes the type)

**Files:**
- Create: `modules/org/business.ts`, `app/(app)/settings/shop/page.tsx`, `app/(app)/settings/shop/shop-settings.tsx`
- Modify: `modules/org/index.ts`, `app/(app)/settings/actions.ts`, `app/(app)/settings/_components/settings-tabs.tsx`,
  i18n
- Test: `tests/integration/business-type.test.ts` (create), `tests/e2e/business-profiles.spec.ts` (create)

**Interfaces:**
- Produces: `BusinessTypeInput = z.strictObject({ businessType: z.enum([...]) })`;
  `getBusinessType(ctx): Promise<BusinessTypeId>` (any member);
  `updateBusinessType(ctx, input: unknown, meta?): Promise<{ businessType }>` — `requireOwner(ctx,
  "business_type.update", meta)`, row lock like `lockOrg`, audit `settings.business_type.updated` `{ businessType:
  { from, to } }` only when it changes; server action `saveBusinessTypeAction(input)` returning `ActionResult`.
- Page: tab "Shop" / "المتجر" first in the tabs; `loadSettingsPage("settings.manage", "/settings/shop")`; radio list
  of the six types with icon and label; Owner sees Save, Admin sees the list disabled with a note
  (`settings.shop.ownerOnly`).

- [ ] **Step 1: Failing integration tests**: owner change writes the row and one audit event; same type → no audit;
  admin and cashier → `FORBIDDEN` with a denied audit like offline; other org untouched.
- [ ] **Step 2:** run → FAIL (module missing).
- [ ] **Step 3:** Implement service, action, page, tab.
- [ ] **Step 4:** E2E in `business-profiles.spec.ts`: owner (`ownerA` state, created in a fresh shop through
  onboarding to avoid changing the seeded shop — use the onboarding flow as `onboarding.spec.ts` does) opens
  Settings → Shop, picks Restaurant / café, saves, sees "Saved". Cashier `GET /settings/shop` shows the denied page.
- [ ] **Step 5:** run integration + E2E → PASS. Commit "UI refresh B: Shop setting for the business type".

### Task 3: Accent, icon and item word

**Files:**
- Create: `app/(app)/_components/business-theme.tsx` (Server Component)
- Modify: `app/(app)/layout.tsx`, `app/(app)/_components/app-shell.tsx` (brand icon slot),
  `app/(app)/_components/catalog-nav-link.tsx`, `app/(app)/catalog/products/page.tsx` (title + add button)
- Test: `tests/e2e/business-profiles.spec.ts`

**Interfaces:**
- Consumes: `profileOf` (Task 1).
- Produces: `BusinessTheme()` reads the tenant's org type (null when no tenant) and returns
  `<style>{css}</style>` with `:root{--accent;--accent-soft}` and the dark pair inside
  `@media (prefers-color-scheme: dark)`; rendered in the layout inside `<Suspense fallback={null}>`.
  `AppShell` takes `brand: ReactNode` (a Server Component that renders the profile `Icon`, default store).
  `orgBusinessType(orgId): Promise<BusinessTypeId>` cached per request with React `cache` in `modules/org`.

- [ ] **Step 1: Failing E2E** (same fresh café shop as Task 2, after the change): `--accent` computed on `:root` is
  the café light value; sidebar Catalog link name "Menu items"; products page heading "Menu items" and button
  "Add menu item". Retail admin: the Catalog link is still named "Catalog". Rule: profiles whose word is
  `products` keep the nav label "Catalog"; the others show their word in the nav; the products page title and add
  button always use the word.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** run business-profiles + catalog-admin + shell specs → PASS. Commit
  "UI refresh B: accent, icon and item word per business type".

### Task 4: Dashboard tiles per profile (end of PR 1)

**Files:**
- Modify: `modules/reports/service.ts` (+ `index.ts`), `app/(app)/dashboard/page.tsx`, i18n
- Test: `tests/unit/dashboard-tiles.test.ts` (create), `tests/integration/reports-dashboard.test.ts` (one case, or
  the existing dashboard tiles test file), `tests/e2e/business-profiles.spec.ts`

**Interfaces:**
- Produces: `averageTicketMinor(netSalesMinor: number, salesCount: number): number | null` (null when count is 0;
  rounded half up); `getTopItemsToday(ctx, limit = 5): Promise<{ name: string; nameAr: string | null; qty: number }[] | null>`
  — `reports.view` only, branches in scope, today in the shop zone, `q.products`, sorted by `qtySold - qtyRefunded`
  desc then name, net qty > 0.
- Dashboard renders tiles in `profile.dashboardTiles` order: `netSales sales refunds openShifts` as today,
  `lowStock` (existing tile, still only for `inventory.read`), `averageTicket` (StatTile, "—" when null),
  `topItems` (a card listing up to five names with quantities, linking to
  `/reports?report=products&range=today`; heading "Top items today" or "Top services today" for SALON; "No sales yet
  today" when empty).

- [ ] **Step 1: Failing tests**: unit `averageTicketMinor(1000, 3) === 333`, `(0, 0) === null`, `(1001, 2) === 501`;
  integration: two sales of item A (qty 3) and one of B (qty 1) today → `getTopItemsToday` = [A 3, B 1]; refunded
  line reduces qty; a cashier gets `null` (like `getDashboardTiles`).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** E2E: café shop dashboard shows "Average ticket" and "Top items today"; retail dashboard tiles
  unchanged (existing `inventory-low-stock.spec.ts` green). Full gate (lint, typecheck, format, vitest, Playwright).
- [ ] **Step 5:** Commit, push, open PR 1 "UI refresh B (1/2): business profiles"; merge after CI green.

### Task 5: Browse mode for the catalog search

**Files:**
- Modify: `modules/catalog/schemas.ts`, `modules/catalog/seam.ts`, `modules/catalog/index.ts`,
  `app/api/catalog/search/route.ts`, `modules/sales/offline-snapshot.ts`
- Test: `tests/unit/catalog-search.test.ts` (extend), `tests/integration/catalog-seam.test.ts` or the existing
  search integration file (extend)

**Interfaces:**
- Produces: `SellableSummary` gains optional `categoryId?: string | null` (set by `toSellableSummary`, so search,
  lookup, snapshot all carry it); `BrowseSellableQuery = z.strictObject({ categoryId: Uuid.optional(), limit:
  int 1–60 default 60 })`; `browseSellable(ctx, query: unknown): Promise<SellableSummary[]>` — active products (in the
  category when given) by name, variants expanded like search, capped at `limit`; route: `q` present → search as
  today; else `categoryId` or `all=1` → browse; else 400. `TillSnapshot.categories?: { id: string; name: string;
  nameAr: string | null }[]` (active categories, tree order flattened). `SNAPSHOT_VERSION` stays 1 (additive fields;
  the server accepts any version 1–1000).

- [ ] **Step 1: Failing tests**: schema accepts `{categoryId}`/`{}` and rejects `limit: 61`; integration: browse a
  category returns only its active items with `categoryId`, archived excluded, variants expanded, other org's
  category → empty; cashier allowed (`products.read`); snapshot includes `categories`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** run → PASS. Commit "UI refresh B: browse sellable items by category".

### Task 6: Till entry panels

**Files:**
- Create: `app/(app)/pos/_components/tile-panel.tsx`, `app/(app)/pos/_components/till-parts.tsx` (moved, unchanged:
  `DiscountBox`, `ExactCashButton`, `StockNote`, `OfflineBar`, `OfflineReceipt`), `app/(app)/pos/_lib/tiles.ts`
- Modify: `app/(app)/pos/_components/till.tsx`, `app/(app)/pos/page.tsx`, i18n
- Test: `tests/unit/pos-tiles.test.ts` (create), `tests/e2e/business-profiles.spec.ts`

**Interfaces:**
- Consumes: browse route and snapshot fields (Task 5), `profileOf` (Task 1).
- Produces: `snapshotTiles(snapshot: TillSnapshot, categoryId: string | null): TillItem[]` (first 60 by name, filtered
  by `categoryId` when given; items without `categoryId` only under "All"); `TilePanel({ locale, money, onAdd,
  offlineSnapshot, stock })` — chips "All" + categories (online: `GET /api/categories?status=active` flattened;
  offline: `snapshot.categories ?? []`), grid `grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]`, tiles `btn` with
  `min-h-24`, name `line-clamp-2`, price `dir="ltr"`, accessible name "Add {name}" (`pos.search.add`), "No items"
  (`pos.tiles.empty`) for an empty category. `Till` gets `layout: TillLayout`; with `"tiles"` the TilePanel renders
  under the search box (search results, when present, still show above it).
- Ruling recorded here: `till.tsx` keeps cart and payment in one component (they share ~20 pieces of state); the split
  moves the self-contained sub-components out and adds the panel. Spec BP6's deeper split is not worth a state
  container now.

- [ ] **Step 1: Failing tests**: unit `snapshotTiles` (old snapshot without categories → "All" works; category
  filter; cap 60). E2E in a fresh café shop: create category "Hot drinks" and product "Latte" (EGP 45) through the
  catalog UI or `createRunProduct` with a category, open a shift, tap chip "Hot drinks", tap "Add Latte", charge
  exact cash, receipt shows Latte; an empty category shows "No items"; a 60-char Arabic name tile is ≤ 96 px tall;
  retail till still shows no tiles (`getByTestId("till-tiles")` count 0).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement (move sub-components first, run `pos-*.spec.ts` green, then add the panel).
- [ ] **Step 4:** run unit + `business-profiles.spec.ts` + all `pos*.spec.ts` + offline specs → PASS. Commit.

### Task 7: Verification and PR 2

- [ ] **Step 1:** Full gate → green.
- [ ] **Step 2:** Screenshots: café till with tiles light/dark, salon dashboard AR, retail unchanged.
- [ ] **Step 3:** `docs/planning/ui-refresh/business-profiles-as-built.md`, phase-status line, README row.
- [ ] **Step 4:** Final whole-branch review (fresh reviewer), fix pass, push, PR 2 "UI refresh B (2/2): till tiles",
  merge after CI green.
