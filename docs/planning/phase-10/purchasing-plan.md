# Phase 10 / T5 — Purchasing: Task Plan

Branch `phase-10/purchasing`. Each task ends green on lint, typecheck and the tests it names, and is committed on its
own. Design: [purchasing-data-model-and-api.md](purchasing-data-model-and-api.md),
[purchasing-ux-and-tests.md](purchasing-ux-and-tests.md).

| # | Task | Done when |
|---|---|---|
| T5.1 | **Migration and permissions.** Schema fields, the `purchasing` migration (constraints, triggers, indexes), `purchases.manage`, Manager gets `purchases.receive`. | Migrates cleanly; permission unit tests updated; constraint tests pass. |
| T5.2 | **Pure rules and schemas.** `rules.ts`, `schemas.ts`, `errors.ts`. | Unit tests pass. |
| T5.3 | **Suppliers service.** | Supplier integration tests pass. |
| T5.4 | **PO service:** create, edit, order, cancel, close, list, get. | PO integration tests pass. |
| T5.5 | **Receiving and the catalog cost seam.** | Receiving, idempotency, concurrency, cost and isolation tests pass; `reconcile()` clean. |
| T5.6 | **Routes.** | Route tests pass. |
| T5.7 | **Purchases report.** | Report test against seeded receipts passes. |
| T5.8 | **Screens:** nav link, list, detail/editor, receive, suppliers, EN/AR strings. | Pages render; lint and typecheck green. |
| T5.9 | **E2E and close-out:** `purchasing.spec.ts`; as-built notes; `phase-status.md`, roadmap. | Full gate green: lint, typecheck, vitest, `next build`, Playwright. |

Order: T5.1 → T5.2 → T5.3 → T5.4 → T5.5 → T5.6 → T5.7 → T5.8 → T5.9.

## Status (2026-10-12)

All of T5.1–T5.9 are built on `phase-10/purchasing`. Deviations are in
[purchasing-data-model-and-api.md §7](purchasing-data-model-and-api.md).
