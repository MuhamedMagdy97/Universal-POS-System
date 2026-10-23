# Offline till: slice 1 as built (server)

Spec: `offline-till-spec.md` (approved as recommended). Slice 1 = OF5, OF8, OF11–OF13, OF15, OF16, OF20 on the server.
Nothing changed at the till: offline stays hidden there until slice 3.

## What exists

- **Shop setting** `Organization.allowOfflineSales` (default off). Settings → Offline till (`/settings/offline`): Owner
  and Admin see it, only the Owner changes it (new permission `offline.manage`, Owner only). Turning it on is refused
  for a linked shop (`INVENTORY_LINKED`); audited as `settings.offline.updated`.
- **Devices** `RegisterDevice` (id = deviceId, SHA-256 of a 32-byte random secret, enrolled/revoked by and at). One
  non-revoked device per register (partial unique index `RegisterDevice_one_active_per_register`, hand-written in the
  migration: a future `migrate dev` will try to drop it, trim that line as with `POItem_one_line_per_item`).
  `enrolOfflineDevice(ctx, registerId)` (Owner, shop setting on, not linked, no live device) returns
  `{ deviceId, deviceSecret, registerId, offlineCode, lastOfflineSaleNo }`; the secret is never stored or shown again.
  `revokeOfflineDevice(ctx, registerId)` (Owner) is on the settings screen. Audited as `register.offline.enrolled` /
  `register.offline.revoked`.
- **Series** `Register.offlineCode` (`T1`, `T2`, … given at the first enrolment, never reused) and
  `Register.lastOfflineSaleNo` (highest accepted number; a re-enrolled device continues from it).
- **Linking** (`setInventorySource` to EXTERNAL) is refused with `OFFLINE_ENABLED` while the setting is on or any
  device is enrolled.
- **Offline replay**: `SaleInput.offline` (`modules/sales/schemas.ts`), handled in `modules/sales/create.ts` with the
  helpers in `modules/sales/offline.ts`. Same endpoint, same Idempotency-Key handling; online bodies hash exactly as
  before (the block is optional and absent from them).
- **Accept as sold**: device prices, discounts, totals, number and `soldAt` (stored as `Sale.createdAt`, so reports use
  it); `Sale.receivedAt` = server time (NULL for online sales); `Sale.cashierId` = the offline cashier; the
  `sale.created` audit actor is whoever replayed it. The org counter `lastSaleNo` is not bumped.
- **Flags** (`Sale.offlineFlags`, one `sale.offline.flagged` audit row per flag with the review details):
  `PRICE_CHANGED` (sku, sold, current), `ITEM_ARCHIVED` (skus), `STOCK_NEGATIVE` (sku, resulting qty; written even
  with `blockNegativeStock`), `DISCOUNT_OVER_LIMIT` (cashier, discount, limit now; no `sales.discount.denied` row),
  `LATE_FOR_CLOSED_SHIFT` (shift), `STALE_SNAPSHOT`, `CLOCK_SKEW`.
- **Hard refusals**: malformed body (Zod, or `OFFLINE_SALE_INVALID`: totals that do not add up, lines not one per
  item, number not in the register's series), unknown product (404), wrong branch/register (404) or shift (404),
  unknown device / wrong secret / device of another register (403 `DEVICE_NOT_ENROLLED`), revoked device (403
  `DEVICE_REVOKED`), `IDEMPOTENCY_CONFLICT`, and a linked shop (409 `OFFLINE_NOT_ALLOWED`, OF15).
- Migration `20261022160000_offline_till`. `prisma migrate dev --create-only` refuses to run non-interactively here, so
  the SQL came from `prisma migrate diff --from-config-datasource --to-schema`, trimmed the same way.
- Tests: `tests/integration/offline-sales.test.ts` (18 cases), `tests/e2e/offline-settings.spec.ts` (owner toggle,
  admin read-only).

## Deviations from the spec

1. **Two more fields in the `offline` block**: `shiftId` (OF13 attaches a late sale to "the original shift"; the
   server cannot know which one without it) and `snapshotAt` (needed for `STALE_SNAPSHOT`; `snapshotVersion` is the
   format version). Plus **`deviceSecret`** in the block (OF16 "replays carry both"); it is **left out of the request
   hash** and never written to audit rows.
2. **Extra flag `TOTALS_DIFFER`**: when the device's totals differ from the server's recomputation with the device's
   prices (in practice the VAT rate changed since the snapshot), the device's figures are kept, the VAT is spread over
   the lines by largest remainder, and the flag records both totals.
3. **Extra hard refusal `OFFLINE_NUMBER_TAKEN`** (409): a number already used by another sale. With one device per
   register this only happens with a forged or buggy device; storing it would break the unique sale number.
4. **`CLOCK_SKEW` grace**: a `soldAt` up to 5 minutes ahead of the server is not flagged (device clocks drift).
5. **Turning the shop setting off does not revoke devices**: their queued sales are facts and still sync. Linking
   needs the setting off **and** every device revoked.
6. **Not built** (no server for it yet): OF5's refusal for shops with server-signed e-invoicing (no such signing
   exists); an HTTP route or server action for enrolment (the service exists; slice 2's till calls it); a device secret
   header on `POST /api/sales` (the secret travels in the body).
7. **Deactivated cashier**: an offline sale by a cashier whose membership was deactivated since is still accepted; a
   user who is not a member of the shop is refused (404 `Cashier`).
8. **Variant rule**: an item whose variant shape changed since the sale (e.g. now has variants) is still refused
   (422 `ITEM_NOT_SELLABLE`), as for history lookups.

## Known gaps for later slices

- ~~Returns lookup by number (`normalizeSaleNumber`) accepts only the 6-digit org series, so `T1-000045` cannot be
  found on the returns screen yet.~~ Fixed: it also reads the offline series, any case, padding optional (`t1-45`).
- The shift report shows late sales inside the cash terms, but the stored expected cash is not recomputed and there is
  no "late offline sales" line yet (slice 4). No "Offline sales to review" list yet (slice 4); the flags and audit rows
  carry what it needs.
