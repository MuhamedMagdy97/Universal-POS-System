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
  layout (T10); shift close (T7); void/refund (T8).

## Pending
Phases 9–14 per roadmap. No deviations accepted yet beyond those recorded in the phase as-built notes. No destructive
changes made.
