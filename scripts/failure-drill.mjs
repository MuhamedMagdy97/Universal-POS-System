/**
 * Failure-recovery drill (docs/operations/failure-recovery.md). Runs against a production build
 * (`npm run build` first) and a scratch database loaded with `npm run db:seed:dev`.
 *
 *   node scripts/failure-drill.mjs retry    # lost response: same key twice, then same key + other body
 *   node scripts/failure-drill.mjs crash    # hard-kill the server mid-burst, restart, retry every request
 *   node scripts/failure-drill.mjs db-drop  # block the database, then let it back in, server never restarted
 *   node scripts/failure-drill.mjs offline  # replay 50 queued offline sales, hard-kill mid-replay, restart, replay all
 *
 * `crash` and `offline` start and kill their own server; the others expect one already running on DRILL_PORT.
 * Reads DATABASE_URL from .env and refuses pos_dev / pos_test / pos_e2e.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";

config({ quiet: true });

const PORT = Number(process.env.DRILL_PORT ?? 3302);
const BASE = `http://localhost:${PORT}`;
const DB_URL = process.env.DATABASE_URL;
const DB_NAME = new URL(DB_URL).pathname.slice(1);
if (["pos_dev", "pos_test", "pos_e2e"].includes(DB_NAME)) throw new Error(`Refusing to drill on ${DB_NAME}`);

// Seeded by prisma/seed-e2e.ts + prisma/seed-dev.ts.
const SELLER = { email: "manager@org-a.e2e.test", password: "e2e-Manager-pw-2c7e55" };
const BRANCH = "e2e0a000-0000-4000-8000-0000000000b1";
const REGISTER = "de70a000-0000-4000-8000-0000000000f1";

const say = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sql(text, params = []) {
  const client = new pg.Client({ connectionString: DB_URL.replace(/\?.*$/, "") });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** Runs as a superuser on the `postgres` maintenance database (the drill database may be closed). */
async function adminSql(text) {
  const url = new URL(DB_URL);
  url.pathname = "/postgres";
  url.search = "";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query(text)).rows;
  } finally {
    await client.end();
  }
}

let cookie = "";
async function api(method, path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (response.status === 429) {
    // Behave like the till: wait as told, then send the same request again.
    say(`429 on ${path}, waiting ${json.details.retryAfterSeconds} s as Retry-After says`);
    await sleep(json.details.retryAfterSeconds * 1000);
    return api(method, path, body, headers);
  }
  return { status: response.status, json, setCookie: response.headers.get("set-cookie") };
}

