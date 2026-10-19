# Troubleshooting

## Logs

The server writes one JSON object per line ([`lib/logger.ts`](../../lib/logger.ts)): `info`/`debug` to stdout,
`warn`/`error` to stderr. Fields: `time`, `level`, `msg`, then context (`requestId`, `orgId`, `actor`, `code`,
`path`, `error`). Values under secret-looking keys (password, secret, token, cookie, authorization, api key, database
URL, connection string, card number, CVV) are replaced with `[REDACTED]`; errors log only `name` and `message`.

What gets logged:

| `msg`                                       | level | When                                                                    |
| ------------------------------------------- | ----- | ----------------------------------------------------------------------- |
| `request failed`                            | error | a Route Handler answered 5xx; `code` and `error` say why                |
| `request rejected`                          | warn  | a Route Handler answered 4xx (`FORBIDDEN`, `CONFLICT`, `RATE_LIMITED`…) |
| `health check: database ping failed`        | error | `/api/health` could not query the database; `error` is the cause        |
| `rate limiter unavailable, request allowed` | error | the limiter query failed; the request was let through (fails open)      |

Real lines from a server whose database was down:

```json
{"time":"2026-10-18T23:56:13.063Z","level":"error","msg":"health check: database ping failed","requestId":"20bc93e1-c618-4ca7-befd-717bce2a0d2a","error":{"name":"PrismaClientKnownRequestError","message":"\nInvalid `prisma.$queryRaw()` invocation:\n\n\n"}}
{"time":"2026-10-18T23:56:13.063Z","level":"error","msg":"request failed","requestId":"20bc93e1-c618-4ca7-befd-717bce2a0d2a","code":"DB_UNAVAILABLE","error":{"name":"AppError","message":"Database is unavailable"},"path":"/api/health"}
```

Screens use Server Actions, which do not go through the route wrapper: most action failures show on screen and are
not logged. Business events (sales, refunds, voids, shift open/close and cash movements, stock moves, purchasing, staff and
settings changes, permission denials, API rate-limit hits) are in the audit trail (`/audit`, Owner and Admin), not the log.

## Request ids

Every request gets an `x-request-id`: the one the client sent, or a new UUID ([`proxy.ts`](../../proxy.ts)). It is
returned as a response header on pages and API routes, including errors, and is the `requestId` in the log lines.
To trace a failure, take the id from the response (browser dev tools → Network → response headers) and search the log:

```bash
curl -si -H "x-request-id: relcheck-123" http://localhost:3200/api/products
```

```
HTTP/1.1 401 Unauthorized
x-request-id: relcheck-123
{"code":"UNAUTHENTICATED","message":"Authentication required","details":null}
```

## Error envelope

Every API error is `{ code, message, details }` ([`lib/errors.ts`](../../lib/errors.ts),
[api contracts](../architecture/api-contracts.md)):

