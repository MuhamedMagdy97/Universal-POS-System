# Phase 9 / T9 — Reports and Audit Trail: Task Plan

Branch `phase-9/reports`. Each task ends green on lint, typecheck and the tests it names, and is committed on its own.
Design: [reports-audit-data-model-and-api.md](reports-audit-data-model-and-api.md),
[reports-audit-ux-and-tests.md](reports-audit-ux-and-tests.md).

| # | Task | Done when |
|---|---|---|
| T9.1 | **Foundations.** `timezone.ts` (zone map, local-date parse, range rules, quick picks), `csv.ts`, `schemas.ts`, `access.ts` (permission + branch scope → branch ids, denial audit). | Unit tests for timezone and CSV pass. |
| T9.2 | **Seeded fixture.** An integration helper that seeds the day of §5 (sales of each method, split, refunds same and next day, void, cash movements, a closed short shift) in two branches and two orgs. | Fixture used by T9.3–T9.5. |
| T9.3 | **Money reports:** sales-summary, payments, cashiers, refunds-voids. | Each matches the fixture; the 23:30 Cairo/Riyadh day test passes. |
| T9.4 | **Line reports:** products, categories, VAT. | Match the fixture; VAT totals = Σ line VAT − refund VAT. |
| T9.5 | **Shifts report.** Export `cashBreakdown` from registers; reuse it. | Closed shift expected cash equals the stored value; open shift shows live expected. |
| T9.6 | **Route** `GET /api/reports/{report}` with JSON, CSV, row cap, export audit. | Route tests (401/403/404/422/200, CSV headers) and isolation tests pass. |
| T9.7 | **Audit trail** service and `GET /api/audit` (filters, cursor, CSV). | Audit-trail and cursor tests pass. |
| T9.8 | **`/reports` screen** with EN/AR strings, nav link. | E2E `reports.spec.ts` passes. |
| T9.9 | **`/audit` screen** with EN/AR strings, nav link. | E2E `audit.spec.ts` passes. |
| T9.10 | **Dashboard tiles.** | Tiles show today's numbers; Cashier keeps the greeting. |
| T9.11 | **Close-out.** R3 query plans on a seeded volume; as-built notes and deviations; `phase-status.md`. | Full gate green: lint, typecheck, vitest, `next build`, Playwright. |

Order: T9.1 → T9.2 → T9.3–T9.5 (any order) → T9.6 → T9.7 → T9.8–T9.10 → T9.11.
