# Phase 7 / T4 — Inventory Task Plan

Status (2026-10-11): **plan written, awaiting owner approval of the plan and an execution method.**

Source spec: [inventory-spec.md](inventory-spec.md) (data model, API/rules, UX/tests parts linked from it).
Branch: `phase-7/inventory`. Each task ends with `npm run lint`, `npm run typecheck`, the relevant tests green, and
one commit. Catalog's pattern is followed throughout: `modules/inventory/*` services take a `TenantContext`, check the
permission inside the service (audit-logged denials), validate with zod, and write audit rows in the same transaction.

## Global constraints

- Quantities are integers. `qty` on any stock row or movement is an `Int`; the upper bound for any line is `1_000_000`.
- Stock is changed only through `modules/inventory` (`applyLines`). No other module writes `StockBalance` or
  `InventoryMovement`.
- Every write locks balance rows in the order `(branchId, productId, variantId NULLS FIRST)`.
- Negative stock: adjustments and transfers out always block; sales follow the `policy` argument; refunds, voids and
  receipts never check.
- Errors use the shared `ErrorCode` set; the cause goes in `details.reason`.
- Cost is never returned by any inventory response.
- Arabic-Indic digits are accepted in quantity inputs (`normalizeDigits` from `lib/money.ts`).

## Review Focus

Inputs and conditions most likely to bite a real user, most likely first. Each is pinned by a test in the owning task.

1. **Oversell under concurrency.** Two cashiers (or a sale and a transfer) take the last unit at once → exactly one
   succeeds. *T4.3 `inventory-seam.test.ts`* (I-3).
2. **Double-submit.** A slow network makes the user press Save twice → the opening grid, adjustment and transfer each
   apply once. *T4.4 tests* (I-5, I-7, I-12).
3. **Stale count.** Someone sells an item while another person is counting it → the count doesn't silently overwrite the
   sale. *T4.4 `inventory-adjust.test.ts`* (I-12).
4. **Duplicate item in one transfer or opening grid** (scanned twice) → rejected cleanly, or merged in the UI. *T4.2 zod*
   and *T4.4 transfer test* (`DUPLICATE_LINE`).
5. **Archived item still holding stock** (product archived with 5 on hand) → visible, adjustable out, not silently lost.
   *T4.3 seam test* and *T4.4 `inventory-queries.test.ts`* (I-13).
6. **Arabic-Indic digits and an empty quantity box** in the adjust or grid inputs → parsed, or rejected with a clear
   message. *T4.2 `inventory-validation.test.ts`* and *T4.7 form-helper tests* (I-20).

## Task list

Dependency graph:

```
T4.1 schema ──► T4.3 ledger core ──┬─► T4.4 services ──► T4.6 routes ──┐
T4.2 cross-cutting ────────────────┘                  │                ├─► T4.8 e2e ─► T4.9 docs
                                                      └─► T4.5 catalog guard
                                              T4.7 UI (after T4.4, T4.2) ┘
```

Serial bottleneck: **T4.3**. Keep it in one agent. T4.5 and T4.6 are independent of each other after T4.4.

---

### T4.1 — Schema migration and constraint tests

**Files**
- Modify: `prisma/schema.prisma` (enum `AdjustmentReason`; `InventoryMovement.adjustmentReason`; `StockBalance` `@@index([orgId, branchId])`)
- Create: `prisma/migrations/<ts>_inventory/migration.sql` (data-model §3 SQL, verbatim)
- Create: `scripts/preflight-inventory.sql` (data-model §4)
- Create: `tests/integration/inventory-constraints.test.ts`

**Interfaces**
- Consumes: init + catalog hardening migrations.
- Produces: generated Prisma type `AdjustmentReason` (`"DAMAGED" | "EXPIRED" | "LOST_OR_STOLEN" | "COUNT_CORRECTION" | "FOUND" | "OTHER"`) and `InventoryMovement.adjustmentReason`.

