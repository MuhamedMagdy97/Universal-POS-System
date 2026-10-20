# Offline till: Specification

Status: **Draft for owner approval.** Every decision below has a recommendation; "approved as recommended" approves
all of them.

Source: `docs/architecture/offline-strategy.md` (MVP: online-only, "a deliberate, separately tested phase" if ever),
`docs/operations/failure-recovery.md`, the as-built `modules/sales/create.ts`, `app/(app)/pos`, `modules/registers`,
`modules/integrations/inventory-sys/postings.ts`, `lib/auth/auth.ts`, the discounts and customers specs.

## 1. Key facts

- `POST /api/sales` (and the till's `createSaleAction`) is one transaction: lock the shift, bump the **org-wide**
  `lastSaleNo` (gap-free, `000123`), re-price every line on the server from current prices, check the discount limit,
  settle payments, write stock. Today the server decides price, total and number.
- The till makes one `Idempotency-Key` (UUID) per cart and keeps it until the sale is confirmed. The server stores a
  SHA-256 `requestHash` of the canonical body; same key + same hash replays (200), same key + other hash is 409
  `IDEMPOTENCY_CONFLICT`. New optional body fields are hashed only when sent.
- Payment methods are `CASH`, `CARD_MANUAL` (external terminal, reference typed by hand) and `WALLET`. No integrated
  card terminal exists, so nothing the till does needs a payment network.
- A shop linked to the inventory system (`inventorySource = EXTERNAL`) **reserves every line in the IMS before the
  sale transaction**; an IMS refusal or outage refuses the sale (`INVENTORY_UNAVAILABLE`).
- Sessions last 12 h (`SESSION_TTL_SECONDS`), refreshed hourly. Sign-in needs the server.
- Receipts print shop, lines, payments and optional customer snapshot. ZATCA QR and the Egypt e-receipt are being
  specified in parallel; neither exists yet.

## 2. Decisions

### Scope

| #   | Topic        | Decision                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OF1 | What offline | **Sales only.** Ring up, take payment, print receipt. No refunds, voids, cash movements, shift open/close, customer quick-add, stock views or reports offline: each of those already needs a server decision.                                                                                                                                         |
| OF2 | Payments     | **Cash, `CARD_MANUAL` and `WALLET`, split allowed** — all three are already recorded by hand; whether the external terminal or wallet works offline is the shop's problem, the till only stores the typed reference.                                                                                                                                   |
| OF3 | Customers    | **Walk-in only offline.** No customer cache (keeps personal data off the device, OF12). A sale cannot get a customer later.                                                                                                                                                                                                                             |
| OF4 | Discounts    | Allowed **within the cached limit** of the signed-in user: Cashier ≤ cached `maxCashierDiscountBp`, Manager/Owner as their cached role allows. No other user can authorise at the till offline.                                                                                                                                                         |
| OF5 | Opt-in       | Per-shop setting **"Allow offline sales"**, Owner only, **default off**, and per register (OF8). Refused for linked shops (OF15) and for shops with server-signed e-invoicing switched on (OF9).                                                                                                                                                       |
| OF6 | Trigger      | Offline mode starts only when the server is **unreachable** (network error, timeout, 503 `DB_UNAVAILABLE`), never on a business refusal (4xx). A sale whose outcome is unknown (sent, no answer) is queued with its **same key and body**, so replay is the existing safe retry. The till shows a red **"Offline — N sales waiting"** bar the whole time. |

### Device cache and numbering

| #   | Topic                    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OF7  | Cached on the device     | One **till snapshot** per register: sellable items of the branch (id, variant, SKU, barcode, name EN/AR, price, archived = absent), org sale settings (`currency`, `vatRateBp`, `pricesIncludeVat`, `maxCashierDiscountBp`), receipt header (shop name, address, VAT/tax number), the open shift (id, opened at), the signed-in user (id, name, role) and the register's offline series state (OF8). No stock levels, customers, costs or other branches. The snapshot carries `snapshotAt` and a `version`. **Refresh**: on till load, every 5 min while online, on reconnect, and after any catalog/settings change the till learns of. **Freshness**: offline selling may **start** only if the snapshot is ≤ 24 h old; otherwise the till blocks with "Connect once to refresh prices". |
| OF8  | Sale number offline      | **Register-owned offline series, final at print time** (a reserved block that never runs out). Enabling offline on a register gives it a short code (`T1`) and its own counter; an offline sale is numbered `T1-000045` on the device, prints that number, and keeps it forever. Online sales keep the org series. Only one enrolled device may issue a register's series (OF16), so it is gap-free per register. **Rejected: provisional numbers** — the customer's slip would carry a number the books never show, which is wrong for any tax receipt. **Rejected: blocks from the org series** — numbers go out of order and unused blocks leave gaps the drill now treats as errors. |
| OF9  | Receipt and tax          | The offline receipt prints the series number, device time and **"Offline sale"**. Totals are computed on the device with the same `modules/sales/totals.ts` pure functions the server uses (already imported by the till), so a re-print after sync is identical. **ZATCA**: a QR that only encodes seller, VAT number, time, total and VAT (the phase-1 TLV) is computable on the device from the snapshot and may print offline. Anything that needs a **server-side signature, hash chain or clearance** (ZATCA phase 2, Egypt e-receipt submission) cannot be issued offline: per-register series map naturally to one signing unit per register, but signing on the device is a separate design. Until then OF5 refuses offline for shops with such signing on, and the e-invoicing specs own their submission windows. |
| OF10 | Storage                  | **IndexedDB** (one database: `snapshot`, `queue`, `meta`) written by the till page; a **service worker** only caches the app shell and the `/pos` route's assets so a reload or restart offline still opens the till. Each queue entry is written **before** the receipt prints and is deleted only after a 200/201. `navigator.storage.persist()` is requested when offline is enabled. The builder reads the Next.js 16 docs in `node_modules/next/dist/docs/` on service workers/PWA first.                                                                                                                                                                                                                                  |

### Replay and conflicts

| #    | Topic         | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OF11 | Replay        | Same endpoint, same key. The body gains an optional `offline` block: `{ deviceId, number, soldAt, cashierId, snapshotVersion, lines: [{ unitPriceMinor, discountMinor, lineTotalMinor }], subtotalMinor, vatMinor, totalMinor }`. It is part of the body, so the request hash covers it; online sales never send it and hash as today. Replays go **one at a time, oldest first**, on reconnect and every 30 s, with the existing 429 `Retry-After` handling. Replay needs a signed-in session on that device; the sale keeps the offline `cashierId`, and the audit row records who replayed it. |
| OF12 | Accept rule   | **An offline sale is a fact, not a request.** The server records it **as sold** — device prices, totals, number and `soldAt` — in the shift it was rung in, and never refuses it for business drift. Each drift below sets a review flag (`Sale.offlineFlags`, a small string array) and writes an audit row. Hard refusals are only: malformed body, unknown product id, wrong tenant/branch/register, device not enrolled or revoked (OF16), `IDEMPOTENCY_CONFLICT`. |
| OF13 | Conflict table | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

| Drift at replay                 | Server                                                                                                                       | Cashier sees                    | Manager sees (new "Offline sales to review" list, `sales.review`) |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| Price changed                   | Records device price; flag `PRICE_CHANGED` with old/new per line.                                                             | Nothing (sale synced).          | Line, sold price, current price, difference.                      |
| Item archived                   | Sells it anyway; flag `ITEM_ARCHIVED`.                                                                                       | Nothing.                        | Item, archived at.                                                |
| Stock short                     | Writes the movement even if `blockNegativeStock`; stock may go negative; flag `STOCK_NEGATIVE`.                               | Nothing.                        | Item, resulting quantity; fix with an adjustment or count.        |
| Discount limit lowered          | Records the discount; flag `DISCOUNT_OVER_LIMIT`; no `sales.discount.denied` row.                                              | Nothing.                        | Cashier, discount, limit now.                                     |
| Shift closed meanwhile          | Attaches to the original (closed) shift; flag `LATE_FOR_CLOSED_SHIFT`; the shift report shows "late offline sales" and the corrected expected cash beside the original count. | Nothing.          | Shift, sale, cash effect.                                         |
| Snapshot older than 24 h at sale | Cannot happen (OF7 blocks); if it does (clock tampering), flag `STALE_SNAPSHOT`.                                              | —                               | Sale.                                                             |
| Hard refusal                    | 4xx, nothing written.                                                                                                       | Entry turns red: "Sale T1-000045 could not be saved — call a manager". Never auto-deleted. | Same list, "Rejected"; manager can export the entry (JSON + receipt image) and record it by hand online. |

| #    | Topic               | Decision                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OF14 | Shift close         | **Block at the till, warn elsewhere.** The till's close button drains the queue first and refuses while anything is unsynced. The device reports `{ deviceId, queued, oldestAt }` with every snapshot refresh; a close from another device shows "Register T1 reported 3 unsynced sales at 14:02" and needs a typed note to proceed. Late sales follow OF13. |
| OF15 | Linked shops        | **No offline selling for shops linked to the inventory system** (OF5 refuses the toggle; linking refuses while any register has offline on). The reservation is the contract with the master system; queued reservations would let several tills oversell the master and leave the POS holding sales the IMS may refuse after the customer has left. Revisit only if the IMS adds an "accept after the fact" posting that may go negative. |

### Security and limits

| #    | Topic            | Decision                                                                                                                                                                                                                                                                                                                             |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OF16 | Device enrolment | Turning on offline for a register enrols the current browser: the server issues a random `deviceId` and a device secret stored in IndexedDB; replays carry both. **One device per register.** Owner can **revoke** a device from settings; replays from a revoked device are refused (4xx) and listed as rejected (OF13) so nothing disappears silently. |
| OF17 | Session offline  | No offline sign-in and no user switch offline. The signed-in user may keep selling until the **earlier of** session expiry or the offline limit (OF19). Sign-out offline is allowed only with an empty queue. Idle lock is the browser/OS screen lock.                                                                       |
| OF18 | Data at rest     | **No app-level encryption**: a key kept by the same browser profile protects nothing the profile does not already. Instead, minimise: no customers, no costs, no secrets beyond the revocable device secret; deployment docs require OS disk encryption and a locked OS account on till devices. Device loss = unsynced sales lost + catalog exposed (low sensitivity); owner revokes the device. |
| OF19 | Limits           | Offline selling stops (till blocks new sales, queue kept) at the first of: **12 h** since the last successful server contact, **300 queued sales**, or session expiry. Each limit is a constant, not a setting.                                                                                                                                   |
| OF20 | Clock            | `soldAt` is the device clock; the server stores `receivedAt` too and flags `CLOCK_SKEW` when `soldAt` is in the future or before the shift opened. Reports use `soldAt`.                                                                                                                                                                      |

## 3. Testing

- **Unit** (Vitest): queue store (write-before-print, delete-on-2xx only, ordering), limits, snapshot freshness, offline
  totals equal server totals for the same snapshot (shared `totals.ts`, table of carts incl. discounts and split).
- **Integration** (`pos_test`): `createSale` with an `offline` block — accept as sold; each OF13 drift sets its flag;
  hard refusals; replay twice = one sale; offline series gap-free and unique per register; late sale on a closed shift
  recomputes the shift report; linked shop refuses; revoked device refuses.
- **E2E** (Playwright, own `pos_e2e` DB + `E2E_PORT`): `context.setOffline(true)` → sell 3 (cash, card, split) →
  receipts show `T1-…` and "Offline sale" → **reload while offline** (service worker shell) → queue still 3 →
  `setOffline(false)` → bar clears, sales visible in the shift. Plus: close blocked with unsynced sales; price changed
  while offline appears on the review list; 12 h limit via a fake clock.
- **Drill**: extend `scripts/failure-drill.mjs` with an `offline` scenario (queue 50, kill the server mid-replay,
  restart, every key once) and record it in `failure-recovery.md`.

## 4. Rollout slices

| Slice | What                                                                                                                                                   | Effort   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1     | Server: settings + register series + device enrolment/revoke, `offline` block in `SaleInput`, accept-as-sold with flags (OF8, OF11–OF13, OF16, OF20), integration tests. | 3 days   |
| 2     | Till: snapshot cache, IndexedDB queue, offline totals and receipt, replay loop, offline bar and limits (OF6, OF7, OF9, OF10, OF17, OF19). Survives a dropped connection, not yet a reload. | 3 days   |
| 3     | Service worker app shell; reload/restart offline; E2E suite.                                                                                            | 2 days   |
| 4     | Shift-close guard and device report (OF14), "Offline sales to review" list, shift report late sales, drill + docs (`offline-strategy.md`, user guide). | 2–3 days |

Total about **10–11 days**. Slices ship in order; offline stays hidden behind OF5 until slice 3 lands.

## 5. Risks

- **Lost or wiped device loses unsynced sales.** Mitigated only by the limits (OF19) and the bar; say so in the owner
  guide.
- **Sold below current price / negative stock** is accepted by design (OF12); the review list is the control.
- **Service worker serving an old app after a deploy.** The SW is versioned with the build; a new version waits until
  the queue is empty, and the server accepts `offline` blocks from the previous `snapshotVersion` format.
- **Browser evicts IndexedDB** under storage pressure. `persist()` plus the 300-sale cap; a refused `persist()` keeps
  offline off for that device.
- **E-invoicing**: once ZATCA phase 2 or Egypt e-receipt signing is built server-side, those shops lose offline (OF5)
  until device-side signing is designed — call this out in the sales pitch.
- **Shift cash after late sales** no longer equals what was counted; the shift report must show both, not overwrite
  the count.