async function signIn() {
  await sql(`DELETE FROM "RateLimit"`).catch(() => {});
  const res = await api("POST", "/api/auth/sign-in/email", SELLER);
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(res.json)}`);
  cookie = res.setCookie.split(";")[0];
}

async function ensureShift() {
  const res = await api("POST", "/api/shifts/open", { branchId: BRANCH, registerId: REGISTER, openingFloatMinor: 0 });
  if (
    res.status !== 201 &&
    res.json?.details?.reason !== "SHIFT_ALREADY_OPEN" &&
    res.json?.code !== "SHIFT_ALREADY_OPEN"
  )
    throw new Error(`open shift: ${JSON.stringify(res.json)}`);
}

async function products() {
  const rows = await sql(
    `SELECT p."id", p."priceMinor" FROM "Product" p
      WHERE p."orgId" = (SELECT "orgId" FROM "Branch" WHERE "id" = $1) AND p."isActive" AND NOT p."hasVariants"
        AND p."sku" LIKE 'E2E-P-%' ORDER BY p."sku"`,
    [BRANCH],
  );
  if (rows.length < 2) throw new Error("seed the drill database first (npm run db:seed:dev)");
  return rows;
}

/** A cash sale of `qty` x product, paid with a round amount so change is non-zero. */
function saleBody(product, qty) {
  return {
    branchId: BRANCH,
    registerId: REGISTER,
    lines: [{ ref: { productId: product.id, variantId: null }, qty }],
    payments: [{ method: "CASH", amountMinor: 100_000 }],
  };
}

const sale = (key, body) => api("POST", "/api/sales", body, { "idempotency-key": key });

/** Row-level consistency of the given sales plus the org-wide ledger reconcile. */
async function checkConsistency(keys) {
  const [counts] = await sql(
    `WITH s AS (SELECT * FROM "Sale" WHERE "idempotencyKey" = ANY($1))
     SELECT (SELECT count(*) FROM s)::int AS sales,
            (SELECT count(*) FROM s WHERE NOT EXISTS (SELECT 1 FROM "SaleItem" i WHERE i."saleId" = s."id"))::int AS sales_without_items,
            (SELECT count(*) FROM s WHERE (SELECT coalesce(sum("amountMinor"),0) FROM "Payment" p WHERE p."saleId" = s."id")
                                           <> s."totalMinor")::int AS sales_payments_mismatch,
            (SELECT count(*) FROM s WHERE (SELECT coalesce(sum("lineTotalMinor"),0) FROM "SaleItem" i WHERE i."saleId" = s."id")
                                           <> s."totalMinor")::int AS sales_lines_mismatch,
            (SELECT count(*) FROM s WHERE (SELECT coalesce(sum(-m."qtyDelta"),0) FROM "InventoryMovement" m
                                            WHERE m."refType" = 'Sale' AND m."refId" = s."id")
                                         <> (SELECT sum(i."qty") FROM "SaleItem" i WHERE i."saleId" = s."id"))::int AS sales_ledger_mismatch,
            (SELECT count(*) FROM "InventoryMovement" m WHERE m."refType" = 'Sale'
                AND NOT EXISTS (SELECT 1 FROM "Sale" x WHERE x."id" = m."refId"))::int AS orphan_sale_movements,
            (SELECT count(*) FROM s WHERE NOT EXISTS (SELECT 1 FROM "AuditEvent" a WHERE a."entityId" = s."id"::text
                                                        AND a."action" = 'sale.created'))::int AS sales_without_audit`,
    [keys],
  );
  const [reconcile] = await sql(
    `WITH ledger AS (SELECT "orgId","branchId","productId","variantId", SUM("qtyDelta")::int AS total
                       FROM "InventoryMovement" GROUP BY 1,2,3,4)
     SELECT count(*)::int AS reconcile_mismatches FROM "StockBalance" b
       FULL OUTER JOIN ledger l ON b."orgId" = l."orgId" AND b."branchId" = l."branchId"
        AND b."productId" = l."productId" AND b."variantId" IS NOT DISTINCT FROM l."variantId"
      WHERE COALESCE(b."qty",0) <> COALESCE(l."total",0)`,
  );
  const [numbers] = await sql(
    `SELECT count(*)::int AS sale_number_gaps FROM (
       SELECT "number"::int - lag("number"::int) OVER (PARTITION BY "orgId" ORDER BY "number") AS step FROM "Sale"
        WHERE "number" ~ '^[0-9]+$') s
      WHERE step <> 1`,
  );
  return { ...counts, ...reconcile, ...numbers };
}

async function waitForHealth(expectStatus, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status === expectStatus) return res.status;
    } catch {
      if (expectStatus === 0) return 0;
    }
    if (Date.now() > until) throw new Error(`health never reached ${expectStatus}`);
    await sleep(250);
  }
}

function startServer() {
  // `next start` directly (not via npm/npx) so the pid we kill is the server itself.
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    stdio: "ignore",
    env: { ...process.env, AUTH_URL: BASE },
  });
  return child;
}

function hardKill(child) {
  // SIGKILL on Unix; on Windows kill the whole tree, no graceful shutdown either way.
  if (process.platform === "win32")
    execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

async function stockOf(productId) {
  const [row] = await sql(`SELECT "qty" FROM "StockBalance" WHERE "branchId" = $1 AND "productId" = $2`, [
    BRANCH,
    productId,
  ]);
  return row?.qty;
}

async function retry() {
  await signIn();
  await ensureShift();
  const [p1, p2] = await products();
  const key = `drill-retry-${randomUUID()}`;
  const body = saleBody(p1, 2);
  const before = await stockOf(p1.id);
  const first = await sale(key, body);
  const second = await sale(key, body);
  say(`first  POST: ${first.status} sale ${first.json.number} id ${first.json.id}`);
  say(`second POST: ${second.status} sale ${second.json.number} id ${second.json.id}`);
  say(`same response body: ${JSON.stringify(first.json) === JSON.stringify(second.json)}`);
  const [rows] = await sql(
    `SELECT (SELECT count(*) FROM "Sale" WHERE "idempotencyKey" = $1)::int AS sales,
            (SELECT count(*) FROM "InventoryMovement" WHERE "refType" = 'Sale' AND "refId" = $2)::int AS stock_moves,
            (SELECT count(*) FROM "Payment" WHERE "saleId" = $2)::int AS payments`,
    [key, first.json.id],
  );
  say(`rows for the key: ${JSON.stringify(rows)}; stock ${before} -> ${await stockOf(p1.id)}`);
  const other = await sale(key, saleBody(p2, 1));
  say(`same key, other body: ${other.status} ${JSON.stringify(other.json)}`);
  // A retry fired while the first attempt is still running (double tap, client timeout).
  const raceKey = `drill-race-${randomUUID()}`;
  const race = await Promise.all([1, 2, 3].map(() => sale(raceKey, saleBody(p2, 1))));
  const [raced] = await sql(`SELECT count(*)::int AS sales FROM "Sale" WHERE "idempotencyKey" = $1`, [raceKey]);
  say(
    `3 concurrent POSTs, one key: ${race.map((r) => `${r.status} ${r.json.number}`).join(", ")}; rows ${raced.sales}`,
  );
}

async function crash() {
  const BURST = Number(process.env.DRILL_BURST ?? 40);
  const KILL_AFTER_MS = Number(process.env.DRILL_KILL_AFTER_MS ?? 400);
  server = startServer();
  await waitForHealth(200);
  await signIn();
  await ensureShift();
  const items = await products();
  const requests = Array.from({ length: BURST }, (_, i) => ({
    key: `drill-crash-${randomUUID()}`,
    body: saleBody(items[i % items.length], 1 + (i % 3)),
  }));
  const [{ lastSaleNo: before }] = await sql(
    `SELECT "lastSaleNo" FROM "Organization" WHERE "id" =
    (SELECT "orgId" FROM "Branch" WHERE "id" = $1)`,
    [BRANCH],
  );

  const inFlight = requests.map((r) =>
    sale(r.key, r.body).then(
      (res) => ({ ok: true, status: res.status }),
      (err) => ({ ok: false, error: err.cause?.code ?? err.message }),
    ),
  );
  await sleep(KILL_AFTER_MS);
  hardKill(server);
  say(`killed server pid ${server.pid} ${KILL_AFTER_MS} ms into a burst of ${BURST} sales`);
  const outcomes = await Promise.all(inFlight);
  // Postgres rolls back a transaction whose connection died: nothing may stay open or locked.
  await sleep(1000);
  const [open] = await sql(
    `SELECT count(*)::int AS open_transactions FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL`,
  );
  say(`server-side transactions still open after the kill: ${open.open_transactions}`);
  const tally = {};
  for (const o of outcomes)
    tally[o.ok ? `HTTP ${o.status}` : `network error ${o.error}`] =
      (tally[o.ok ? `HTTP ${o.status}` : `network error ${o.error}`] ?? 0) + 1;
  say(`client saw: ${JSON.stringify(tally)}`);

  const keys = requests.map((r) => r.key);
  const committedBefore = (
    await sql(`SELECT count(*)::int AS n FROM "Sale" WHERE "idempotencyKey" = ANY($1)`, [keys])
  )[0].n;
  say(`committed before restart: ${committedBefore} of ${BURST}`);
  say(`consistency after crash: ${JSON.stringify(await checkConsistency(keys))}`);

  server = startServer();
  await waitForHealth(200);
  say("server restarted, health 200");
  const retried = [];
  for (const r of requests) retried.push((await sale(r.key, r.body)).status);
  const committed = new Set(
    (await sql(`SELECT "idempotencyKey" FROM "Sale" WHERE "idempotencyKey" = ANY($1)`, [keys])).map(
      (r) => r.idempotencyKey,
    ),
  );
  say(`every key has exactly one sale: ${committed.size === BURST}`);
  const retryTally = {};
  for (const s of retried) retryTally[`HTTP ${s}`] = (retryTally[`HTTP ${s}`] ?? 0) + 1;
  say(`retry of all ${BURST} with the same keys: ${JSON.stringify(retryTally)}`);
  const [{ lastSaleNo: after }] = await sql(
    `SELECT "lastSaleNo" FROM "Organization" WHERE "id" =
    (SELECT "orgId" FROM "Branch" WHERE "id" = $1)`,
    [BRANCH],
  );
  say(`sale counter ${before} -> ${after} (+${after - before})`);
  say(`consistency after retry: ${JSON.stringify(await checkConsistency(keys))}`);
}

async function dbDrop() {
  await signIn();
  await ensureShift();
  const [p1] = await products();
  const health = async () => (await fetch(`${BASE}/api/health`)).status;
  say(`before: health ${await health()}`);

  await adminSql(`ALTER DATABASE "${DB_NAME}" ALLOW_CONNECTIONS false`);
  await adminSql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}'`);
  say(`database ${DB_NAME} closed to new connections, its sessions terminated`);
  const key = `drill-dbdrop-${randomUUID()}`;
  const body = saleBody(p1, 1);
  try {
    say(`during: health ${await health()}`);
    const during = await sale(key, body);
    say(`during: POST /api/sales ${during.status} ${JSON.stringify(during.json)}`);
    const read = await api("GET", "/api/inventory/stock");
    say(`during: GET /api/inventory/stock ${read.status} ${JSON.stringify(read.json)}`);
  } finally {
    await adminSql(`ALTER DATABASE "${DB_NAME}" ALLOW_CONNECTIONS true`);
  }
  say("database reopened (no app restart)");
  say(`after: health ${await health()}`);
  const retried = await sale(key, body);
  say(`after: retry POST /api/sales ${retried.status} sale ${retried.json.number}`);
  const again = await sale(key, body);
  say(`after: second retry ${again.status} sale ${again.json.number}`);
  say(`consistency: ${JSON.stringify(await checkConsistency([key]))}`);
}