**Steps**
1. Write the failing constraint tests, one per CHECK/index, plus a cross-tenant FK insert on `StockBalance` and `InventoryMovement`. Each test inserts a raw row and expects a Prisma/Postgres error naming the constraint.
2. Run `npx vitest run tests/integration/inventory-constraints.test.ts`. Expected: FAIL (constraints missing).
3. `npx prisma migrate dev --create-only --name inventory`, then replace the generated SQL with data-model §3.
4. Run the preflight script against `pos_dev`; expected output: zero rows.
5. `npm run db:deploy` against `pos_test` and `pos_dev`; then `npm run db:status` reports up to date.
6. Re-run the constraint tests. Expected: PASS.

**Done when:** migration applies on fresh and existing DBs; constraint tests green; `npm run db:generate` produces the enum.

**Commit:** `Add inventory migration with ledger direction and opening-balance constraints`

---

### T4.2 — Cross-cutting: permission, zod schemas, i18n, nav link

**Files**
- Modify: `lib/auth/permissions.ts` (add `"inventory.read"` to `PERMISSIONS`; grant to OWNER (automatic), ADMIN, MANAGER, REPORTING via `INVENTORY_READ`)
- Modify: `tests/unit/permissions.test.ts`
- Create: `modules/inventory/schemas.ts`
- Create: `tests/unit/inventory-validation.test.ts`
- Modify: `lib/i18n/messages/en.ts`, `lib/i18n/messages/ar.ts` (keys `inventory.*`; no English strings in components)
- Create: `app/(app)/_components/inventory-nav-link.tsx` (copy of `catalog-nav-link.tsx` with `inventory.read`)
- Modify: `app/(app)/layout.tsx` (render the link next to `CatalogNavLink`)
- Modify: `docs/product/user-roles-permissions.md` (inventory.read row)

**Interfaces**
- Produces (in `modules/inventory/schemas.ts`):
  - `ItemRef = { productId: string; variantId: string | null }` (zod `ItemRefInput`; `variantId` optional, `null` when absent)
  - `Qty = z.number().int().min(1).max(1_000_000)`
  - `AdjustmentReasonValue` (the six values)
  - `OpeningInput = { branchId, lines: { ref, qty }[1..500] }`
  - `AdjustInput = { branchId, ref, adjustmentReason, note?, qtyDelta?, countedQty?, expectedOnHand }`
    (refine: exactly one of `qtyDelta` / `countedQty`; `countedQty` only with `COUNT_CORRECTION`; `qtyDelta` non-zero)
  - `TransferInput = { transferId (uuid), fromBranchId, toBranchId, lines[1..200], note? }`
  - `StockQuery`, `LedgerQuery` (filter enum `all | inStock | zero | negative`, cursor, `limit` 1–100 default 25)
- Also exported: `normalizeQty(input: string): number` used by the UI forms (wraps `normalizeDigits`).

**Steps**
1. Write `inventory-validation.test.ts`: each rule above as a case (valid and invalid), duplicate-line rejection is **not** here (needs refs only: add `assertNoDuplicateRefs(refs)` and test it here, throws `VALIDATION_FAILED` `DUPLICATE_LINE`), `normalizeQty("٣٥")` → 35, `""` → invalid.
2. Run it: FAIL.
3. Implement `schemas.ts`, `assertNoDuplicateRefs`, `normalizeQty`.
4. Add permission and matrix assertions to `permissions.test.ts`: `inventory.read` granted to OWNER, ADMIN, MANAGER, REPORTING; denied to CASHIER.
5. Add i18n keys (en + ar, same key set; the existing i18n test enforces parity). Nav link + layout.
6. Run `npx vitest run tests/unit` and `npm run lint && npm run typecheck`. Expected: PASS.

**Done when:** unit tests green; i18n parity test green; nav link hidden for Cashier.

**Commit:** `Add inventory.read permission, input schemas and nav link`

---

### T4.3 — Ledger core and seam (serial bottleneck)

**Files**
- Create: `modules/inventory/locking.ts` — `lockBalances(tx, orgId, lines: { branchId; ref }[]): Promise<LockedRow[]>`
  - Sorts by `(branchId, productId, variantId NULLS FIRST)`, then per row: `INSERT … ON CONFLICT DO NOTHING`, then
    `SELECT id, qty FROM "StockBalance" … FOR UPDATE`. Returns rows in sorted order.
