# Technology Decisions (ADRs condensed)

1. **Next.js App Router + TypeScript** over SPA+API — one repo, server validation near UI. Requires Node 22 (approved; env currently Node 18 → must upgrade before scaffold).
2. **PostgreSQL + Prisma** over SQLite/Mongo — transactions, constraints, tenant-aware uniqueness. Hosting delegated to Claude Code; default: managed free tier (Neon/Supabase).
3. **Auth library with DB sessions (Auth.js / Better-Auth)** over hand-rolled — revocation, branch scoping, audit. Hashes argon2/bcrypt; rate-limited login; no custom crypto.
4. **Tenant isolation = app-enforced + DB constraints, RLS deferred** — orgId on every tenant table + service-layer checks + tests. RLS postponed (Prisma complexity).
5. **REST Route Handlers + Zod** over tRPC/GraphQL — uniform `{code,message,details}` errors, Idempotency-Key on sales, cursor pagination.
6. **Vercel-class + managed Postgres** over self-managed VPS/Docker — near-zero MVP ops; VPS path kept open via standard build + migrate.

## Phase 5 build record (2026-10-11)

7. **Runtime: Node.js 22.23.2 LTS** (upgraded from 18.17.0 via `winget install OpenJS.NodeJS.22`). Pinned in `.nvmrc`; `package.json` `engines` requires Node ≥ 22.12. npm 10.9.8.
8. **Postgres: local PostgreSQL 16.15 for development and tests** (the documented fallback). Installed with `winget install PostgreSQL.PostgreSQL.16` as a Windows service on `localhost:5432`, databases `pos_dev` and `pos_test`. Chosen because a Neon/Supabase project needs the owner's own account; the app only reads `DATABASE_URL`, so moving to managed Neon/Supabase (still the default for hosted environments, ADR 6) is a connection-string change plus `npm run db:deploy`. Requires PostgreSQL ≥ 15 (`NULLS NOT DISTINCT` index).
9. **Stack versions:** Next.js 16.4.0 (App Router, Turbopack, Cache Components on; `proxy.ts` replaces middleware), React 19.3, Prisma 7.10.0 with the `prisma-client` generator + `@prisma/adapter-pg` (config in `prisma.config.ts`), Zod 4, Vitest 5, Playwright 1.64, Tailwind 4. Prisma 8 is still a release candidate and was not used.
10. **Auth: Better-Auth 1.7.7** (ADR 3 option) with the Prisma adapter: DB sessions (12 h, revocable), argon2id hashing via `@node-rs/argon2` (OWASP parameters), database-backed rate limit of 5 sign-in attempts per 60 s. Auth.js was not chosen because its credentials provider cannot use database sessions.
11. **DB-enforced invariants (complements ADR 4):** composite `(orgId, id)` foreign keys so child rows cannot reference another tenant's data; CHECK constraints for non-negative integer money and positive quantities; triggers making `InventoryMovement`, `AuditEvent`, `SaleItem`, `Payment`, `Refund`, `RefundItem` append-only, `Sale` editable only for COMPLETED → VOIDED, and closed `RegisterShift` rows immutable; one OPEN shift per register (partial unique index).
12. **Git hooks: `simple-git-hooks`** (pre-commit: lint, typecheck, format check) instead of husky, for reliable Windows behaviour.
