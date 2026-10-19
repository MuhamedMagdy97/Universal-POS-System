# Release Checklist (used at Phase 14)

Checked 2026-10-19 on `main` at `5d56f51` (after PR #16), Node 22.23.3, PostgreSQL 16.15. Ticked only where there is
evidence from this check or a linked record.

- [x] Clean install + env docs + migration on representative data.
  - Evidence: [install and env](../operations/install-and-env.md): `npm ci` with no `node_modules`, every env var the
    code reads, `db:deploy` of all 8 migrations on a new empty database, dev seed (2 shops, 6 users, 67 stock rows).
  - Gap: migrations were applied to an empty database and then seeded, not to a copy of a real shop's data. Repeat
    against a restored production-like dump before the first real upgrade.
- [x] lint + typecheck + full test suites green with real outputs.
  - Evidence (this check): `npm run lint` exit 0; `npm run typecheck` exit 0; `npm test` → `Test Files 65 passed | 1
skipped (66)`, `Tests 749 passed | 1 skipped (750)`; `npm run test:e2e` → `59 passed (1.7m)`. The skipped test is
    the opt-in 100 000-sale report timing test (`REPORTS_PERF`). CI runs all of them per PR
    ([ci.yml](../../.github/workflows/ci.yml)).
- [x] Production build verified (not just dev).
  - Evidence: `npm run build` then `npm start`; `/api/health` 200, security headers including HSTS, 401 envelope with
    the request id on a protected route, seeded owner sign-in and `GET /api/products` on a restored database
    ([deploy and rollback](../operations/deploy-and-rollback.md#health-check),
    [backup and restore](../operations/backup-restore.md#drill-exercised-2026-10-19)).
- [x] Tenant/permission isolation reviewed.
  - Evidence (2026-10-19, PR #23): [isolation review](isolation-review.md). Every Route Handler, Server Action, page
    context and branch-bound service checked against [user-roles-permissions](../product/user-roles-permissions.md).
    One gap fixed with a test: receiving replayed a stored receipt by Idempotency-Key before checking the PO's branch.
- [x] Financial + inventory invariants verified against known transactions.
  - Evidence (2026-10-19, PR #24): [invariants check](invariants-check.md). One fully known trading day for an EG and an
    SA shop through the real services; ledger reconcile, on-hand, shift expected cash and difference, sales, VAT,
    payments, profit and purchases reports all equal hand-worked figures. No bugs found.
- [x] Failure recovery + backup/restore exercised.
  - Backup/restore: done, [drill](../operations/backup-restore.md#drill-exercised-2026-10-19) (dump, restore to a new
    database, matching row counts, app serving and signing in from it).
  - Failure recovery (2026-10-19, PR #25): [failure recovery](../operations/failure-recovery.md). Exercised against a
    production build with `scripts/failure-drill.mjs`: retry after a lost response, server killed mid-burst (no
    half-written sale, no sale-number gaps, retries made once), database lost and back without a restart, failed
    `migrate deploy` recovered with `migrate resolve --rolled-back`. No bugs found.
- [x] Logging/troubleshooting docs, user docs, deploy + rollback notes.
  - Done: [troubleshooting](../operations/troubleshooting.md) (logs, request ids, rate limits, common errors),
    [deploy and rollback](../operations/deploy-and-rollback.md).
  - User docs (2026-10-19, PR #26): [user guide](../user/README.md) for cashier, manager and owner. Writing them found
    three UI bugs, fixed in PR #27 (sign-in pages always English, Arabic till wording, Pay-in and Drop both read
    "deposit").
- [x] Known limitations listed. No mock success paths.
  - Evidence: [known limitations](../product/known-limitations.md), collected from `docs/planning/**`. A search of
    `app/`, `lib/`, `modules/` for mock, fake, stub, TODO and placeholder finds no mocked success path; the only hit
    in app text is the "Coming soon" label on onboarding presets, which is by design ([mvp-scope](../product/mvp-scope.md)).