- Create: `modules/inventory/ledger.ts` — `applyLines(tx, ctx, input)`: the single write path (spec api §2 steps 1–5).
  - Input: `{ branchId; reason: MovementReason; adjustmentReason?: AdjustmentReason | null; refType?: string | null;
    refId?: string | null; transferGroupId?: string | null; note?: string | null; policy: "block" | "allow";
    lines: { ref: ItemRef; qty: number }[] }` (`qty` signed: + or −).
  - Calls `assertStockable` for every reason except `SALE_VOID` and `REFUND`.
  - Throws `INSUFFICIENT_STOCK` `details.lines` for every failing line when `policy === "block"` and `qty + delta < 0`.
  - Returns `{ ref; qty }[]` balances after, in input order.
- Create: `modules/inventory/queries.ts` — `hasUnvariantedStock(client, orgId, productId)`, `getOnHand(client, orgId, branchId, refs)`.
  **Must not import from `modules/catalog`** (spec §4). Only `ledger.ts` imports `assertStockable` from `@/modules/catalog`.
- Create: `modules/inventory/reconcile.ts` — `reconcile(client, orgId, branchId?)` → `{branchId; ref; cached; ledger}[]`
  (LEFT JOIN of `SUM(qtyDelta)` against `StockBalance.qty`; mismatches only).
- Create: `modules/inventory/index.ts` — seam exports: `recordMovements`, `getOnHand`, `hasUnvariantedStock`, `reconcile`
  (plus the back-office services added in T4.4).
  - `recordMovements(tx, ctx, { branchId, reason: "SALE" | "SALE_VOID" | "REFUND" | "PURCHASE_RECEIPT", refType, refId, lines, policy })`
    → `applyLines` with `policy`; sign derived from reason (SALE negative; others positive; the DB `reason_direction` CHECK backs this).
- Create: `tests/unit/inventory-ledger-order.test.ts` — lock-order sort helper.
- Create: `tests/integration/inventory-seam.test.ts`
- Modify: `tests/integration/helpers.ts` — add `expectReconciled(db, orgId)` helper; call it in `afterAll` of every inventory integration file (I-1).

**Interfaces**
- Consumes: `assertStockable(client, orgId, ref)` from `@/modules/catalog` (T3.5, unchanged); `ItemRef` from T4.2 schemas.
- Produces: `recordMovements`, `getOnHand`, `hasUnvariantedStock`, `reconcile`, `applyLines` (internal to `modules/inventory`, used by T4.4).

**Steps**
1. Write `inventory-seam.test.ts` covering I-1 (one row + balance + reconcile clean after a SALE), I-3 (two parallel
   `recordMovements(SALE, policy:"block")` on one unit: exactly one fulfils, the other rejects `INSUFFICIENT_STOCK`,
   final qty 0), I-4 (`policy:"allow"` ends at −1, `reconcile` clean), I-13 refund/void on archived item succeeds and
   a SALE on archived item rejects `ITEM_NOT_SELLABLE`, I-14 variant-required, I-16 UPDATE/DELETE on a movement row
   raises (regression), I-19 `getOnHand` input order and zero for missing rows.
2. Run: FAIL (modules not implemented).
3. Implement `locking.ts`, `queries.ts`, `ledger.ts`, `reconcile.ts`, `index.ts` in that order.
4. Run the seam tests and the ledger-order unit test: PASS. Run them 5× in a loop to check I-3 is not flaky.

**Done when:** I-1, I-3, I-4, I-13, I-14, I-16, I-19 green; `reconcile` clean after each file.

**Commit:** `Add inventory ledger core, locking and tx-aware seam`

---

### T4.4 — Back-office services

**Files**
- Create: `modules/inventory/opening.ts` — `recordOpeningBalances(ctx, input, meta?)`
- Create: `modules/inventory/adjust.ts` — `adjustStock(ctx, input, meta?)`
- Create: `modules/inventory/transfer.ts` — `transferStock(ctx, input, meta?)`
- Create: `modules/inventory/stock.ts` — `listStock(ctx, query)`, `getItemLedger(ctx, query)`
- Modify: `modules/inventory/index.ts` — export the five services and their input/result types
- Create: `tests/integration/inventory-opening.test.ts` (I-5, I-13 opening-on-archived, I-14)
- Create: `tests/integration/inventory-adjust.test.ts` (I-2, I-6, I-11, I-12)
- Create: `tests/integration/inventory-transfer.test.ts` (I-7, I-8, I-15, source-branch scope D6)
- Create: `tests/integration/inventory-queries.test.ts` (listStock filters, search by name/SKU/barcode, cursor; getItemLedger running balance I-17; I-18 cost never returned)

