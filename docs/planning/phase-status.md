# Phase Status

## Completed (planning)
- Phase 0: repo empty, no stack, Node 18 noted.
- Phase 1: MVP scope + presets + EG/SA market locked (manual payments assumed).
- Phase 2: UX spec + screen inventory + scanner/keyboard + EN/AR rules.
- Phase 3: architecture + ADRs + repo shape + security sketch.
- Phase 4: entities, state machines, API sketch, permission matrix, T1–T10.

## Current
- Phase 5: foundation BUILT (2026-10-11): Node 22, Next.js 16 scaffold, Prisma schema + init migration on local PostgreSQL 16, Better-Auth DB sessions, tenant guard, health route. lint, tsc, vitest, next build, Playwright smoke green.
- Phase 6: catalog BUILT and merged to `main` (PR #3, 2026-10-11): hardening migration, services + audit,
  cross-module seam, Route Handlers, back-office UI (EN/AR, RTL), E2E on a dedicated database. See
  [phase-6/catalog-spec.md](phase-6/catalog-spec.md) ("As built").

- Phase 7: inventory BUILT on `phase-7/inventory` (T4.1–T4.8, 2026-10-11): append-only ledger with balance cache,
  opening stock, adjustments with structured reasons, instant transfers, catalog guard (`PRODUCT_HAS_STOCK`), route
  handlers, back-office screens, E2E. See [phase-7/inventory-as-built.md](phase-7/inventory-as-built.md) for deviations
  and the open variant-switch race to close before checkout (T6).

## Next
- Phase 8: checkout / POS (T6) — spec approved; R1 variant-switch race closed; checkout backend built (sales create with
  idempotency, server-side totals and payments, stock through the seam, shift open) and the till screen `/pos` with E2E,
  on `phase-8/checkout`. See [phase-8/checkout-spec.md](phase-8/checkout-spec.md),
  [phase-8/checkout-data-model-and-api.md](phase-8/checkout-data-model-and-api.md) and
  [phase-8/checkout-ux-and-tests.md](phase-8/checkout-ux-and-tests.md). Split tenders on screen added 2026-10-19 (PR #19). Deferred: receipt print
  layout (T10); void/refund (T8). Shift close (T7) is built, below.

- Phase 8 / T7: shift close and cash count. Spec approved by the owner (2026-10-12):
  [phase-8/shift-close-spec.md](phase-8/shift-close-spec.md). BUILT on `phase-8/checkout` (2026-10-12): close and cash
  movement services and routes, shift row lock shared with sales, and the till close screen (expected cash before the
  count, note for a difference, summary). No migration. Deviations (state-based close replay, no `/api/shifts/current`)
  and the screen are in [phase-8/shift-close-data-model-and-api.md](phase-8/shift-close-data-model-and-api.md). The
  pay-in/pay-out/drop screen on `/pos` was added 2026-10-19 (§8 there); the shift list came with T9.

- Phase 8 / T8: returns, refunds and voids. Spec approved by the owner (2026-10-12):
  [phase-8/returns-void-spec.md](phase-8/returns-void-spec.md). BUILT on `phase-8/checkout`: partial refunds with
  remainder rounding, whole-sale voids on an open shift, cash refunds in the T7 expected-cash formula, one migration
  (`requestHash`, `reference` on `Refund`). Back-office Returns screen (`/returns`) for Owner and Manager; refunds pay out from a chosen till; Managers can work a till. Deviations (void replays by state, VAT share per line, voids refused after refunds, zero-total refunds refused) are in
  [phase-8/returns-void-data-model-and-api.md](phase-8/returns-void-data-model-and-api.md).

- Phase 9 / T9: reports and audit trail. Spec approved by the owner (2026-10-12), all decisions and the six design
  choices as recommended: [phase-9/reports-audit-spec.md](phase-9/reports-audit-spec.md). BUILT on `phase-9/reports`
  (2026-10-12): eight reports in the shop's timezone (Cairo or Riyadh) with CSV export, `/reports`, `/audit` (Owner and
  Admin), dashboard tiles for `reports.view`. No migration. Every report is traced to one seeded history and the
  stored shift close; 100 000 sales over a year answer in ≤ 300 ms per report. Deviations are in
  [data model and API](phase-9/reports-audit-data-model-and-api.md) and [screens and tests](phase-9/reports-audit-ux-and-tests.md).
  Not built at T9: profit and margin (built later as P12, PR #21), purchase reports (T5), a 0% VAT split into zero-rated and
  exempt (needs a VAT category snapshot).

- Phase 10 / T5: purchasing. Spec approved by the owner (2026-10-12; roles, last cost, receiving rules, edits and
  report as recommended, remaining choices as recommended): [phase-10/purchasing-spec.md](phase-10/purchasing-spec.md).
  BUILT on `phase-10/purchasing` (2026-10-12): suppliers, purchase orders (draft, ordered, partly received, received,
  cancelled, closed short), idempotent receiving that adds stock through the ledger and sets last cost through a new
  catalog seam in one transaction, `purchases.manage` (Owner, Admin) and `purchases.receive` (plus Manager), a
  Purchases received report, and the `/purchasing` screens in EN/AR. One migration (`purchasing`). Deviations are in
  [data model and API §7](phase-10/purchasing-data-model-and-api.md). Not built: purchase returns, supplier payments,
  input VAT, receiving without a PO, PO printing (T10).

- Phase 11 / T10: hardening slice. Spec approved by the owner (2026-10-13, every decision as recommended):
  [phase-11/hardening-spec.md](phase-11/hardening-spec.md). BUILT on `phase-11/hardening` (2026-10-13): 80 mm
  receipts for sales, refunds and voids with the shop details, reprints marked "Copy" and audited, receipt settings
  (`/settings/receipt`, Owner and Admin), Z-report print after close and from the Shifts report, A4 PO print,
  security headers with a static CSP, a per-user API rate limit in PostgreSQL (one migration, `api_rate_limit`), and
  Arabic E2E for returns, reports, audit, purchasing and settings. Deviations (no `@page` size, copy chosen by the
  screen, Route Handlers only) are in [phase-11/hardening-as-built.md](phase-11/hardening-as-built.md). Print check done by the owner
  (2026-10-13); the receipt page is now sized to the slip.

- T2 completion: shop onboarding, staff, branches and tills. Spec approved by the owner (2026-10-14, every decision as
  recommended): [onboarding/onboarding-spec.md](onboarding/onboarding-spec.md). BUILT on `t2/onboarding`
  (2026-10-14): self-serve shop setup from Welcome (one transaction, signs the owner in), Staff and Branches screens
  under Settings, My account password change, EN/AR. No migration. Deviations are in the spec, §6.

- 2026-10-19 backlog: cash in / out screen on `/pos` (PR #16), split tenders on the till (PR #19), Phase 14
  operations docs in `docs/operations/` and [known limitations](../product/known-limitations.md) (PR #18). Profit and
  margin (P12): spec approved by the owner (2026-10-19, every decision as recommended), BUILT (PR #21): cost snapshot
  on `SaleItem` (one migration), Profit by product, category and day with CSV for Owner and Admin.

- Phase 14 release readiness (2026-10-19): the open release-checklist items are done. Tenant and permission isolation
  review with one fix (receiving replay scope, PR #23), financial and inventory invariants on a known EG and SA day
  (PR #24), failure recovery drill (PR #25), user guides in [docs/user](../user/README.md) (PR #26), and the UI fixes
  they found: sign-in pages in Arabic, one Arabic word for a till, distinct Pay-in and Drop labels (PR #27). Every
  [release checklist](../quality/release-checklist.md) item is ticked; the remaining gap there is migrating a copy of
  a real shop's data before the first real upgrade.

- Phase 13 inventory integration (2026-10-19): spec approved by the owner (every decision as recommended),
  [inventory-integration/spec.md](inventory-integration/spec.md) with
  [data model and API](inventory-integration/data-model-and-api.md). Per-tenant toggle; the inventory system is
  master for catalog and stock; sales reserve before and fulfil after the POS transaction; sales blocked when it is
  unreachable. Slice 1 BUILT (PR #34): per-shop source toggle, Owner-only link settings with a sealed API key,
  product sync by external id, read-only guards; as built in
  [inventory-integration/integration-spec.md](inventory-integration/integration-spec.md). Next: slice 2 (sale
  posting, refunds, stock at the till).

- Phase 13 hardening (2026-10-19): 503 `DB_UNAVAILABLE` on every route and Server Action while the database is
  down, and Server Action failures logged (PR #33); nonce CSP (PR #32, [as built](phase-11/hardening-as-built.md));
  till exact-cash button, on-hand stock and keyboard shortcuts (PR #31); reorder points, low-stock list with CSV
  and dashboard tile (PR #30, [spec](low-stock/low-stock-spec.md)).

## Pending
Phases 12–13 per roadmap (industry module is evidence-gated; integrations). No deviations accepted yet beyond those recorded in the phase as-built notes. No destructive
changes made.
