# Task Breakdown (dependency-ordered)

- T1 Auth + Membership (login, revoke, branch scoping). No deps.
- T2 Org/Branch/Register + EG/SA preset seed. Deps: T1.
- T3 Catalog CRUD + constraints. Deps: T2.
- T4 Ledger + balances + adjust/transfer. Deps: T3.
- T5 PO + receive → movements. Deps: T4.
- T6 Checkout E2E. Deps: T4.
- T7 Shifts + cash. Deps: T6.
- T8 Returns/refunds/void. Deps: T6.
- T9 Reports + audit. Deps: T6–T8.
- T10 Hardening slice (rate-limit, print CSS, EN/AR). Deps: T1–T9.

Each task: objective, scope, files, deps, acceptance, tests, risks (see Phase 4 report).
Claude Code owns T1–T3 first (Phase 5); catalog tasks (T3) unlock Phase 6.
