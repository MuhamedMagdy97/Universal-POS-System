# Phase 6 / T3 — Catalog UX, Acceptance Criteria & Test Plan

Scope: screens, behaviour, acceptance criteria, tests. DB schema and API contract
details live in their own Phase 6 docs (do not duplicate here). Inputs:
`docs/product/{requirements,business-rules,user-flows,user-roles-permissions}.md`,
`docs/quality/{acceptance-criteria,testing-strategy}.md`, `prisma/schema.prisma`
(Category, Product, ProductVariant, Barcode, `UnitType`), `lib/auth/permissions.ts`,
`app/(app)/layout.tsx`, `tests/integration/helpers.ts`.

Items marked **DECISION NEEDED** are recommendations pending a ruling.

## 1. Screen inventory

### 1.1 Routes (back-office shell = existing `app/(app)` group)

All pages sit under `app/(app)/` so they inherit the authenticated shell
(`app/(app)/layout.tsx`: header, `TenantBadge`, `LocaleToggle`) and the deny-by-default
`proxy.ts` gate. Session-reading parts render behind `<Suspense>` as in
`app/(app)/dashboard/page.tsx` (Cache Components). Shared pieces go in
`app/(app)/catalog/_components/`; domain logic in `modules/catalog/`.

| Route | Purpose | Permission |
|---|---|---|
| `/catalog` | redirect to `/catalog/products` | — |
| `/catalog/products` | list, search, filter, paginate | `products.read` |
| `/catalog/products/new` | create product (+ variants, barcodes) | `products.create` |
| `/catalog/products/[productId]` | edit; archive/restore | `products.update` (read-only view with `products.read`) |
| `/catalog/categories` | list + inline create/rename/archive, one level of parent | read: `products.read`; write: `products.update` |
| `/catalog/units` | read-only reference of `UnitType` (EACH, KG) | `products.read` |

Add a "Catalog" link to the shell header nav, shown only when the member holds
`products.read` (UI hiding is cosmetic; server still enforces).

**Units — DECISION NEEDED (D1):** the schema has a fixed `UnitType` enum (EACH/KG),
no Unit table. Recommend: no units CRUD in MVP; unit is a select on the product
form; `/catalog/units` is optional (drop it if not wanted). KG selling relates to
scale integration (Future) — recommend KG is selectable but sold with manual
decimal qty only when checkout supports it (T6).

### 1.2 Product list `/catalog/products`
- Columns: name (EN or AR per locale, fallback to the other), SKU, primary barcode,
  category, price (formatted), VAT flag, status badge (Active/Archived).
- Search box (autofocus): matches name / nameAr (contains, case-insensitive),
  SKU (prefix), barcode (exact). A barcode scan into the box resolves exact match
  and opens that product.
- Filters: category, status (Active default / Archived / All), VAT applicable.
  Filters + query live in URL search params (shareable, back-button safe).
- Cursor pagination (`docs/architecture/api-contracts.md`), page size 50.
- States: loading = table skeleton; empty catalog = "No products yet" + "Add
  product" CTA (CTA hidden without `products.create`); no results = "No match for
  '{q}'" + clear filters; error = inline banner + Retry; permission denied =
  403 page "You don't have access to the catalog" (no data rendered).

### 1.3 Product create / edit
- Fields: name (EN, required), nameAr (optional — **DECISION NEEDED D2**: require
  Arabic name for SA tenants?), SKU (required, trimmed, case-preserved; uniqueness
  per org), category (optional), unit (EACH/KG), price (major-unit input parsed with
  `parseMajor` from `lib/money.ts` to minor units; ≥ 0), cost (optional, default 0),
  VAT applicable (default on), barcodes (0..n), variants (0..n: name, nameAr, SKU,
  optional price/cost override = "inherit" when blank, own barcodes).
- Barcode entry: focused "Scan or type barcode" field; scanner input ends with
  Enter → chip added, field cleared, focus stays. Duplicate within the form →
  inline error, not added. Server conflict → inline on that chip.
- Save: `Ctrl+S`/`Cmd+S` and the Save button; `Esc` = cancel (confirm if dirty).
  Double-submit guarded (button disabled while pending).
- Conflicts (409): field-level messages — "SKU already used by {product}" (link if
  reader has access), "Barcode already assigned to {product}". Never reveal data
  from another tenant (other-tenant duplicates cannot occur: uniqueness is per org).
- Validation (422): inline per field, first invalid field focused, summary
  `role="alert"` at top.
- Price change on edit shows hint: "Past sales keep their original price"
  (business rule 4).
- States: loading skeleton; not found / other-tenant id → 404 page; read-only
  mode (only `products.read`) disables inputs and hides Save/Archive.

