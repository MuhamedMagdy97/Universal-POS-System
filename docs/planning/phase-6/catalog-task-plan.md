# Phase 6 / T3 — Catalog Task Plan

Status (2026-10-11): **T3.0–T3.9 done** (incl. T3.7b atomic save / primary barcode / VAT filter / locale dir);
merged to `main` in PR #3.

Source spec: [catalog-spec.md](catalog-spec.md). Each task ends with lint, tsc and the relevant tests green, plus one commit.
Tasks in the same **lane** have no dependency on each other and can be built in parallel (separate worktrees).

```
0 ─┬─ 1 (schema) ───────────┐
   ├─ 2 (cross-cutting libs) ┼─ 4 (services) ─┬─ 5 (seam) ─┬─ 6 (routes) ─┐
   └─ 3 (zod schemas) ───────┘                └─ 7 (UI) ───┴──────────────┴─ 8 (e2e) ─ 9 (docs)
```

## T3.0 — Decision sign-off
Owner answers Q1–Q4 in `catalog-spec.md` §4 (others take defaults). **Blocks everything.**

## Lane A (parallel after T3.0)

### T3.1 — Catalog hardening migration
- `prisma/schema.prisma` + `prisma/migrations/<ts>_catalog_hardening/` (`migrate dev --create-only`, then hand-written SQL).
- Adds: `Product.hasVariants` (+ backfill), `ProductVariant.sortOrder` + `@@unique([orgId, productId, id])`,
  `Barcode.isPrimary/updatedAt` + 3-column FK + one-primary partial index + `@@index([orgId, productId])`,
  `Category.sortOrder` + sibling-name unique index, SKU/barcode/name CHECKs, cross-table SKU trigger,
  `Organization.pricesIncludeVat` (Q2), `VatCategory` (if Q3 = yes).
- Pre-flight data check script for existing dev data.
- **Tests:** extend `tests/integration/db-constraints.test.ts` — one rejected row per new constraint, cross-tenant FK failures, concurrent same-SKU across product/variant.
- **Done when:** migration applies cleanly on fresh and existing `pos_dev`/`pos_test`.

### T3.2 — Cross-cutting pieces
- `lib/auth/permissions.ts`: `products.read` → MANAGER, CASHIER (Q1); extend `tests/unit/permissions.test.ts`.
- `modules/audit`: minimal append-only `audit.record(tx, event)` filling org/branch/actor/requestId.
- `lib/money.ts`: `formatMinor(minor, currency, locale)` + Arabic-Indic digit normalisation before `parseMajor`; extend `tests/unit/money.test.ts`.
- Typed EN/AR dictionary module (Q11) with catalog keys.
- **Done when:** unit tests green; nothing depends on T3.1.

### T3.3 — Catalog zod schemas
- `modules/catalog/schemas.ts`: `Sku`, `BarcodeCode`, `Minor`, `Name`, `CreateProduct`, `UpdateProduct`, variant/category/barcode inputs, `LookupResult`, `Page<T>`, cursor codec.
- **Tests:** `tests/unit/catalog-validation.test.ts` (C-19, C-28, C-29).

## Lane B

### T3.4 — Catalog services (deps: T3.1, T3.2, T3.3)
- `modules/catalog/*`: product, variant, category, barcode create/update/archive/restore/list/get; `expectedUpdatedAt` → `STALE_WRITE`;
  P2002 → specific 409 `AppError` with `{reason, field, existingId}`; category depth/cycle rules; `unitType` immutability; audit in the same tx; cost stripped without `products.update`.
- **Tests:** `tests/integration/catalog-products.test.ts`, `catalog-conflicts.test.ts`, `catalog-archive.test.ts`, `catalog-search.test.ts`; `tests/unit/catalog-search.test.ts`.

## Lane C (parallel after T3.4)

### T3.5 — Cross-module seam (deps: T3.4)
- Export `lookupCode`, `searchSellable`, `getSellableItems`, `getItemsForHistory`, `assertStockable`, `UNIT_TYPES` from `modules/catalog/index.ts`. Tx-aware, input-order results, `ITEM_NOT_SELLABLE`.
- **Tests:** integration for archived/variant-rule rejection and cross-tenant refs.

### T3.7 — Back-office UI (deps: T3.4, T3.2)
- `app/(app)/catalog/{products,products/new,products/[productId],categories}` + `_components/`; header nav link gated on `products.read`.
- URL-driven search/filters, cursor pagination, all states (loading/empty/no-results/error/403/404), scanner barcode chips, keyboard shortcuts, RTL with logical CSS, LTR SKU/barcode/price fields.
- Server Actions as thin adapters (re-check `requireTenant`, same zod schema).

## Lane D

### T3.6 — Route Handlers (deps: T3.5)
- `app/api/{products,categories,barcodes}/…` per `catalog-api-and-rules.md` §4: `handleRoute` → `requireTenant` → zod → service; `cache-control: no-store`.
- **Tests:** `tests/integration/catalog-isolation.test.ts` (401/403/404 matrix, forged `orgId`, foreign `categoryId`, Cashier never sees `costMinor`) — C-8…C-16.

### T3.8 — E2E (deps: T3.6, T3.7)
- `prisma/seed-e2e.ts` + Playwright `globalSetup`, dedicated `E2E_DATABASE_URL` (Q13); update `.env.example`, CI workflow.
- Specs: `catalog-admin`, `catalog-conflicts`, `catalog-access`, `catalog-rtl` (`pos-scan` deferred to T6).

### T3.9 — Docs (deps: all)
- Update `docs/architecture/api-contracts.md`, `database-design.md`, `docs/planning/phase-status.md`, `roadmap.md`, README env table.

## Parallelism summary
- After sign-off: **T3.1 ∥ T3.2 ∥ T3.3** (3 agents).
- After T3.4: **T3.5 ∥ T3.7** (2 agents); T3.6 follows T3.5.
- T3.4 is the single serial bottleneck; keep it in one agent.
