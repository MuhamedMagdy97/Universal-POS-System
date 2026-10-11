# Testing Strategy

- Unit (Vitest): money, VAT, ledger reconcile, permission gates.
- Integration: route + Prisma transactions with rollback; concurrent-stock test.
- Auth/isolation matrix on every tenant-scoped endpoint.
- E2E (Playwright): J1–J4 journeys, double-submit, scanner flow.
- Regression + failure-path (partial failure recovery documented per workflow).
- Rule: never weaken a test or security constraint to make the build pass.
