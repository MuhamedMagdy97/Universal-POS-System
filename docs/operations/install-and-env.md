# Install and environment

Clean install on Node 22, verified on 2026-10-19 against a fresh checkout (no `node_modules`) and a new, empty
PostgreSQL 16.15 database (`pos_relcheck`, dropped afterwards). Every command below was run; outputs are trimmed.

## Prerequisites

- **Node.js 22.12+** (`.nvmrc` pins 22.23.2; `package.json` `engines` allows `>=22.12 <23 || >=24`). The check ran
  on Node 22.23.3 (`npx -p node@22 -- …` on a machine whose default Node is 24).
- **PostgreSQL 16** (15+ works; CI uses the `postgres:16` image). Local dev on this project uses the Docker
  container `pos-postgres` (`postgres:16`, port 5432).
- npm 10 for anything that rewrites `package-lock.json`. `npm ci` itself is fine on npm 11.

## 1. Install

```bash
npm ci
```

```
> universal-pos-system@0.1.0 postinstall
> prisma generate
✔ Generated Prisma Client (7.10.0) to .\lib\generated\prisma in 319ms
> universal-pos-system@0.1.0 prepare
> simple-git-hooks
added 543 packages, and audited 544 packages in 3m
found 0 vulnerabilities
```

`postinstall` generates the Prisma client into `lib/generated/prisma` (git-ignored); `prepare` installs the pre-commit
hook (lint, typecheck, Prettier check).

## 2. Environment variables

Copy `.env.example` to `.env` (git-ignored). The app and tooling read exactly these keys; found by grepping
`process.env` and the Zod schema in [`lib/config.ts`](../../lib/config.ts).

| Key                 | Read by                                                                        | Required                    | Rule                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | app (`lib/config.ts`), Prisma CLI (`prisma.config.ts`), `npm run db:seed:dev`  | yes                         | must start with `postgres://` or `postgresql://`                                                                             |
| `AUTH_SECRET`       | app (Better-Auth, `lib/auth/auth.ts`)                                          | yes                         | at least 32 characters. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`           |
| `AUTH_URL`          | app (Better-Auth `baseURL`)                                                    | yes in practice             | a URL. Optional in the schema, but sign-in from a browser origin that does not match it is refused with 403                 |
| `NODE_ENV`          | app (`lib/config.ts`), `next.config.ts`                                        | set by Next                 | `development` / `test` / `production`. `production` (set by `next build` / `next start`) adds `Strict-Transport-Security` |
| `TEST_DATABASE_URL` | `npm test` (`tests/setup/*`)                                                   | for tests                   | must differ from `DATABASE_URL`; the test setup runs `prisma migrate deploy` on it                                          |
| `E2E_DATABASE_URL`  | `npm run test:e2e` (`tests/e2e/support/env.ts`)                                | for E2E                     | must differ (host, port and database) from `DATABASE_URL` and `TEST_DATABASE_URL`                                           |
| `E2E_PORT`          | `npm run test:e2e`                                                             | no                          | port for the E2E app server, default `3100`                                                                                  |
| `CI`                | `playwright.config.ts`                                                         | no                          | when set: `forbidOnly`, 2 retries                                                                                            |
| `PORT`              | `next start`                                                                   | no                          | listen port, default 3000 (or pass `-- --port N`)                                                                            |
| `REPORTS_PERF`      | `tests/integration/reports-perf.test.ts`                                       | no                          | opt-in 100 000-sale report timing test; `REPORTS_PERF_OUT` writes its results to a file                                      |

Config is validated lazily on first use, not at build time, so `next build` needs no database. A bad value shows up
on the first request; see [troubleshooting](troubleshooting.md#invalid-server-configuration). Variables already set in
the process environment win over `.env` (both for Next and Prisma's `dotenv/config`).

## 3. Database

Create one database per purpose. With the local Docker container:

```bash
docker exec pos-postgres psql -U postgres -c "create database pos_dev;"
```

Production and CI apply migrations with `migrate deploy` (never `migrate dev`, which can reset data):

```bash
npm run db:deploy
```

```
8 migrations found in prisma/migrations
…
  └─ 20261011110422_init/
    └─ migration.sql
  …
  └─ 20261013170016_api_rate_limit/
    └─ migration.sql

All migrations have been successfully applied.
```

```bash
npm run db:status
```

```
8 migrations found in prisma/migrations
Database schema is up to date!
```

Developers creating a new migration use `npm run db:migrate` (`prisma migrate dev`). Several migrations carry
hand-written SQL (CHECKs, partial unique indexes) that the Prisma schema cannot express, so create new ones with
`npx prisma migrate dev --create-only` and remove any generated statement that drops them before applying.

## 4. Seeds

| Seed | Command                                           | Target                         | Contents                                                                                           |
| ---- | ------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Dev  | `npm run db:seed:dev`                             | `DATABASE_URL`                 | the E2E shops plus a till per shop and opening stock of 100 per active item. Idempotent            |
| E2E  | none; run by Playwright's global setup (`seedE2E`) | `E2E_DATABASE_URL`             | two orgs (Egypt, Saudi), six users (one per role), fixture products. Migrates first               |

The dev seed refuses a database that is not on `localhost` / `127.0.0.1` / `::1`, or that is the same as
`TEST_DATABASE_URL` or `E2E_DATABASE_URL`. Real run:

```
E2E Org A (Egypt): till ready, opening stock added for 61 item(s).
E2E Org B (Saudi): till ready, opening stock added for 6 item(s).
Logins (passwords in prisma/seed-e2e.ts, E2E_USERS):
  OWNER     owner@org-a.e2e.test
  …
```

The seeded passwords are throwaway test values. **Never seed a production database**; a real shop is created from
Welcome → shop setup (`/onboarding`).

## 5. Build and start

```bash
npm run build
```

```
▲ Next.js 16.4.0 (Turbopack)
- Environments: .env
- Cache Components enabled
✓ Compiled successfully in 10.6s
…
ƒ Proxy (Middleware)
```

```bash
npm start -- --port 3200
```

```
▲ Next.js 16.4.0
- Local:         http://localhost:3200
✓ Ready in 327ms
```

Check it (see [deploy and rollback](deploy-and-rollback.md#health-check)):

```bash
curl -s http://localhost:3200/api/health
```

```
{"status":"ok","db":"up","dbLatencyMs":2,"time":"2026-10-18T23:56:01.957Z"}
```
