# Offline till: slice 2 as built (till)

Spec: `offline-till-spec.md` (approved as recommended). Slice 2 = OF6, OF7, OF9, OF10, OF17, OF19 at the till. The till
survives a dropped connection; a reload while offline needs the service worker (slice 3).

## What exists

- **Enrolment at the till**: when the shop allows offline sales and the register has no live device, the Owner sees
  "Use this till offline" (`enrolTillDeviceAction` → `enrolOfflineDevice`). The returned device (id, secret, series code,
  last number) is kept in IndexedDB; `navigator.storage.persist()` is requested.
- **Snapshot** (`getTillSnapshot`, `modules/sales/offline-snapshot.ts`, action `tillSnapshotAction`): every sellable
  item with its barcodes (`listSellable` in the catalog seam; no cost, no stock), org sale settings, receipt header and
  timezone, the open shift, the user (id, name, role), the register's code and live device id, the session expiry, and
  the Saudi VAT number when the shop prints ZATCA QRs. Refreshed on load, every 5 min, on `online`, and as a probe every
  30 s while offline. Only fetched when this browser holds a device.
- **IndexedDB** `pos-offline` (`_lib/offline-db.ts`): `meta` (device, snapshot, last server contact per register) and
  `queue` (by Idempotency-Key). The sale and the device's counter are written in one transaction before the slip shows.
- **Selling offline** (`_lib/offline.ts`, `_lib/use-offline.ts`): a sale call that throws, gets no answer in 15 s, or gets
  503 `DB_UNAVAILABLE` switches the till offline; the cart is rung up on the device with the shared `totals.ts`, numbered
  `T1-000045`, queued, and its slip (the same `ReceiptSlip`, built on the device) says "Offline sale" and carries the
  phase-1 QR for a Saudi shop. While offline, search uses the snapshot (exact barcode/SKU, else name/SKU) and stock
  hints are skipped. Server reprints of synced offline sales say "Offline sale" too (`ReceiptDoc.offline`).
- **Limits** (`offlineBlock`): shop setting off or linked, no device or a device the server no longer has, another user
  than the snapshot's, no open shift, snapshot over 24 h, session expired, 12 h since the last server contact, 300
  queued, or a customer on the sale. The till then shows why and does not sell.
- **Replay**: oldest first, one at a time, through the same `createSaleAction` and key, on load, on `online` and every
  30 s. 2xx deletes; no answer, 5xx, 429, 401 or a plain 403 waits; a hard refusal (other 4xx, or `DEVICE_REVOKED` /
  `DEVICE_NOT_ENROLLED`) turns the entry red: "Sale T1-000045 could not be saved — call a manager". It is never deleted.
- **Bar**: red "Offline — N sales waiting", "N offline sales waiting to sync", "Offline ready · series T1", sign-in
  needed, and the red rejected entries.
- Tests: `tests/unit/pos-offline.test.ts`, `tests/integration/offline-till-snapshot.test.ts`, and the "offline till"
  E2E in `tests/e2e/offline-settings.spec.ts` (enrol, drop the connection, sell, slip, reconnect, synced).

## Deviations from the spec

1. **Unknown outcome (OF6)**: a sale sent with no answer is rung up offline **under the same key**. If the online
   attempt did land, its replay is refused with `IDEMPOTENCY_CONFLICT` and listed red as "already recorded online under
   another number" for a manager; nothing is sold twice.
2. **Once offline, the till sells offline** until a replay or snapshot refresh reaches the server (at most 30 s), rather
   than trying the server first for every sale.
3. **`persist()` refused** does not keep offline off; it is only requested. Browsers often refuse it for sites that are
   not installed.
4. **Settings** come from the page while it is loaded; the snapshot's copy is for slice 3 (reload offline).
5. **Not yet**: sign-out offline only with an empty queue (OF17) and the shift-close guard (OF14) — slice 4.
