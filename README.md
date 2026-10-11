# Universal POS System

Multi-tenant point of sale and back-office for retail shops in Egypt (EGP, 14% VAT) and Saudi Arabia (SAR, 15% VAT).
Modular monolith: Next.js App Router + TypeScript + PostgreSQL + Prisma. Product and architecture docs live in
[`docs/`](docs/).

Status: **Phase 6 (catalog)**. Auth, tenancy, schema, app shells and the product catalog (products, variants,
barcodes, categories; API + back-office UI) exist; inventory (Phase 7) is next (see
[`docs/planning/roadmap.md`](docs/planning/roadmap.md)).

## Prerequisites

- **Node.js 22 LTS** (22.12 or newer; `.nvmrc` pins 22.23.2). Check with `node -v`.
- **PostgreSQL 15+** (16 recommended). Either:
  - local: `winget install PostgreSQL.PostgreSQL.16` on Windows, or your OS package manager, or
  - managed: a free [Neon](https://neon.tech) or [Supabase](https://supabase.com) project.
- Git.

## Setup

```bash
git clone https://github.com/MuhamedMagdy97/Universal-POS-System.git
cd Universal-POS-System
npm install                 # also runs `prisma generate` and installs git hooks
cp .env.example .env        # then edit the values
```

Create two databases, one for development and one for tests (local example):

```bash
psql -U postgres -h localhost -c "create database pos_dev;" -c "create database pos_test;"
```

Fill in `.env`:

| Key                 | Purpose                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | Postgres connection string for the app (`pos_dev`)                                            |
| `TEST_DATABASE_URL` | Separate database for `npm test`; must differ from `DATABASE_URL`                             |
| `E2E_DATABASE_URL`  | Separate database for Playwright e2e; must differ from `DATABASE_URL` and `TEST_DATABASE_URL` |
| `AUTH_SECRET`       | 32+ random characters (command in `.env.example`)                                             |
| `AUTH_URL`          | Base URL of the app, e.g. `http://localhost:3000`                                             |

`.env` is git-ignored. Never commit secrets; only `.env.example` is tracked.

Apply migrations and start the app:

```bash
npm run db:migrate          # prisma migrate dev (development)
npm run dev                 # http://localhost:3000
```

Check it is alive: `GET http://localhost:3000/api/health` returns `{"status":"ok","db":"up",...}`.

## Scripts

| Command              | What it does                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`        | Next.js dev server                                                                                                    |
| `npm run build`      | Production build                                                                                                      |
| `npm start`          | Serve the production build                                                                                            |
| `npm run lint`       | ESLint (Next + typescript-eslint strict), zero warnings allowed                                                       |
| `npm run typecheck`  | `tsc --noEmit`                                                                                                        |
| `npm run format`     | Prettier write (`format:check` to verify)                                                                             |
| `npm test`           | Vitest: unit + integration tests (needs `TEST_DATABASE_URL`)                                                          |
| `npm run test:e2e`   | Playwright smoke tests against `npm start` (run `npm run build` first; first time: `npx playwright install chromium`) |
| `npm run db:migrate` | Create/apply migrations in development                                                                                |
| `npm run db:deploy`  | Apply migrations in production/CI                                                                                     |
| `npm run db:status`  | Migration status                                                                                                      |

The pre-commit hook runs lint, typecheck and the Prettier check.

## Layout

```
app/
  (public)/welcome, onboarding, login   public pages
  (app)/                                authenticated shell (org/branch context, EN/AR toggle)
  api/auth/[...all]                     Better-Auth endpoints (sign-in, sign-out, sessions)
  api/health                            liveness + DB ping
lib/
  config.ts   Zod-validated env          db.ts      Prisma client (pg adapter)
  money.ts    integer minor-unit math     errors.ts  {code,message,details} envelope
  logger.ts   structured JSON, redacts secrets
  http.ts     route wrapper (request id, error mapping, Zod body parsing)
  auth/       Better-Auth config, password hashing, sessions, permissions, tenant guard
modules/      auth, org, catalog, inventory, sales, payments, registers, purchasing, reports, audit, presets
prisma/       schema.prisma + migrations (init migration adds triggers and CHECK constraints)
proxy.ts      deny-by-default session gate (Next.js 16 "proxy", formerly middleware)
tests/        unit/, integration/ (real Postgres), e2e/ (Playwright)
```

## Catalog

Spec, data model, API rules, UX and task plan: [`docs/planning/phase-6/`](docs/planning/phase-6/) (start with
`catalog-spec.md`). Endpoints as built: [`docs/architecture/api-contracts.md`](docs/architecture/api-contracts.md).

## Rules that every change must keep

- Money is integer minor units (`lib/money.ts`); no floats in finance.
- `orgId` comes from the server-side session (`lib/auth/tenant.ts`), never from the client. Cross-tenant access answers
  404/403 without revealing data.
- All input is validated with Zod; errors use the `{ code, message, details }` envelope.
- Inventory ledger and audit log are append-only (enforced by database triggers).
- Never weaken a test or a constraint to make a build pass. No secrets in the repo or in logs.
