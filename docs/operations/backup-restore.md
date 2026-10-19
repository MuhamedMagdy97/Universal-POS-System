# Backup and restore (PostgreSQL 16)

All shop data lives in one PostgreSQL database (`DATABASE_URL`): tenants, users and sessions, catalog, the stock
ledger, sales, shifts, purchasing, audit rows and rate-limit counters. There are no uploaded files. A logical dump of
that one database is a complete backup.

## Backup

Use the custom format (`-Fc`): compressed, and `pg_restore` can list or pick from it. Use `pg_dump` from the same
major version as the server (16) or newer.

```bash
pg_dump -d "$DATABASE_URL_WITHOUT_SCHEMA_PARAM" -Fc --no-owner --no-privileges -f pos-$(date +%Y%m%d-%H%M).dump
```

- `pg_dump` does not accept Prisma's `?schema=public` parameter (`pg_dump: error: invalid URI query parameter:
  "schema"`): strip it, or pass `-h -p -U -d` separately.
- `--no-owner --no-privileges` lets the dump restore under a different role (managed hosts, another server).
- `pg_dump` takes a consistent snapshot; the app can stay online while it runs.
- Keep dumps off the database host, and encrypt them: they hold password hashes and session tokens.
- Managed hosts (Neon, Supabase, RDS) also keep their own point-in-time backups; a `pg_dump` is still the portable,
  host-independent copy.

With the local Docker container (tools inside the container, so versions match):

```bash
docker exec pos-postgres pg_dump -U postgres -d pos_dev -Fc --no-owner --no-privileges -f /tmp/pos_dev.dump
docker cp pos-postgres:/tmp/pos_dev.dump ./pos_dev.dump
```

## Restore

**Always restore into a new, empty database**, check it, then switch `DATABASE_URL` to it. Never restore over the
live database.

```bash
createdb -T template0 pos_restored
pg_restore -d pos_restored --no-owner --no-privileges --exit-on-error pos-20261019-0000.dump
DATABASE_URL="postgresql://…/pos_restored?schema=public" npx prisma migrate status
```

`migrate status` must say "Database schema is up to date!". If the dump came from an older release, run
`npm run db:deploy` against the restored database before starting the new release on it.

After switching, every user stays signed in (sessions are in the dump). Rate-limit counters are restored too: a
login refused with 429 right before the dump stays refused in the restored copy until the 60-second window passes.

## Drill (exercised 2026-10-19)

Run against scratch databases in the local `pos-postgres` container (PostgreSQL 16.15); `pos_dev`, `pos_test` and
`pos_e2e` were not touched. Source: `pos_relcheck`, freshly migrated and loaded with `npm run db:seed:dev`.

1. Dump:

   ```bash
   docker exec pos-postgres sh -c 'pg_dump -U postgres -d pos_relcheck -Fc --no-owner --no-privileges -f /tmp/pos_relcheck.dump && ls -l /tmp/pos_relcheck.dump'
   ```

   ```
   -rw-r--r-- 1 root root 126414 Oct 18 23:56 /tmp/pos_relcheck.dump
   ```

   ```bash
   docker exec pos-postgres pg_restore --list /tmp/pos_relcheck.dump
   ```

   ```
   ; Archive created at 2026-10-18 23:56:41 UTC
   ;     dbname: pos_relcheck
   ;     TOC Entries: 260
   ;     Compression: gzip
   ;     Format: CUSTOM
   ;     Dumped from database version: 16.15 (Debian 16.15-1.pgdg13+2)
   ;     Dumped by pg_dump version: 16.15 (Debian 16.15-1.pgdg13+2)
   ```

2. Restore into a new database:

   ```bash
   docker exec pos-postgres psql -U postgres -c "create database pos_restore_check;"
   docker exec pos-postgres pg_restore -U postgres -d pos_restore_check --no-owner --no-privileges --exit-on-error /tmp/pos_relcheck.dump
   ```

   ```
   CREATE DATABASE
   pg_restore exit 0
   ```

3. Compare row counts, source then restored:

   ```sql
   select (select count(*) from "Organization") orgs, (select count(*) from "User") users,
          (select count(*) from "Product") products, (select count(*) from "InventoryMovement") movements,
          (select count(*) from "_prisma_migrations") migrations;
   ```

   ```
   == pos_relcheck
    orgs | users | products | movements | migrations
   ------+-------+----------+-----------+------------
       2 |     6 |       66 |        67 |          8
   == pos_restore_check
    orgs | users | products | movements | migrations
   ------+-------+----------+-----------+------------
       2 |     6 |       66 |        67 |          8
   ```

4. Run the app on the restored copy: `prisma migrate status` → "Database schema is up to date!"; `next start` with
   `DATABASE_URL` pointing at `pos_restore_check` → `/api/health` 200 `{"status":"ok","db":"up",…}`; the seeded owner
   signs in (200) and `GET /api/products` returns the catalog (first item `E2E-AR-001` "Arabic Coffee"). The first
   sign-in attempts got 429: the restored rate-limit row from failed logins made just before the dump (see above).

5. Clean up: `drop database pos_restore_check; drop database pos_relcheck;` and the dump file removed from the
   container. Remaining databases: `pos_dev`, `pos_e2e`, `pos_test`, `postgres`, `template0`, `template1`.

## Not covered

No scheduled backups exist in this repo: choose the host's automated backups or a cron job running the `pg_dump`
above, and repeat the drill after each restore-procedure change. Point-in-time recovery (WAL archiving) is a hosting
concern and was not exercised.
