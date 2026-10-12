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
  [phase-8/checkout-ux-and-tests.md](phase-8/checkout-ux-and-tests.md). Deferred: split tenders on screen, receipt print
  layout (T10); void/refund (T8). Shift close (T7) is built, below.

- Phase 8 / T7: shift close and cash count. Spec approved by the owner (2026-10-12):
  [phase-8/shift-close-spec.md](phase-8/shift-close-spec.md). BUILT on `phase-8/checkout` (2026-10-12): close and cash
  movement services and routes, shift row lock shared with sales, and the till close screen (expected cash before the
  count, note for a difference, summary). No migration. Deviations (state-based close replay, no `/api/shifts/current`)
  and the screen are in [phase-8/shift-close-data-model-and-api.md](phase-8/shift-close-data-model-and-api.md). Not
  built: pay-in/pay-out/drop screen (API only), shift list (T9).

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
  Not built: profit and margin (needs a cost snapshot, P12), purchase reports (T5), a 0% VAT split into zero-rated and
  exempt (needs a VAT category snapshot). T5 (purchase orders and receiving) comes next; `modules/purchasing` is a stub.

## Pending
Phases 9–14 per roadmap. No deviations accepted yet beyond those recorded in the phase as-built notes. No destructive
changes made.