**Interfaces**
- Consumes: `applyLines`, `lockBalances`, `reconcile` (T4.3); schemas (T4.2); `requireTenant`-shaped `TenantContext`;
  `record` from `@/modules/audit` (`action: "inventory.<…>"`, `entityType: "StockBalance" | "InventoryMovement"`).
- Produces: `recordOpeningBalances`, `adjustStock`, `transferStock`, `listStock`, `getItemLedger` (exact input/output types in the spec API part §3).

**Steps**
1. Write the four test files, one case per acceptance ID. Each file's `afterAll` calls `expectReconciled`.
2. Run: FAIL.
3. Implement, in this order: `opening.ts` → `adjust.ts` → `transfer.ts` → `stock.ts`. Each service: `requirePermission` with the
   denial audit (`inventory.permission.denied`), zod parse, `requireBranch` (404 when outside scope or inactive), then
   `db.$transaction`.
4. Transfer idempotency: pre-check for existing movements with the same `transferGroupId` in the org; on P2002 re-read and
   return the replay (200 shape). Mismatched content ⇒ `IDEMPOTENCY_CONFLICT`.
5. Run the four files plus `npm test`: PASS.

**Done when:** I-2, I-5, I-6, I-7, I-8, I-9 (service side), I-11, I-12, I-13, I-15, I-17, I-18 green.

**Commit:** `Add inventory opening, adjustment, transfer and query services`

---

### T4.5 — Catalog guard for switching to variants

**Files**
- Modify: `modules/catalog/variants.ts` — replace the `TODO(T4)` block in `insertVariant`: when `!product.hasVariants`,
  `if (await hasUnvariantedStock(tx, ctx.orgId, product.id)) throw conflict("PRODUCT_HAS_STOCK");`
  - Import from `@/modules/inventory/queries` (the file that imports nothing from catalog; spec §4).
- Modify: `modules/catalog/errors.ts` — add `"PRODUCT_HAS_STOCK"` to `CatalogConflictReason` and its message
  ("This product already has stock recorded without variants").
- Create: `tests/integration/catalog-inventory-guard.test.ts` (I-10)

**Interfaces**
- Consumes: `hasUnvariantedStock(client, orgId, productId): Promise<boolean>` (T4.3).

**Steps**
1. Write the failing test: product with `StockBalance` (variantId NULL, qty 3) → `createVariant` rejects 409
   `PRODUCT_HAS_STOCK`; no variant row created; `hasVariants` stays false. Also: a product whose only `variantId IS NULL`
   movement nets to qty 0 is still blocked, because `hasUnvariantedStock` counts any such movement (spec §5). Test both.
2. Run: FAIL. 3. Implement. 4. Run `catalog-*` integration tests (regression) and the new file: PASS.

**Done when:** I-10 green; no existing catalog test changed.

**Commit:** `Block switching a product to variants while unvariant stock exists`

---

### T4.6 — Route Handlers

**Files**
- Create: `app/api/inventory/stock/route.ts` (GET), `app/api/inventory/ledger/route.ts` (GET),
  `app/api/inventory/opening/route.ts` (POST, 201), `app/api/inventory/adjust/route.ts` (POST, 201),
  `app/api/inventory/transfer/route.ts` (POST: 201 on first apply, 200 on replay)
- Create: `tests/integration/inventory-isolation.test.ts` (I-9, I-18 on responses)

**Interfaces**
- Consumes: service functions from `@/modules/inventory`; `apiRoute`, `json`, `bodyFor`, `queryOf`, `validInput` from `app/api/_lib/route.ts`.

**Steps**
1. Write the isolation matrix test: 401 (no session), 403 (Cashier on every route; non-permission write answers 403 whatever
   body is sent, with a denial audit row), 404 (branch in another org; branch outside membership; forged `orgId` in body
   ignored), no `costMinor` key anywhere in responses, `cache-control: no-store` on all.
