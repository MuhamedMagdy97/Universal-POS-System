# Failure recovery

What happens to sales and the database when a response is lost, the server dies mid-sale, the database goes away,
or a migration fails, and what the operator does about it. Backup and restore is in
[backup-restore.md](backup-restore.md); release rollback is in [deploy-and-rollback.md](deploy-and-rollback.md).

## Runbook

| Symptom                                                         | Do                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Till shows an error after "Pay", cashier unsure the sale went   | Press Pay again **without changing the cart**. The till keeps the cart's `Idempotency-Key` after a dropped connection, a 500 or a 503, so the retry returns the existing sale or makes it once.      |
| API client got no response / a 5xx for `POST /api/sales`        | Send the same body with the same `Idempotency-Key`. `201` = made now, `200` = it already existed (same body as the first answer). Never send a new key for a sale whose outcome is unknown.           |
| `409 IDEMPOTENCY_CONFLICT`                                      | The key was used for a different cart. Nothing was written by this request. Use a new key.                                                                                                           |
| `429 RATE_LIMITED` while retrying                               | Wait `Retry-After` seconds, then send the same request again (same key).                                                                                                                             |
| Server process crashed or was killed                            | Start it again (`npm start`). No repair step: a sale is one transaction, so it is either fully there or not at all. Then retry as above.                                                             |
| `/api/health` and the API answer 503 `DB_UNAVAILABLE`         | Database unreachable. Fix the database or network; the app reconnects by itself (no restart). Log: `health check: database ping failed` and `Failed to get session`. Retry unknown sales afterwards. |
| `migrate deploy` failed (`P3018`), later deploys refuse (`P3009`) | Keep the old release running. Undo what the failed migration left, fix its SQL, `prisma migrate resolve --rolled-back <name>`, `npm run db:deploy`. Details in scenario 4.                          |

After any of these, check the books (read-only, safe on a live database):

```sql
-- Stock cache vs. ledger: must be 0.
WITH ledger AS (SELECT "orgId","branchId","productId","variantId", SUM("qtyDelta")::int AS total
                  FROM "InventoryMovement" GROUP BY 1,2,3,4)
SELECT count(*) AS reconcile_mismatches FROM "StockBalance" b
  FULL OUTER JOIN ledger l ON b."orgId" = l."orgId" AND b."branchId" = l."branchId"
   AND b."productId" = l."productId" AND b."variantId" IS NOT DISTINCT FROM l."variantId"
 WHERE COALESCE(b."qty",0) <> COALESCE(l."total",0);

-- Sale-stock movements whose sale does not exist: must be 0.
SELECT count(*) FROM "InventoryMovement" m
 WHERE m."refType" = 'Sale' AND NOT EXISTS (SELECT 1 FROM "Sale" s WHERE s."id" = m."refId");
```

## The drill

Scenarios 1–4 were run on 2026-10-19 (5 on 2026-10-23) against a production build (`npm run build`, `next start`) on port 3302,
with a scratch database `pos_dev_recovery` (PostgreSQL 16.15 in the `pos-postgres` container) migrated with
`npx prisma migrate deploy` and loaded with `npm run db:seed:dev`. No other database was touched.

[`scripts/failure-drill.mjs`](../../scripts/failure-drill.mjs) drives scenarios 1–3 and 5. It signs in as the seeded
manager of shop A, opens a shift on Till 1 if needed, and posts cash sales to `POST /api/sales`. It reads
`DATABASE_URL` from `.env` and refuses `pos_dev`, `pos_test` and `pos_e2e`. Its consistency check reports, for the
drill's sales: sales without items, payments ≠ total, line totals ≠ total, ledger quantity ≠ sold quantity, sale
movements without a sale, sales without a `sale.created` audit row, stock reconcile mismatches (whole database) and
gaps in sale numbers. Every one must be 0.

```bash
docker exec pos-postgres createdb -U postgres pos_dev_recovery
# .env: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pos_dev_recovery?schema=public
npx prisma migrate deploy
npm run db:seed:dev
npm run build
```