### 1.4 Archive (deactivate)
- No delete in MVP UI (business rule 8). "Archive" on edit page with confirm
  dialog; "Restore" on archived items. Archived products: hidden from POS search,
  barcode scan, and default list filter; remain visible on historical sales and in
  reports.
- **DECISION NEEDED D3:** hard-delete of never-referenced products? Recommend no
  (archive only) in MVP — simpler, audit-safe.
- **DECISION NEEDED D4:** archived product keeps its SKU/barcodes reserved (cannot
  be reused by a new product)? Recommend yes (keeps uniqueness simple, avoids
  historical ambiguity); user must restore or edit the archived item.
- Archiving a category: blocked while it has active products (422 with count),
  or **DECISION NEEDED D5** (alternative: move products to "Uncategorised").

### 1.5 Categories `/catalog/categories`
Flat list with optional parent (schema supports a tree; UI limits depth to 2 —
**DECISION NEEDED D6**). Inline add (Enter saves), rename (F2 / edit icon),
archive. Name EN required, nameAr optional. Duplicate name within same parent →
**DECISION NEEDED D7** (no DB constraint today; recommend app-level 409, case-insensitive).

### 1.6 POS shell consumption
The POS shell is a separate route group (to be created in T6), recommended
`app/(pos)/pos/` with its own minimal full-screen layout. T3 delivers only the
**catalog lookup seam** it consumes: `modules/catalog` exports
`lookupByBarcode(orgId, code)` and `searchSellable(orgId, q, limit)` returning
active products/variants with price (minor), VAT flag, unit, names.
- Scan: scanner keystrokes + Enter in the always-focused search field → exact
  barcode match → add line (qty +1 if already in cart). Not found → beep-style
  inline error "Barcode {code} not found", field cleared + refocused; archived →
  same "not found" (no hint it exists).
- Type-to-search: debounced (~200 ms) list, ↑/↓ navigate, Enter adds, Esc clears.
  Product with variants → variant picker (keyboard navigable).
- Scanner heuristic: input arriving faster than human typing and ending in Enter
  is treated as a scan; an exact barcode match always wins over text search.
- **DECISION NEEDED D8 (blocking):** default Cashier role lacks `products.read`
  (`lib/auth/permissions.ts`). Recommend POS lookup is authorised by
  `sales.create` (sellable-items read only: no cost, no archived), not by granting
  cashiers full `products.read`. Cost must never appear in POS responses.

### 1.7 Keyboard / scanner contract (back office)
`/` focuses search on list; `N` (when no input focused) = new product; `Enter` in
search with exact barcode/SKU opens it; `Ctrl/Cmd+S` save; `Esc` cancel/close
dialog; Tab order follows visual order in both LTR and RTL. Scanner = keyboard
wedge with Enter suffix; no device driver in MVP.

### 1.8 EN/AR, RTL, currency
- Use logical CSS properties only (`ms-*`, `ps-*`, `text-start`), matching
  `app/(app)/layout.tsx`; `LocaleToggle` flips `dir`. Full string catalog arrives in
  T10 — T3 must route all UI strings through a single dictionary (keys, EN + AR)
  so T10 only wires persistence. **DECISION NEEDED D9:** i18n mechanism (plain
  typed dictionary vs library) — recommend a typed dictionary module, no dependency.
- Names: show `nameAr` in AR locale, fall back to `name`; search covers both.
- SKU, barcode, and price inputs are `dir="ltr"` and `inputMode` numeric where
  relevant, even in RTL. Barcodes/SKUs render with `<bdi>`/`dir="ltr"`.
- Money display via one formatter (add `formatMinor(minor, currency, locale)` to
  `lib/money.ts`, using `Intl.NumberFormat` with integer → major conversion via
  `CURRENCY_MINOR_DIGITS`, no float arithmetic on stored values). EGP/SAR from the
  org, never from the client. **DECISION NEEDED D10:** Arabic-Indic digits in AR
  locale (`ar-EG`/`ar-SA` default) or Latin digits (`ar-EG-u-nu-latn`)? Recommend
  Latin digits for prices/SKUs in MVP (cashier/scanner consistency), revisit in T10.
- Input accepts both Latin and Arabic-Indic digits and normalises before `parseMajor`.

## 2. Acceptance criteria (T3)

Numbering `C-n`; cross-refs to `docs/quality/acceptance-criteria.md` (AC-n).
Roles per `lib/auth/permissions.ts`. "Org A/B" = two tenants from `createTenant`.

**Happy paths**
- **C-1** Given an Admin of Org A, When they create a product with name, SKU, price
  "12.50" (EGP), Then it is stored with `priceMinor = 1250`, appears in the list,
  and an audit event `product.created` is recorded.
