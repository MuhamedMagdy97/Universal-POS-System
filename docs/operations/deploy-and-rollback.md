# Deploy and rollback

The app is one Next.js 16 server (`next start`) plus one PostgreSQL database. There is no deploy script or
infrastructure code in this repo; these steps are what any host (VM, container, Vercel-class platform) has to run.
Commands were run on 2026-10-19; see [install and env](install-and-env.md) for their output.

## Deploy

1. **Back up** the production database ([backup and restore](backup-restore.md)). Required before any release that
   adds a migration.
2. **Install and build** on the release commit, on Node 22:

   ```bash
   npm ci
   npm run build
   ```

   The build needs no database or secrets (config is read on first request).
3. **Check pending migrations**, and read their SQL. Some migrations come with a preflight query that must return
   zero rows per rule before they are applied (`scripts/preflight-inventory.sql`,
   `prisma/sql/catalog-hardening-preflight.sql`).

   ```bash
   npm run db:status
   ```

4. **Migrate**, then start the new release:

   ```bash
   npm run db:deploy
   npm start
   ```

   Run `db:deploy` once per release, from one machine, before the new code serves traffic. Migrations so far only add
   tables, columns, constraints and indexes, so the previous release keeps working on the migrated schema during the
   switch.
5. **Verify**: `/api/health` returns 200 (below), sign in, open `/pos`. CI runs the same sequence on every pull
   request (`npm ci`, format, lint, typecheck, `npm test`, `db:deploy`, `build`, Playwright E2E against `next start`;
   [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

Production needs `NODE_ENV=production` (set by `next start`), HTTPS in front (the app sends
`Strict-Transport-Security`), and `AUTH_URL` set to the public origin. Put the server behind a proxy that sets
`x-forwarded-for`: the onboarding rate limit keys on it.

## Health check

`GET /api/health` is public, never cached, and pings the database.

```
HTTP/1.1 200 OK
x-request-id: b9014999-67ed-424b-b35f-444d5df14a0a
cache-control: no-store
{"status":"ok","db":"up","dbLatencyMs":2,"time":"2026-10-18T23:56:01.957Z"}
```

Database unreachable (run with `DATABASE_URL` pointing at a closed port):

```
{"code":"DB_UNAVAILABLE","message":"Database is unavailable","details":null} HTTP 503
```

Use 200 as the readiness and liveness signal. A 503 also covers invalid configuration, because the ping reads the
config first; the server log says which (see [troubleshooting](troubleshooting.md#invalid-server-configuration)).

## Rollback

Migrations are **forward-only**: Prisma has no down migrations and none are written here. Roll back in this order:

1. **Code only (no migration in the release):** redeploy the previous build or commit. Nothing else.
2. **Release with a migration, previous code still compatible** (the usual case, since migrations are additive):
   redeploy the previous code and leave the schema as it is. Fix forward with a new migration later. Do not hand-edit
   the schema or delete rows from `_prisma_migrations`.
3. **Migration itself failed** (`migrate deploy` stops on the first failing migration and marks it failed): the
   database is left as the failed SQL left it. Read the error, fix the data or write a corrected migration, then
   either `npx prisma migrate resolve --rolled-back <migration>` (after undoing its partial changes by hand) or
   `--applied <migration>` (after finishing them), and run `db:deploy` again.
4. **Data damaged or schema unrecoverable:** stop the app, restore the pre-release backup into a new database, point
   `DATABASE_URL` at it and redeploy the previous code. Sales made since the backup are lost, so this is the last
   resort.

Not exercised: a real production deploy or rollback (there is no production environment yet), and `migrate resolve`.
