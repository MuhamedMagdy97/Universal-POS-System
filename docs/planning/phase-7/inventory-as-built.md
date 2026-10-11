# Phase 7 / T4 — Inventory As Built

Status: **built 2026-10-11** on branch `phase-7/inventory`, tasks T4.1–T4.8 complete. Spec:
[inventory-spec.md](inventory-spec.md). Plan: [inventory-task-plan.md](inventory-task-plan.md). The code is the source
of truth; where it differs from the spec, this file records why.

## What shipped

| Task | Commit | Deliverable |
|---|---|---|
| spec | `f3b1d90` | spec, data model, API/rules, UX/tests |
| plan | `d9db89f` | task plan (T4.1–T4.9) |
| T4.1 | `e7ca7d4` | migration `*_inventory` (enum, sign and note CHECKs, two unique indexes, `StockBalance` index); preflight script; constraint tests |
| T4.2 | `b1f3ac2` | `inventory.read` (Owner, Admin, Manager, Reporting); zod schemas; nav link; i18n keys |
| T4.3 | `1e4a9cc` | ledger core: `applyLines` (the single write path), ordered row locks, `recordMovements` seam, `getOnHand`, `hasUnvariantedStock`, `reconcile` |
| T4.4 | `6b9bb9b` | services: opening, adjust, transfer, stock list, item history |
| T4.5 | `d41a9ae` | catalog guard resolves `TODO(T4)`: `PRODUCT_HAS_STOCK` on switching a product to variants |
| T4.6 | `f655d85` | five Route Handlers and the isolation matrix |
| T4.7 | `5d17be4` | back-office screens: stock list, item history, adjust dialog, transfer form, opening grid |
| T4.8 | `90ee110` | E2E specs (admin flow, role access, Arabic RTL); seed gains a second branch |

## Deviations from the spec

1. **Error shape.** Errors use the shared `ErrorCode`s with the cause in `details.reason`, as catalog does.
2. **I-14 wording.** The seam answers `ITEM_NOT_SELLABLE` with `details.cause: VARIANT_REQUIRED`, not a top-level
   `VARIANT_REQUIRED`. The catalog seam (T3.5) already answered that way, so its contract was kept.
3. **Catalog check without a hook.** `hasUnvariantedStock` lives in `modules/inventory/queries.ts`, which imports nothing
   from catalog. Catalog imports that file directly; the module graph has no cycle.
4. **Transfer replay** returns the requested lines, not the balances. Balances move with later sales, so a client
   should re-read the stock list.
5. **Stock list paging** counts item rows (a product or one variant), not products. The `unopened` filter was added
   for the opening grid. `StockRow` includes `primaryBarcode` (spec API row).
6. **Opening grid** shows the first 100 unopened items, is searchable, and says so when there are more. The first E2E
   run failed on this (seed products sorted before the run's item); the search box closed the gap.
7. **Transfer form** searches `GET /api/inventory/stock`, not catalog search: the stock rows already carry the source
   balance for the preview.
8. **Files.** `recordMovements` and `applyLines` live in `ledger.ts`; the item reference type is in `types.ts`; route
   and branch guards are in `access.ts`. The plan named no seam file, so this is not a contract change.
9. **Preflight** (`scripts/preflight-inventory.sql`) checks the pre-migration columns only. The sub-reason rules need no
   check because the new column is NULL on every existing row.
10. **Reporting** holds `inventory.read` (spec D5). The existing permission test that asserted "reports.view only" was
    updated to match.
11. **Archived items (D8, decided after review).** Archived stock can be written off (decreasing adjustments, including
    a downward count) and transferred; opening stock, increases and sales stay refused. This replaces the original
    I-13 ("adjust/transfer refused"), which left archived stock stuck.

## Fixed after the post-build review

Each fix has a test that failed first (UI fixes: the E2E was checked by re-introducing the old code).

- Unknown or other-org items on adjust, opening, transfer and refunds answered 500 (raw lock INSERT hit a foreign key);
  services now check items exist before locking, so they answer 404.
- The stock list showed another variant's primary barcode on variant rows, and a variant's barcode found every variant
  of the product; both now match the variant.
- `variantName` is `null` (not `""`) for products without variants.
- A forged history cursor answered 500; the cursor date is validated (422 `INVALID_CURSOR`).
- The adjust dialog kept the last reason and quantity when reopened (a second Save repeated the adjustment); it now
  starts empty. Each dialog has its own title id (they all shared `adjust-title`).
- The transfer form now shows specific messages for same branch, reused transfer number and unstockable items.
- A request that fails before the server answers no longer leaves a form's button disabled (`safeAction`).
- Success messages no longer say "1 items".

## Open risks (carried into T6)

- **Variant switch race. Closed in Phase 8 (R1, 2026-10-11)** with product-row locks in `insertVariant` and every
  stock write; see `phase-8/checkout-spec.md`. Original note: a sale that commits between `hasUnvariantedStock` and the variant switch can leave a
  variant-null row on a product that now has variants. Close it before checkout ships: lock the product row in
  `insertVariant` and have sales lock it too, or re-check inside the same serializable transaction. No code change in T4.
- **`allow` sales go negative by design (D4).** T6 must decide the org default and show oversold items clearly. The
  stock list already flags them.
- **Seam callers must lock.** `recordMovements` locks through `applyLines`; any new writer must go through it, never
  write `StockBalance` directly.

## Deferred minors

- The opening grid is limited to one page of 100 items per save. A branch with more unopened items saves in batches
  after search narrows the list.
- The transfer form has no keyboard shortcut for "add by scan" beyond Enter in the search box.
- The adjust dialog's sign select is hidden for reasons with a fixed direction (and always for archived items); the
  preview still shows the result.

## Verification (after the review fixes)

- Vitest: 496/496 across 39 files (includes 15 constraint tests, the seam, concurrency runs, transfer deadlock test,
  isolation matrix and unit tests).
- Concurrency: the oversell test was run five times in isolation; the crossing-transfer test three times.
- Playwright: 30/30 for the full suite (six of them are inventory tests: four access, one admin flow, one Arabic RTL).
- `next build`, lint, typecheck and `format:check` pass.
- Fresh-database migration applied on a throwaway database (created and dropped for the check).

## Not in T4 (Next)

Stock counts and count sessions, two-step transfers, reorder points, cost valuation, CSV import, the
`blockNegativeStock` settings UI, the POS "in stock" display (T6 uses `getOnHand`), and the sale, void, refund and
receipt movements (T5, T6, T8 call `recordMovements`).