- **C-2** Given an existing product, When an Admin edits its price, Then the new
  price shows in the list and POS lookup, and previously completed sale items keep
  their snapshot price (AC-9).
- **C-3** Given a product with variants where a variant price is blank, When it is
  looked up, Then the variant inherits the product price.
- **C-4** Given the product form focused on the barcode field, When a scanner
  sends `6221234567890⏎`, Then a barcode chip is added, the field clears and keeps
  focus; on save the barcode is linked to the product (or variant).
- **C-5** Given 120 active products, When the user searches by partial name, SKU
  prefix, or exact barcode, Then matching rows are returned with cursor pagination
  and filters reflected in the URL.
- **C-6** Given an Admin, When they create a category and assign products to it,
  Then filtering by that category lists exactly those products.
- **C-7** Given the AR locale, When the list renders, Then layout is RTL, Arabic
  names are shown (fallback to English), SKUs/barcodes stay LTR, and prices are
  formatted in the org currency.

**Tenant isolation (AC-6)**
- **C-8** Given a product in Org B, When an Org A user requests it by id (page or
  API), Then the response is 404 and no Org B data is returned.
- **C-9** Given Org B has SKU `X1` and barcode `B1`, When Org A creates a product
  with SKU `X1` and barcode `B1`, Then it succeeds (uniqueness is per org).
- **C-10** Given an Org A user, When they search or scan Org B's barcode, Then no
  result is returned (list, POS lookup).