| Code                   | HTTP | Usual cause                                                                                     |
| ---------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`      | 401  | no session cookie, or the session expired (12 h)                                                |
| `FORBIDDEN`            | 403  | the role lacks the permission                                                                   |
| `NOT_FOUND`            | 404  | missing record, or one belonging to another shop (never told apart, on purpose)                 |
| `CONFLICT`             | 409  | unique value already used (SKU, barcode…), or a state rule (shift already open, PO closed…)     |
| `IDEMPOTENCY_CONFLICT` | 409  | an `Idempotency-Key` was reused with a different body; the client must send a new key           |
| `VALIDATION_FAILED`    | 422  | bad JSON or a field rule; `details` lists `path`, `code`, `message` per problem                 |
| `RATE_LIMITED`         | 429  | over the limit; `details.retryAfterSeconds` and a `Retry-After` header say when to retry        |
| `INTERNAL`             | 500  | unexpected; the log line with the same `requestId` has the error                               |
| `DB_UNAVAILABLE`       | 503  | `/api/health` could not reach the database, or the config is invalid                            |

## Rate limits

| Limit                         | Scope                                 | Window | Max                                 | Storage                         |
| ----------------------------- | ------------------------------------- | ------ | ----------------------------------- | ------------------------------- |
| Business API (`/api/*`)       | per user per shop, per bucket         | 60 s   | 600 reads, 120 writes, 10 CSV exports | `ApiRateLimit` table          |
| Sign-in and sign-up           | per client IP (Better-Auth)           | 60 s   | 5                                   | Better-Auth rate-limit table    |
| Other `/api/auth/*`           | per client IP (Better-Auth)           | 60 s   | 100                                 | Better-Auth rate-limit table    |
| Shop setup (`/onboarding`)    | per client IP (`x-forwarded-for`)     | 60 s   | 5                                   | `ApiRateLimit` table            |

Counted in PostgreSQL, so they hold across server instances. The business limiter fails open: if its query fails, the
request goes through and `rate limiter unavailable, request allowed` is logged. The first refused request per user,
bucket and window writes an `api.rate_limited` audit row. Seven wrong sign-ins in a row from one address:

```
401 401 401 401 401 429 429
```

A user who hits the sign-in limit waits up to a minute. Behind a proxy, make sure it forwards the client address,
otherwise every user shares one IP bucket.

## Common problems

### Invalid server configuration

A missing or bad env var is reported on the first request that needs config, not at start-up. `next start` prints
`Ready` and serves pages, then requests fail. On `/api/health` it is a 503 `DB_UNAVAILABLE`; the log has the real
reason, naming the key but never its value:

```
{"level":"error","msg":"health check: database ping failed",…,"error":{"name":"Error","message":"Invalid server configuration:\n- AUTH_SECRET: AUTH_SECRET must be at least 32 characters"}}
⨯ Error: Invalid server configuration:
- AUTH_SECRET: AUTH_SECRET must be at least 32 characters
```

Sign-in answers 500 in that state. Fix the variable ([install and env](install-and-env.md#2-environment-variables))
and restart.

### Health returns 503 with a Prisma error

The database is unreachable: wrong host or port in `DATABASE_URL`, server down, or (local Docker) the port is not
published. Check `docker ps --filter name=pos-postgres` shows `0.0.0.0:5432->5432/tcp`.

While the database is gone, business API routes answer 500 `INTERNAL` ("Failed to get session" in the log), not
503. The app reconnects by itself once the database is back; no restart. Sales whose outcome was unknown are retried
with the same `Idempotency-Key` ([failure recovery](failure-recovery.md)).

### Sign-in returns 403

The request's `Origin` does not match `AUTH_URL`. Seen when the app runs on another port or host than `AUTH_URL`
says (sign-in from `http://localhost:3203` with `AUTH_URL=http://localhost:3000` → 403; same request with the matching
origin → 200). Set `AUTH_URL` to the public URL the browser uses.

### Sign-in returns 429

Five attempts in a minute from one address. Wait a minute. It also survives a database restore (the counter is a
row in the database).

### `prisma migrate deploy` fails

Run the preflight SQL for that migration if it has one (`scripts/`, `prisma/sql/`), fix the rows it reports, then see
[rollback](deploy-and-rollback.md#rollback), step 3, and the exercised walk-through in
[failure recovery](failure-recovery.md#4-failed-prisma-migrate-deploy). Never run `prisma migrate dev` or `migrate reset` against
production.

### `pg_dump: error: invalid URI query parameter: "schema"`

Remove `?schema=public` from the URL for `pg_dump` / `pg_restore` / `psql` ([backup and restore](backup-restore.md)).

### Tests refuse to run

`npm test` needs `TEST_DATABASE_URL`, different from `DATABASE_URL`. `npm run test:e2e` needs `E2E_DATABASE_URL`,
different from both, and builds the app first. `npm run db:seed:dev` refuses non-local hosts and the test and E2E
databases. These guards stop the suites from writing into development data.
