# Phase 6 / T3 — Catalog Specification (merged)

Status: **built 2026-10-11**, T3.0–T3.9 merged to `main` (PR #3). Approved 2026-10-11:
Q1–Q4 accepted by the owner as recommended; Q5–Q13 take their defaults.

## As built — deviations from the plan

The code is the source of truth; the contract as built is in
[api-contracts.md](../../architecture/api-contracts.md#catalog-built-in-phase-6--t3) and
[database-design.md](../../architecture/database-design.md#catalog-hardening-phase-6-migration-_catalog_hardening).

- **Aggregate atomic save.** The product form saves product + variants + barcodes in one transaction
  (`createProductAggregate` / `updateProductAggregate`, Server Actions only, no Route Handler).
- **Route write order.** Write routes skip the route-level permission check; the service checks the permission,
  audit-logs a denial (C-14), then validates the body. An unauthorised caller gets 403 whatever it sends.
- **403 in the UI** is rendered in-page with HTTP status 200 (a page cannot set a 403 status); the API returns a real 403.
- **Root `lang`/`dir`** follow the `pos_locale` cookie through an inline script in `app/layout.tsx` (per the Next docs),
  so routes stay static/prerenderable.
- **`UNIT_TYPES`** (`{en, ar}` labels) is not exported from `modules/catalog`; `UNIT_TYPE_VALUES` /
  `SUPPORTED_UNIT_TYPES` are, and labels live in the i18n dictionary.
- **`TODO(T4)` in `createVariant`:** switching a product to variants does not yet ask inventory whether
  `variantId = NULL` stock rows exist; T4 must add that seam check.
- **Extra API surface:** `GET /api/catalog/search` (`searchSellable`), `vatCategory` list filter, `primaryBarcode` on
  `ProductSummary`, `VARIANT_REQUIRED` lookup reason with a variant picker, 409 `PRIMARY_BARCODE_TAKEN`.
- **`vatApplicable`** is derived from `vatCategory` and is not an input field (Q3).
- **`UNIT_IMMUTABLE`** is never raised: `unitType` is not an accepted PATCH key, so it fails the strict schema (422).
- **E2E (T3.8)** runs against a dedicated `E2E_DATABASE_URL` database, migrated and seeded by Playwright's global
  setup. Specs: `catalog-admin`, `catalog-conflicts`, `catalog-access`, `catalog-rtl`, plus `catalog-isolation`.

This is the entry point for T3 "Catalog CRUD + constraints" (`docs/planning/task-breakdown.md`).
The detail lives in three parts; where they disagree, **this file wins** (see §3).

| Part | File |
|---|---|
| Data model, constraints, migration | [catalog-data-model.md](catalog-data-model.md) |
| API contracts, rules, permissions, audit, module seam | [catalog-api-and-rules.md](catalog-api-and-rules.md) |
| Screens, acceptance criteria (C-1…C-29), test plan | [catalog-ux-and-tests.md](catalog-ux-and-tests.md) |
| Build order | [catalog-task-plan.md](catalog-task-plan.md) |

## 1. Key fact

The Phase 5 init migration already created `Category`, `Product`, `ProductVariant`, `Barcode`
with org scoping, composite `(orgId, id)` FKs, minor-unit money and per-org unique SKU/barcode.
T3 is therefore a **hardening + services + UI** task, not new tables. All schema changes are additive.

## 2. Agreed across all three parts

- Org-wide catalog (no `branchId`); `orgId` only from the session; other-tenant ids → 404.
- Money as integer minor units ≥ 0; VAT rate never on the product (`vatApplicable` × `Organization.vatRateBp`, snapshotted at sale).
- Archive (`isActive=false`) instead of delete; only barcodes are hard-deleted.
- Archived SKUs/barcodes stay reserved.
- `unitType` immutable after creation.
- One SKU namespace across products **and** variants (today only per-table unique).
- Variant price/cost `null` = inherit from product. Flat variants (free-text name), no option tables in MVP.
- Every write audited in the same transaction → a minimal `audit.record(tx, event)` moves forward from T9 into T3.
- No bulk import in MVP.
- Cost never returned to callers without `products.update`.
- Scanner lookup is a `GET` Route Handler (Server Actions are queued per client); back-office pages call `modules/catalog` directly from Server Components.

## 3. Conflicts between the parts — resolved here

| # | Topic | Disagreement | Resolution (proposed) |
|---|---|---|---|
| R1 | Cashier POS lookup | Data/API: grant `products.read` to Cashier (+Manager). UX: gate lookup on `sales.create` instead. | Grant `products.read` to Manager + Cashier. Cost is already stripped for non-editors, so no extra any-of permission plumbing. **→ decision Q1** |
| R2 | SKU case | Data: upper-case on write + DB CHECK. API/UX: preserve case. | Upper-case on write + DB CHECK (scanners and humans type both cases; avoids `a-1` vs `A-1` duplicates). **→ Q4** |
| R3 | SKU cross-table uniqueness | Data: DB trigger with advisory lock. API: service check in tx. | Trigger (a service check alone is race-prone under READ COMMITTED). Service check kept for nice 409 messages. |
| R4 | Category depth | Data/API: 3. UX: 2. | 3 levels (service-enforced). |
| R5 | Archive category that has products | API/Data: allowed, products keep category. UX: block while it has active products. | Allowed; products stay sellable, category hidden from filters and can't be newly assigned. Block only while it has **active child categories**. **→ Q6** |
| R6 | Sibling category names | Data: DB unique index over all siblings. API: active siblings only. | DB unique index over all siblings (case-insensitive) — simpler, and archived names are rarely reused. |
| R7 | Hard delete | Data: try delete, fall back to archive. API/UX: no hard delete. | No hard delete of products/variants/categories in MVP. |
| R8 | Archived barcode at POS | API: resolves with `sellable:false, reason`. UX: show "not found". | API returns `sellable:false`; POS shows **"Item archived — not for sale"** (less confusing for staff than "unknown"). |
| R9 | KG unit | Data: hide in UI, keep enum. API: reject KG with 422. UX: selectable. | API rejects `KG` in T3 (`UNIT_NOT_SUPPORTED`); UI shows EACH only. **→ Q5** |
| R10 | Variant rule source | Data: `Product.hasVariants` flag. API: derived from "has active variants". | `hasVariants` flag (O(1) rule for T4/T6; archiving the last variant must not flip semantics). |
| R11 | Search | Data: `pg_trgm` now. API: `ILIKE` now, trigram later. | `ILIKE` now; trigram + Arabic normalisation when needed. **→ Q8** |
| R12 | Names of seam functions / audit actions | UX used `lookupByBarcode`, `searchSellable`, `product.created`. | Use API part names: `lookupCode`, `getSellableItems`, `getItemsForHistory`, `assertStockable`, plus `searchSellable`; audit actions `catalog.<entity>.<verb>`. |
| R13 | Page size | UX 50, API default 25 (max 100). | API default 25; the back-office list requests 50. |
| R14 | `/catalog/units` page | UX optional. | Drop it; unit is a select on the product form. |

## 4. Decisions needed from the owner

Defaults are what the build will use unless overruled.

**Decided by owner (2026-10-11): all four as the default below.**

| Q | Question | Default |
|---|---|---|
| Q1 | Cashier/Manager catalog read for POS scan & search (blocks T6) | Grant `products.read` to Manager + Cashier; no cost exposed |
| Q2 | Are shelf prices VAT-inclusive? (blocks T6) | Org setting `pricesIncludeVat`, default **true** for EG and SA (new column on `Organization`) |
| Q3 | Add `VatCategory` (standard / zero-rated / exempt) now for future e-invoicing? | Yes, additive; keep `vatApplicable` derived |
| Q4 | SKU case | Upper-case on write |

**Can take the default**

| Q | Question | Default |
|---|---|---|
| Q5 | KG products in MVP | No (EACH only) until the grocery preset |
| Q6 | Archiving a category that has products | Allowed (see R5) |
| Q7 | Arabic product name required for SA tenants | Optional |
| Q8 | Trigram search now | No, `ILIKE` until catalogs ≳10k items |
| Q9 | Lock `Organization.currency` once catalog data exists | Yes (org-module rule) |
| Q10 | Separate `products.price` permission | No |
| Q11 | i18n mechanism | Typed EN/AR dictionary module, no library |
| Q12 | Digits in Arabic UI | Latin digits for prices/SKUs; input accepts both |
| Q13 | E2E seed + database | `prisma/seed-e2e.ts` from Playwright `globalSetup`, separate `E2E_DATABASE_URL` |