### 1. Lost response: retry with the same key

Server running (`npx next start -p 3302`), then:

```bash
node scripts/failure-drill.mjs retry
```

```
first  POST: 201 sale 000002 id e57e4216-f98c-4534-8ae9-51c0e7285fcd
second POST: 200 sale 000002 id e57e4216-f98c-4534-8ae9-51c0e7285fcd
same response body: true
rows for the key: {"sales":1,"stock_moves":1,"payments":1}; stock 98 -> 96
same key, other body: 409 {"code":"IDEMPOTENCY_CONFLICT","message":"This Idempotency-Key was used for a different sale","details":{"reason":"IDEMPOTENCY_CONFLICT"}}
3 concurrent POSTs, one key: 201 000003, 200 000003, 200 000003; rows 1
```

The second POST stands for the client retrying after the first response was lost: same sale, same body, one sale
row, one stock movement (2 units, stock 98 → 96), one payment. Reusing the key for a different cart is refused with
the documented `409 IDEMPOTENCY_CONFLICT`. Three POSTs racing with one key (a double tap, a client timeout that
retries while the first is still running) make one sale: the losers hit the unique index, roll back and replay the
winner.

### 2. Server killed mid-sale

```bash
node scripts/failure-drill.mjs crash
```

The script starts `next start` itself, fires 40 sales at once (unique keys, 1–3 units of five products), and 400 ms
later kills the server without a graceful shutdown (`taskkill /T /F` on Windows, `SIGKILL` elsewhere). It then checks
the database, starts the server again and retries all 40 requests with their original keys and bodies.

```
killed server pid 6932 400 ms into a burst of 40 sales
server-side transactions still open after the kill: 0
client saw: {"HTTP 201":4,"network error ECONNRESET":36}
committed before restart: 10 of 40
consistency after crash: {"sales":10,"sales_without_items":0,"sales_payments_mismatch":0,"sales_lines_mismatch":0,"sales_ledger_mismatch":0,"orphan_sale_movements":0,"sales_without_audit":0,"reconcile_mismatches":0,"sale_number_gaps":0}
server restarted, health 200
every key has exactly one sale: true
retry of all 40 with the same keys: {"HTTP 200":10,"HTTP 201":30}
sale counter 43 -> 83 (+40)
consistency after retry: {"sales":40,"sales_without_items":0,"sales_payments_mismatch":0,"sales_lines_mismatch":0,"sales_ledger_mismatch":0,"orphan_sale_movements":0,"sales_without_audit":0,"reconcile_mismatches":0,"sale_number_gaps":0}
```

- 10 sales committed, but only 4 clients got their `201`: **6 sales were made whose response was lost**. On retry
  exactly those 10 answered `200` (replayed), the other 30 were made once (`201`).
- No half-written sale: every committed sale has its items, payments, stock movements and audit row; the transactions
  that were cut off left nothing (Postgres rolled them back when their connections died, and none stayed open).
- The sale counter moved by exactly 40 and there are no gaps in sale numbers: a rolled-back sale gives its number
  back.

An earlier run of the same scenario, a minute after another burst, answered `{"HTTP 200":7,"HTTP 201":24,"HTTP 429":9}`
on the retry: the killed burst, the retries and the earlier run all count against the 120 writes per minute per user.
Nothing was lost — the 9 were made after waiting `Retry-After` — so the drill client now waits and resends on 429, as
the till does. A real till sends one sale at a time and never gets near this.

### 3. Database lost and back, server never restarted

Server running (`npx next start -p 3302`), then:

```bash
node scripts/failure-drill.mjs db-drop
```

The script closes the scratch database to new connections and terminates its sessions (both on `pos_dev_recovery`
only, as superuser on the `postgres` maintenance database), tries the API, then reopens it:

```sql
ALTER DATABASE "pos_dev_recovery" ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'pos_dev_recovery';
-- … requests …
ALTER DATABASE "pos_dev_recovery" ALLOW_CONNECTIONS true;
```