- **C-11** Given an Org A user, When they submit a product with Org B's
  `categoryId` (or attach a barcode to Org B's product), Then it is rejected
  (404/422) and nothing is written.
- **C-12** Given a request body containing `orgId`, When a product is created,
  Then the `orgId` from the session is used and the body value ignored.

**Permission denial (AC-4 pattern)**
- **C-13** Given a Cashier or Reporting user, When they open `/catalog/products`
  or call the products read endpoint, Then they get 403 and the page shows the
  permission-denied state (subject to D8 for POS lookup).
- **C-14** Given a Manager (no `products.create/update` by default), When they
  POST/PATCH a product, Then 403 is returned, nothing changes, and a denied
  attempt is audit-logged.
- **C-15** Given a user with only `products.read`, When they open a product, Then
  inputs are read-only and Save/Archive are hidden; a forged update still gets 403.
- **C-16** Given no session, When any catalog page/API is hit, Then pages redirect
  to `/login?next=…` and APIs return 401 with the error envelope (as in
  `tests/e2e/smoke.spec.ts`).

**Uniqueness conflicts (business rule 8)**
- **C-17** Given SKU `A-100` exists in Org A, When another product (or variant)
  is saved with `A-100`, Then 409 with field `sku` is returned and shown inline.
- **C-18** Given barcode `B1` is on product P, When it is added to product Q (or a
  variant) in the same org, Then 409 with field `barcodes[i]` names P.
- **C-19** Given the same barcode entered twice in one form, Then it is rejected
  client-side and server-side (422) before reaching the DB constraint.
- **C-20** Given two concurrent creates with the same SKU, Then exactly one
  succeeds and the other receives 409 (no 500).
- **C-21** Given a product SKU equal to an existing variant SKU in the same org,
  Then the result follows **DECISION NEEDED D11** (recommend 409: SKUs unique across
  products and variants; today only per-table constraints exist).

**Archived items**
- **C-22** Given an Admin archives a product, Then it disappears from the default
  list, POS search and barcode lookup, and an audit event is recorded.
- **C-23** Given an archived product referenced by past sales, Then those sales,
  receipts and reports still show its name and snapshot price.
- **C-24** Given an archived product, When the status filter is "Archived", Then
  it is listed and can be restored; after restore it is sellable again.
- **C-25** Given an archived product holding SKU `A-1`, When a new product uses
  `A-1`, Then 409 (per D4).
- **C-26** Given a category with active products, When archive is attempted, Then
  it is blocked with a count (per D5).
- **C-27** No delete control exists in the UI and no delete endpoint succeeds for a
  referenced product.

**Validation & money**
- **C-28** Given price "12.345", "-1", "abc" or above `MAX_STORABLE_MINOR`, Then
  422 with field `price`; "١٢٫٥٠" (Arabic-Indic) parses to 1250.
- **C-29** Given an empty name or SKU (after trim), Then 422 per field.

## 3. Test plan

Conventions (from `vitest.config.mts`, `playwright.config.ts`, `tests/`):
unit `tests/unit/*.test.ts`; integration `tests/integration/*.test.ts` against
`TEST_DATABASE_URL`, sequential (`fileParallelism: false`), unique tenants per call
via `tests/integration/helpers.ts`; e2e `tests/e2e/*.spec.ts` against `next start`.

### 3.1 Unit (Vitest, no DB)
| File | Covers |
|---|---|
| `tests/unit/catalog-validation.test.ts` | zod schemas: trim, required fields, SKU/barcode charset + length, duplicate barcodes in payload, variant inherit (null) vs override — C-19, C-28, C-29 |
| `tests/unit/money.test.ts` (extend) | `formatMinor` EGP/SAR × en/ar; Arabic-Indic digit normalisation before `parseMajor` — C-7, C-28 |
| `tests/unit/permissions.test.ts` (extend) | catalog gates per role incl. D8 outcome — C-13, C-14 |
| `tests/unit/catalog-search.test.ts` | query classification (exact barcode vs SKU prefix vs name), scan heuristic helper — C-5, POS scan rule |

### 3.2 Integration (Vitest + Postgres)
| File | Covers |
|---|---|
| `tests/integration/catalog-products.test.ts` | create/edit/variants/barcodes via `modules/catalog` service, audit rows, price-edit leaves SaleItem snapshot — C-1–C-4, C-6, C-2/AC-9 |
| `tests/integration/catalog-conflicts.test.ts` | SKU/barcode 409 mapping (Prisma P2002 → AppError 409 with field), concurrent same-SKU via `Promise.allSettled`, product-vs-variant SKU (D11) — C-17–C-21, C-25 |
| `tests/integration/catalog-isolation.test.ts` | auth/isolation matrix for every catalog route handler: no session 401, wrong org 404, role 403, forged `orgId`/foreign `categoryId` — C-8–C-16 (pattern: `tenant-guard.test.ts`) |
| `tests/integration/catalog-archive.test.ts` | archive/restore, excluded from search + `lookupByBarcode`, category archive guard, no delete — C-22–C-27 |
| `tests/integration/catalog-search.test.ts` | name/nameAr/SKU/barcode search, cursor pagination stability, filters — C-5, C-10 |

Keep `tests/integration/db-constraints.test.ts` as the DB-level layer; the new
files test the service/route layer that turns constraint errors into envelopes.

### 3.3 E2E (Playwright)
| File | Covers |
|---|---|
| `tests/e2e/catalog-admin.spec.ts` | login as seeded Admin → create product with scanned barcode (`page.keyboard.type(code)` + Enter) → find via search → edit price → archive → restore — C-1, C-4, C-5, C-22, C-24 |
| `tests/e2e/catalog-conflicts.spec.ts` | duplicate SKU/barcode shows inline field errors; double-click Save creates one product — C-17, C-18 |
| `tests/e2e/catalog-access.spec.ts` | Cashier/Reporting see permission-denied; unauthenticated redirect — C-13, C-16 |
| `tests/e2e/catalog-rtl.spec.ts` | toggle AR: `html[dir=rtl]`, Arabic name shown, SKU cell LTR, price formatted — C-7 |
| `tests/e2e/pos-scan.spec.ts` | (lands with T6) scan adds line, unknown/archived barcode error + refocus — §1.6 |

Keyboard-only path (no mouse) asserted in `catalog-admin.spec.ts`.

### 3.4 Test data / seed needs
- Extend `tests/integration/helpers.ts`: `createMember(db, orgId, role, opts)`,
  `createCategory`, `createBarcode`, `createVariant`, `archiveProduct`; reuse
  `createTenant` (EG/EGP/1400 bp) and add an SA variant (SAR/1500 bp).
- E2E seed (**DECISION NEEDED D12**: script location, recommend `prisma/seed-e2e.ts`
  run from Playwright `globalSetup`, idempotent, test DB only): two orgs (EG, SA),
  users Owner/Admin/Manager/Cashier/Reporting in Org A with known test passwords
  stored in the seed file (never real credentials), ~60 products incl. Arabic names,
  2 with variants, 1 archived, KG unit item, shared SKU/barcode values across
  Org A and B to prove isolation.
- E2E currently runs against the dev DB via `next start`; needs a dedicated
  e2e DB URL so seed + tests never touch dev data (part of D12).

## 4. DECISION NEEDED (summary)
D1 units management · D2 Arabic name required for SA · D3 hard-delete of
unreferenced products · D4 archived items reserve SKU/barcode · D5 category
archive with active products · D6 category depth · D7 category name uniqueness ·
D8 POS lookup permission for cashiers (blocking) · D9 i18n mechanism ·
D10 digit system in AR · D11 SKU unique across products+variants · D12 e2e seed
+ database.