/**
 * Offline till (offline-till-spec §3 drill): a device holds 50 sales rung up offline and replays them oldest first,
 * as the till does; the server is hard-killed mid-replay, restarted, and the whole queue replayed again with the
 * same keys. Every key must end with exactly one sale, numbered in the register's series without gaps.
 */
async function offline() {
  const QUEUED = Number(process.env.DRILL_QUEUED ?? 50);
  const KILL_AFTER_MS = Number(process.env.DRILL_KILL_AFTER_MS ?? 1500);
  server = startServer();
  await waitForHealth(200);
  await signIn();
  await ensureShift();
  const items = await products();

  // An enrolled device, as the till's "Use this till offline" leaves it.
  const secret = randomUUID() + randomUUID();
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const [org] = await sql(
    `UPDATE "Organization" SET "allowOfflineSales" = true WHERE "id" = (SELECT "orgId" FROM "Branch" WHERE "id" = $1)
     RETURNING "id", "vatRateBp", "pricesIncludeVat"`,
    [BRANCH],
  );
  await sql(`UPDATE "RegisterDevice" SET "revokedAt" = now() WHERE "registerId" = $1 AND "revokedAt" IS NULL`, [
    REGISTER,
  ]);
  const [register] = await sql(
    `UPDATE "Register" SET "offlineCode" = COALESCE("offlineCode", 'T' || (SELECT count(*) + 1 FROM "Register"
       WHERE "orgId" = $2 AND "offlineCode" IS NOT NULL)) WHERE "id" = $1 RETURNING "offlineCode", "lastOfflineSaleNo"`,
    [REGISTER, org.id],
  );
  const [device] = await sql(
    `INSERT INTO "RegisterDevice" ("id", "orgId", "registerId", "secretHash", "enrolledById")
     SELECT gen_random_uuid(), $1, $2, $3, "id" FROM "User" WHERE "email" = $4 RETURNING "id"`,
    [org.id, REGISTER, secretHash, SELLER.email],
  );
  const [shift] = await sql(
    `SELECT "id", (extract(epoch FROM "openedAt") * 1000)::float8 AS "openedMs" FROM "RegisterShift" WHERE "registerId" = $1 AND "status" = 'OPEN'`,
    [REGISTER],
  );
  const [cashier] = await sql(`SELECT "id" FROM "User" WHERE "email" = $1`, [SELLER.email]);
  const vatRows = await sql(`SELECT "id", "vatApplicable" FROM "Product" WHERE "id" = ANY($1)`, [
    items.map((item) => item.id),
  ]);
  const taxed = new Map(vatRows.map((row) => [row.id, row.vatApplicable]));

  // Device totals as totals.ts computes them (VAT per line, half up), so no sale is flagged TOTALS_DIFFER.
  const half = (num, den) => (2n * num + den) / (2n * den);
  const priced = (product, qty) => {
    const gross = product.priceMinor * qty;
    const rate = taxed.get(product.id) ? org.vatRateBp : 0;
    if (org.pricesIncludeVat) {
      return { total: gross, vat: gross - Number(half(BigInt(gross) * 10_000n, BigInt(10_000 + rate))) };
    }
    const vat = Number(half(BigInt(gross) * BigInt(rate), 10_000n));
    return { total: gross + vat, vat };
  };
  const now = Date.now();
  const queue = Array.from({ length: QUEUED }, (_, i) => {
    const product = items[i % items.length];
    const qty = 1 + (i % 3);
    const { total, vat } = priced(product, qty);
    return {
      key: `drill-offline-${randomUUID()}`,
      body: {
        ...saleBody(product, qty),
        offline: {
          deviceId: device.id,
          deviceSecret: secret,
          number: `${register.offlineCode}-${String(register.lastOfflineSaleNo + i + 1).padStart(6, "0")}`,
          // One a second from the shift's start (Prisma stores UTC in a plain timestamp, so read it as epoch ms).
          soldAt: new Date(shift.openedMs + (i + 1) * 1000).toISOString(),
          snapshotAt: new Date(now - 3_600_000).toISOString(),
          snapshotVersion: 1,
          shiftId: shift.id,
          cashierId: cashier.id,
          lines: [{ unitPriceMinor: product.priceMinor, discountMinor: 0, lineTotalMinor: total }],
          subtotalMinor: total - vat,
          vatMinor: vat,
          totalMinor: total,
        },
      },
    };
  });
  say(`device ${device.id} on ${register.offlineCode} holds ${QUEUED} offline sales`);

  // One at a time, oldest first, like the till's replay loop; stops at the first request with no answer.
  const replay = async () => {
    const tally = {};
    for (const entry of queue) {
      let status;
      try {
        status = `HTTP ${(await sale(entry.key, entry.body)).status}`;
      } catch (err) {
        status = `network error ${err.cause?.code ?? err.message}`;
      }
      tally[status] = (tally[status] ?? 0) + 1;
      if (status.startsWith("network")) break;
    }
    return tally;
  };
  const first = replay();
  await sleep(KILL_AFTER_MS);
  hardKill(server);
  say(`killed server pid ${server.pid} ${KILL_AFTER_MS} ms into the replay`);
  say(`first replay saw: ${JSON.stringify(await first)}`);
  const keys = queue.map((entry) => entry.key);
  const [{ n: before }] = await sql(`SELECT count(*)::int AS n FROM "Sale" WHERE "idempotencyKey" = ANY($1)`, [keys]);
  say(`committed before restart: ${before} of ${QUEUED}`);

  server = startServer();
  await waitForHealth(200);
  say("server restarted, health 200");
  say(`second replay of the whole queue: ${JSON.stringify(await replay())}`);
  const rows = await sql(
    `SELECT "idempotencyKey", "number", "offlineFlags" FROM "Sale" WHERE "idempotencyKey" = ANY($1)`,
    [keys],
  );
  const numbers = rows.map((row) => Number(row.number.split("-")[1])).sort((a, b) => a - b);
  say(
    `every key has exactly one sale: ${new Set(rows.map((row) => row.idempotencyKey)).size === QUEUED && rows.length === QUEUED}`,
  );
  say(`offline numbers gap-free and unique: ${numbers.every((n, i) => n === register.lastOfflineSaleNo + i + 1)}`);
  const flags = {};
  for (const row of rows) for (const flag of row.offlineFlags) flags[flag] = (flags[flag] ?? 0) + 1;
  say(`review flags: ${JSON.stringify(flags)}`);
  say(`consistency: ${JSON.stringify(await checkConsistency(keys))}`);
}

const scenarios = { retry, crash, "db-drop": dbDrop, offline };

const run = scenarios[process.argv[2]];
if (!run) throw new Error(`usage: node scripts/failure-drill.mjs ${Object.keys(scenarios).join("|")}`);
let server;
try {
  await run();
} finally {
  if (server && server.exitCode === null) {
    try {
      hardKill(server);
    } catch {
      // already gone
    }
  }
}
