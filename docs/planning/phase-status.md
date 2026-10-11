# Phase Status

## Completed (planning)
- Phase 0: repo empty, no stack, Node 18 noted.
- Phase 1: MVP scope + presets + EG/SA market locked (manual payments assumed).
- Phase 2: UX spec + screen inventory + scanner/keyboard + EN/AR rules.
- Phase 3: architecture + ADRs + repo shape + security sketch.
- Phase 4: entities, state machines, API sketch, permission matrix, T1–T10.

## Current
- Phase 5: foundation BUILT (2026-10-11): Node 22, Next.js 16 scaffold, Prisma schema + init migration on local PostgreSQL 16, Better-Auth DB sessions, tenant guard, health route. lint, tsc, vitest, next build, Playwright smoke green.
- Phase 6: catalog BUILT (2026-10-11) on `phase-6/catalog`: hardening migration, services + audit, cross-module seam,
  Route Handlers, back-office UI (EN/AR, RTL). E2E (T3.8) in progress. See
  [phase-6/catalog-spec.md](phase-6/catalog-spec.md) ("As built").

## Next
- Phase 7: inventory (T4) — ledger, stock balances; uses the catalog seam (`assertStockable`) and resolves the
  `TODO(T4)` in `createVariant`.

## Pending
Phases 8–14 per roadmap. No deviations accepted yet. No destructive changes made.