2. Run: FAIL. 3. Implement each route as a thin `apiRoute` wrapper (writes: no `permission` option, per the catalog rule).
   Transfer route inspects whether the service returned `replayed: true` to choose 200 vs 201.
4. Run the isolation file: PASS.

**Done when:** I-9 green at route level; the route's status codes match the spec table.

**Commit:** `Add inventory route handlers and isolation tests`

---

### T4.7 — Back-office UI

**Files**
- Create: `app/(app)/inventory/page.tsx` (stock list), `app/(app)/inventory/error.tsx`
- Create: `app/(app)/inventory/items/[productId]/page.tsx` (history)
- Create: `app/(app)/inventory/transfer/page.tsx`, `app/(app)/inventory/opening/page.tsx`
- Create: `app/(app)/inventory/actions.ts` (Server Actions: thin adapters, re-run `requireTenant`, same zod schemas)
- Create: `app/(app)/inventory/_components/` — `branch-picker.tsx`, `stock-table.tsx`, `stock-filters.tsx`,
  `adjust-dialog.tsx`, `transfer-form.tsx`, `opening-grid.tsx`, `ledger-table.tsx`
- Create: `app/(app)/inventory/_lib/` — `adjust-form.ts` (pure: `expectedSign(reason)`, `previewAfter(onHand, delta)`,
  `unsavedGuard`), `transfer-lines.ts` (pure: `addScanned(lines, ref)` increments an existing line)
- Create: `tests/unit/inventory-form-helpers.test.ts` (covers I-20 digit entry via `normalizeQty`, sign rules, merging scanned lines)

**Interfaces**
- Consumes: services (T4.4), `GET /api/catalog/search` (existing), `normalizeQty` (T4.2), i18n keys (T4.2).

**Steps**
1. Write `inventory-form-helpers.test.ts` (pure functions only). Run: FAIL. 2. Implement `_lib`. Run: PASS.
3. Build pages and components per UX part §2 (stock list, history, adjust dialog, transfer, opening grid), with the
   loading / empty / no-results / error / 403 / 404 states and `dir="ltr"` on SKU, barcode and quantity fields.
4. Manual check in the browser on `localhost` (`npm run dev`, seeded DB): opening → adjust → transfer → history in EN and AR.
   Report what was checked; do not claim a pass for anything not run.

**Done when:** pure helper tests green; lint, typecheck and `npm run build` clean; manual walkthrough recorded in the PR description.

**Commit:** `Add inventory back-office screens`

---

### T4.8 — E2E

**Files**
- Modify: `prisma/seed-e2e.ts` — a Manager scoped to one branch and an e2e Cashier, if not already present; a product with
  no stock at branch B for the opening grid.
- Create: `tests/e2e/inventory-admin.spec.ts`, `tests/e2e/inventory-access.spec.ts`, `tests/e2e/inventory-rtl.spec.ts`

**Steps**
1. Write the three specs against the criteria in UX part §3 (I-9 UI, I-12 dialog reconfirm, I-20 RTL/LTR).
2. `npm run test:e2e` against `E2E_DATABASE_URL`. Expected: all green. Record the output.

**Done when:** three specs green on a fresh E2E database, twice in a row.

**Commit:** `Add inventory E2E specs`

---

### T4.9 — Docs

**Files**
- Modify: `docs/architecture/api-contracts.md` (inventory routes, error reasons), `docs/architecture/database-design.md`
  (inventory section, replaces "Full spec" pointer for T4), `docs/planning/phase-status.md`, `docs/planning/roadmap.md`
  (mark 7 done, 8 next), `README.md` only if a new env variable was introduced (none expected).
- Create: `docs/planning/phase-7/inventory-as-built.md` — deviations from the spec, if any (same role as catalog-spec's "As built").

**Done when:** docs match the code; `npm run format:check` clean.

**Commit:** `Document inventory as built and update phase status`

---

## Parallelism summary

- After approval: **T4.1 ∥ T4.2** (two agents).
- Then **T4.3** alone.
- After T4.3: **T4.4**.
- After T4.4: **T4.5 ∥ T4.6 ∥ T4.7** (three agents, separate worktrees).
- Then **T4.8**, then **T4.9**.