```
before: health 200
database pos_dev_recovery closed to new connections, its sessions terminated
during: health 503
during: POST /api/sales 503 {"code":"DB_UNAVAILABLE","message":"Database is unavailable","details":null}
during: GET /api/inventory/stock 503 {"code":"DB_UNAVAILABLE","message":"Database is unavailable","details":null}
database reopened (no app restart)
after: health 200
after: retry POST /api/sales 201 sale 000001
after: second retry 200 sale 000001
consistency: {"sales":1,"sales_without_items":0,"sales_payments_mismatch":0,"sales_lines_mismatch":0,"sales_ledger_mismatch":0,"orphan_sale_movements":0,"sales_without_audit":0,"reconcile_mismatches":0,"sale_number_gaps":0}
```

Server log during the outage (stack traces trimmed):

```json
{"time":"2026-10-19T11:36:57.056Z","level":"error","msg":"health check: database ping failed","requestId":"1bf9bd1a-42ae-4be8-94f6-4037381ff733","error":{"name":"PrismaClientKnownRequestError","message":"\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `55000`. Message: `database \"pos_dev_recovery\" is not currently accepting connections`"}}
{"time":"2026-10-19T11:36:57.082Z","level":"error","msg":"request failed","requestId":"9eab7f0b-ffb0-4cf9-9dd5-1c2090b35950","code":"DB_UNAVAILABLE","error":{"name":"APIError","message":"Failed to get session"},"path":"/api/sales"}
```

- `/api/health` goes 503 while the database is gone and back to 200 on the next request after it returns; the
  connection pool drops the dead connections and opens new ones. No restart.
- Business routes answer **503 `DB_UNAVAILABLE`** (re-run 2026-10-19 after the change; first run gave 500
  `INTERNAL`). Better-Auth wraps the database error as "Failed to get session", so the route wrapper and Server
  Actions check any unexpected error with a 2 s `SELECT 1` and answer 503 when it fails; the log keeps the original
  error. Users are not signed out (no 401). The till keeps the key on both `INTERNAL` and `DB_UNAVAILABLE` — outcome
  unknown — so its retry is safe; API clients must do the same.
- The sale attempted during the outage was made exactly once when retried afterwards.

### 4. Failed `prisma migrate deploy`

Run on `pos_dev_recovery` only, from a scratch copy of `prisma/` outside the repo (schema, migrations, and a config
pointing at them) with one extra migration that is never committed. It is the classic failing migration: a
`NOT NULL` column without a default on a table that already has rows.

```sql
-- migrations/20261019120000_drill_broken/migration.sql
CREATE TABLE "DrillScratch" ("id" INTEGER PRIMARY KEY);
ALTER TABLE "Sale" ADD COLUMN "drillNote" TEXT NOT NULL;
```

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/pos_dev_recovery?schema=public"
npx prisma migrate deploy --config "$SCRATCH/prisma.config.ts"
```

```
Applying migration `20261019120000_drill_broken`
Error: P3018

A migration failed to apply. New migrations cannot be applied before the error is recovered from. …

Migration name: 20261019120000_drill_broken

Database error code: 23502

Database error:
ERROR: column "drillNote" of relation "Sale" contains null values
```

State it left behind:

```
       migration_name        | started | finished_at | rolled_back_at | applied_steps_count
-----------------------------+---------+-------------+----------------+---------------------
 20261019120000_drill_broken | t       |             |                |                   0

  drill_table   | drill_column
----------------+--------------
 "DrillScratch" |            0
```

**The migration is not atomic.** The `ALTER` failed, but the `CREATE TABLE` before it stayed. Every later
`migrate deploy` now refuses to run:

```
Error: P3009

migrate found failed migrations in the target database, new migrations will not be applied. …
The `20261019120000_drill_broken` migration started at 2026-10-19 11:37:50.655178 UTC failed
```

The running release was unaffected: with the database in this state, `/api/health` answered 200 and scenario 1 made
and replayed sale 000085.

Recovery. Fixing the SQL and marking the migration rolled back is **not enough** while its partial work is still
there:

