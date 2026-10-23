# Offline till: slice 3 as built (service worker)

Spec: `offline-till-spec.md` (OF10, §3 E2E). With slice 3 a reload or browser restart while offline still opens the
till, with its queue.

## What exists

- **`public/sw.js`**, registered by the till (`use-offline.ts`) only on a browser that holds an offline device, with
  scope `/pos`. No dependency (Serwist was not needed for one page).
  - `/pos` navigations: network-first; a full 200 page (not a sign-in redirect) is kept under its URL and as "the last
    till". Offline, the exact URL is served, else the last till.
  - `/_next/static/*`: cache-first (file names carry their content hash).
  - The till's first load happens before the worker controls it, so the till posts `{ type: "precache", page, files }`
    after the worker activates: the page is fetched again and kept, and exactly the static files the page loaded are
    kept; files of older builds are dropped.
  - Sales, the snapshot and the device stay in IndexedDB (slice 2); the worker never sees them. Server Actions and
    other non-GET requests pass through.
- **CSP**: `worker-src 'self'` (the nonce policy's `'strict-dynamic'` would otherwise rule the worker out). **Proxy**:
  `/sw.js` is public, so the browser's own update checks never get a sign-in redirect.
- **E2E** (`tests/e2e/offline-settings.spec.ts`, serial with the settings test): enrol, wait for the cached page, drop
  the connection, sell cash, card and split (`T…-000001..3`, "Offline sale" slips), change the price on the server,
  reload offline (queue still 3), reconnect: all three synced into the open shift with `PRICE_CHANGED`, and on the
  review list. Plus the 12-hour limit with Playwright's fake clock.

## Deviations from the spec

1. **No "new worker waits for an empty queue"**: the page is network-first, so a deploy shows on the next online load,
   and the queue format did not change; the server accepts the previous `snapshotVersion`. If the queue format ever
   changes, bump `CACHE` and make the till migrate or drain first.
2. `navigator.serviceWorker.ready` never resolves on a first install here (the page is not yet controlled), so the till
   waits for the new worker's `activated` state instead.
