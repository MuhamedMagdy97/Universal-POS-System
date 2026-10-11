# Security Model

- Server-side authz on every endpoint; hidden UI is not authorization.
- Tenant + branch checks in service layer; cross-tenant → 403/404 without leakage.
- Passwords hashed (argon2/bcrypt), rate-limited login, session revoke/expiry.
- Zod validation on all input; no raw card data stored (manual-record + provider boundary).
- Audit append-only; secrets never logged or committed (`.env.example` only).
- Dependency vulnerability review at hardening (Phase 13).