```bash
# fixed SQL: ALTER TABLE "Sale" ADD COLUMN "drillNote" TEXT NOT NULL DEFAULT '';
npx prisma migrate resolve --rolled-back 20261019120000_drill_broken --config "$SCRATCH/prisma.config.ts"
npx prisma migrate deploy --config "$SCRATCH/prisma.config.ts"
```

```
Migration 20261019120000_drill_broken marked as rolled back.
Applying migration `20261019120000_drill_broken`
Error: P3018
ERROR: relation "DrillScratch" already exists
```

Undo what the failed run left, then resolve and deploy:

```bash
docker exec pos-postgres psql -U postgres -d pos_dev_recovery -c 'DROP TABLE "DrillScratch"'
npx prisma migrate resolve --rolled-back 20261019120000_drill_broken --config "$SCRATCH/prisma.config.ts"
npx prisma migrate deploy --config "$SCRATCH/prisma.config.ts"
npx prisma migrate status --config "$SCRATCH/prisma.config.ts"
```

```
DROP TABLE
Migration 20261019120000_drill_broken marked as rolled back.
All migrations have been successfully applied.
Database schema is up to date!
```

`_prisma_migrations` keeps the history: two rolled-back attempts and the applied one (`applied_steps_count` 1).

Runbook for a failed deploy:

1. Leave the previous release running (migrations here are additive, so it keeps working) and do not start the new
   one.
2. Read the `P3018` error. Compare the migration's `migration.sql` with the database (`\d "Table"` in `psql`) to see
   which statements took effect before the failing one.
3. Either undo those by hand and fix the SQL, then `npx prisma migrate resolve --rolled-back <name>` and
   `npm run db:deploy`; or finish the remaining statements by hand and `npx prisma migrate resolve --applied <name>`.
   If unsure what it changed, restore the pre-deploy backup into a new database instead
   ([backup-restore.md](backup-restore.md)).
4. `npx prisma migrate status` must say "Database schema is up to date!" before starting the new release.

Do not delete rows from `_prisma_migrations` by hand.

### 5. Offline till replay through a crash

Run on 2026-10-23 on the same kind of scratch database (`pos_dev_recovery`, migrated and seeded as above, fresh
`npm run build`). The script starts and kills its own server.

```bash
node scripts/failure-drill.mjs offline
```

It enrols a device on Till 1 (SQL, as the till's "Use this till offline" leaves it), builds 50 offline sales the way the
till does (`offline` block, `T1-…` numbers, totals as `totals.ts` computes them, sold during the open shift), replays
them one at a time oldest first, hard-kills the server 1.5 s in, restarts it and replays the whole queue again with the
same keys:

```
device 950f8807-… on T1 holds 50 offline sales
killed server pid 28388 1500 ms into the replay
first replay saw: {"HTTP 201":45,"network error ECONNRESET":1}
committed before restart: 46 of 50
server restarted, health 200
429 on /api/sales, waiting 37 s as Retry-After says
second replay of the whole queue: {"HTTP 200":46,"HTTP 201":4}
every key has exactly one sale: true
offline numbers gap-free and unique: true
review flags: {}
consistency: {"sales":50,"sales_without_items":0,"sales_payments_mismatch":0,"sales_lines_mismatch":0,"sales_ledger_mismatch":0,"orphan_sale_movements":0,"sales_without_audit":0,"reconcile_mismatches":0,"sale_number_gaps":0}
```

- The sale in flight at the kill committed though its answer was lost (46 committed, 45 answered); its replay got 200
  with the stored sale, as for an online retry. The till treats "no answer" the same way: the entry stays queued.
- Every key has exactly one sale, the register's series has no gaps, nothing was flagged, and every consistency count
  is 0. The org series (`000123`) is untouched; the gap check now skips offline numbers.
- An earlier run gave every sale `CLOCK_SKEW`: the script had read the shift's `openedAt` through `pg`, which takes
  Prisma's UTC `timestamp` columns as local time. The script now reads it as epoch milliseconds.

## Clean-up

```bash
docker exec pos-postgres dropdb -U postgres pos_dev_recovery
```
