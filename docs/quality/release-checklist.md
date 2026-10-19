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
- [ ] Tenant/permission isolation reviewed.
  - Not done as a separate review. Automated coverage passes (`tests/integration/tenant-guard.test.ts`,
    `catalog-isolation`, `catalog-service-isolation`, `inventory-isolation`, E2E `catalog-isolation` and the access
    specs), but nobody has reviewed every route and Server Action against the permission matrix
    ([user-roles-permissions](../product/user-roles-permissions.md)). Needs a review pass.
- [ ] Financial + inventory invariants verified against known transactions.
  - Partly recorded: T9 traces every report to one seeded history and the stored shift close
    ([phase-status](../planning/phase-status.md), Phase 9); the ledger `reconcile()` is asserted after each inventory
    integration test file ([inventory-spec](../planning/phase-7/inventory-spec.md) §6). Not re-done against a fresh set
    of known transactions in this check.
- [ ] Failure recovery + backup/restore exercised.
  - Backup/restore: done, [drill](../operations/backup-restore.md#drill-exercised-2026-10-19) (dump, restore to a new
    database, matching row counts, app serving and signing in from it).
  - Failure recovery: only the database-down case was observed (health 503 `DB_UNAVAILABLE`, logged). Not exercised:
    a server restart mid-sale, retrying a sale after a lost response (idempotency is covered by tests only), a failed
    `migrate deploy` and `migrate resolve`.
- [ ] Logging/troubleshooting docs, user docs, deploy + rollback notes.
  - Done: [troubleshooting](../operations/troubleshooting.md) (logs, request ids, rate limits, common errors),
    [deploy and rollback](../operations/deploy-and-rollback.md).
  - Missing: user docs (how a cashier, manager or owner uses the screens). None exist yet.
- [x] Known limitations listed. No mock success paths.
  - Evidence: [known limitations](../product/known-limitations.md), collected from `docs/planning/**`. A search of
    `app/`, `lib/`, `modules/` for mock, fake, stub, TODO and placeholder finds no mocked success path; the only hit
    in app text is the "Coming soon" label on onboarding presets, which is by design ([mvp-scope](../product/mvp-scope.md)).
