# Phase 13 — Inventory System Integration: Slices

The decisions live in [spec.md](spec.md) (I1–I23, approved 2026-10-19, every decision as recommended) and the
schema, routes and test plan in [data-model-and-api.md](data-model-and-api.md). This page cuts that work into
slices that each ship as one PR, records what slice 1 built, and where it deliberately stops short. "IMS" is the
inventory system at `D:/inventory sys` (read only, never modified from here).

## Ground rules (all slices)

- **Optional, per shop.** `Organization.inventorySource` is `BUILT_IN` (default) or `EXTERNAL`. A POS-only shop
  sees no change: built-in stock, purchasing and transfers keep working, and nothing in the POS depends on the IMS
  being installed or reachable (I1).
- **IMS is master when linked.** Products, variants, barcodes and prices sync **down** and are read-only in the POS.
  The POS never pushes catalog changes up (out of scope).
- **Stock quantities are never copied into POS stock tables.** Stock is read from the IMS on demand (slice 4) and
  taken in the IMS by sale posting (slice 2).
- **The API key is write-only.** AES-256-GCM sealed under `INTEGRATION_ENCRYPTION_KEY`, decrypted per call on the
  server, never returned, logged or audited (I3).

## Slices

| Slice | Scope | Spec | Status |
|---|---|---|---|
| 1 | Toggle, link settings, connection check, catalog sync (pull, "Sync now"), read-only guards | I1–I4, I6–I11, I18, I22 (part) | **Built** (this PR) |
| 2 | Sale posting: branch → warehouse map, reserve before / fulfil after, outbox, till messages | I5, I12, I13, I17 | Next |
| 3 | Refunds and voids as IMS sales returns / cancels, queued | I14, I15 | |
| 4 | Stock from the IMS on the item page; scheduler route (retries + 15-minute sync) | I16, I19 | |
| 5 | Guided enable for an existing shop: dry run, CSV of POS on-hand | I20 | |
| 6 | Secrets sweep, perf (5 000 products, 10-line sale), manual run against the real IMS | R3, R4, I23 | |

### Sale posting (slice 2)

Reserve every merged line (`POST /api/reservations`, branch's warehouse, `externalOrderId` = sale key) **before**
the POS transaction, never inside it; commit the sale **without** POS stock movements plus one `FULFIL` outbox row
per line; fulfil after commit. Any refused line cancels what was reserved (`POST /api/sales-orders/{id}/cancel`)
and the sale is refused with nothing written. `POST /api/pos-sales` is not used: it is one IMS transaction per
line, so a failure on line 3 would leave lines 1–2 sold with no clean undo.

### Idempotency (slice 2–3)

Every IMS call carries a key derived from the POS document's own key and is **reused on every retry**:
`pos:{saleKey}:r:{n}` (reserve), `pos:{saleKey}:f:{n}` (fulfil), `pos:{saleKey}:cancel`, `pos:{refundKey}:ret`,
`pos:sale:{saleId}:void`. The IMS stores the answer per key in the same transaction and replays it, so a till
retry after a crash never holds stock twice; reservations of a sale that was never committed expire after the
IMS's `pos` TTL (900 s).

### Refunds and voids (slice 3)

A refund pays the customer at once and **queues** an IMS sales return (reason `pos_refund`); a void cancels
unfulfilled reservations or returns fulfilled lines (reason `pos_void`). Neither is blocked by an IMS outage: the
outbox retries them (backoff 1, 2, 5, 15, 30, 60 min) and the status page flags anything older than 10 minutes.

### Stock at the till (slice 4)

The till shows no stock (unchanged); the reservation at Pay is the stock check, and a refused line shows the
IMS's available quantity ("Only 2 left of …"). Back office reads `GET /api/availability` per item on demand. No
stock call per scan (latency and the IMS's 300 requests/minute per key).

### Offline / IMS unreachable

**Block the sale with a clear message** when a linked shop cannot reach the IMS: a timeout (5 s per call, 10 s
per sale), network error, 5xx, `429`, or the IMS's catch-all `409 conflict` refuses the sale with
"Can't reach the inventory system. The sale was not completed; try again." The cart and its idempotency key are
kept, so Retry is safe and reuses the same IMS keys. A rejected key answers "The inventory link needs attention —
ask the owner." There is no offline mode and no "sell anyway". Refunds and voids are queued, not blocked. The
catalog sync fails as a whole on an outage, keeps every product already applied, and the next run starts over.

## Slice 1 as built

- **Data:** migration `inventory_integration` — `InventorySource` enum, `Organization.inventorySource`,
  `InventoryLink` (one row per org: origin URL, sealed key + key id + last 4, check and sync status, a sync claim
  `syncLockedUntil`), `Product.externalProductId/externalVariantId/notSellableReason`,
  `ProductVariant.externalVariantId/notSellableReason`, partial unique indexes per org on each external id.
  Created with `--create-only` and trimmed (the generated `DROP INDEX "POItem_one_line_per_item"` removed).
- **Module:** `modules/integrations/inventory-sys` — `secret.ts` (AES-256-GCM), `client.ts` (the only IMS caller;
  answer classification per I17), `mapping.ts` (pure IMS product → POS shape), `sync.ts`, `link.ts`, `source.ts`
  (`inventorySourceOf`, `assertBuiltIn`: the one place other modules ask). Catalog rows are written by
  `modules/catalog/external.ts`, so only the catalog module writes catalog tables.
- **Routes:** `GET|PUT /api/integrations/inventory`, `POST …/check`, `PUT …/source`, `POST …/sync`.
- **Screen:** Settings → Inventory system (EN/AR): source, address + key (field always empty, "ends in …"),
  Save and test, Test connection, Switch (confirm dialog), Sync now with the last result. Catalog, Stock and
  Purchasing show a "managed in the inventory system" note and hide their write actions when linked.
- **Permissions:** new `integrations.manage` (Owner) for the link and the toggle; `settings.manage` (Owner, Admin)
  for the status and "Sync now". Denied attempts are audited.
- **Audit:** `integration.inventory.link_saved`, `.link_changed`, `.checked`, `.linked`, `.unlinked`,
  `.sync.completed`, `.sync.failed`, `.permission.denied`; catalog changes from a sync use the usual catalog
  actions with `metadata.source = "inventory-sync"`.
- **Config:** optional `INTEGRATION_ENCRYPTION_KEY` (base64, 32 bytes) and `INTEGRATION_ENCRYPTION_KEY_ID`
  (default `k1`). Without the key, linking is refused with a message; a POS-only deploy needs nothing new.

### Where slice 1 stops short of the spec (owner pre-approved "as recommended"; each lands in a later slice)

| Spec | Slice 1 | Why / when |
|---|---|---|
| I4 connection check | Checks the key reads products and stock. Write permissions (`sales.reserve`, `sales.fulfil`, …) and the currency match are not probed. | They cannot be probed without writing; slice 2 adds them (or IMS D3 `GET /api/me`). |
| I6 schedule | "Sync now" and the first sync at enable only. | The 15-minute run needs the scheduler route (slice 4, I19). |
| I7 shape change | A product that changed shape (variants ↔ none, or unit) is skipped and listed, not re-created. | Re-creating needs SKU renames on the old rows; rare; handled with slice 5. |
| I8 categories | Not synced; categories and a product's category stay **POS-owned** and editable when linked. | Keeps categories usable until category sync (slice 5). |
| I8 POS-owned fields in the UI | Arabic name, VAT category and category are editable through the API when linked, but the product form is read-only. | Small form change, with slice 5. |
| I9 not-sellable reason | Stored and enforced (`isActive = false`), not yet shown in the catalog list. | With the catalog form change. |
| I17 error codes | IMS failures in settings/sync answer `409` with `details.reason` (`INVENTORY_UNAVAILABLE`, `INVENTORY_LINK_BROKEN`, `INVENTORY_REJECTED`). | The till's `503 INVENTORY_UNAVAILABLE` needs a new code in `lib/errors.ts` (slice 2). |
| I18 sales | A linked shop's sales still write POS `SALE` movements (policy forced to "allow", so POS stock never blocks a sale); the POS ledger is history only. | Slice 2 replaces this with IMS posting and `recordMovements` refuses for linked shops. |
| I20 enable | Enable needs a passed check, no open shift, no open purchase order (draft, ordered or partly received); the first sync adopts POS items by SKU (ids and history kept) and archives POS-only items. Branch mapping and the dry run are not there yet. | Branch mapping with slice 2 (sales need it); dry run in slice 5. |
| I22 actor | Sync audit rows carry the user who pressed Sync / Switch. | The scheduler's runs (slice 4) will have no actor. |
| I3 URL | `https://`, or `http://` on `localhost` / `127.0.0.1` / `[::1]` (an IMS on the same machine), stored as the bare origin. | Spec allowed loopback http in development only; the same-host case is real in production too. |

## Tests (slice 1)

- Unit (`tests/unit/inventory-sys.test.ts`): seal/open round trip, wrong key and tampering fail; price
  conversion and rounding; mapping (simple, variant parent, no price, serialized, discontinued, other unit, kg,
  bad barcode); answer classification; settings error messages.
- Integration (`tests/integration/inventory-sys.test.ts`, IMS mocked with `tests/support/fake-ims.ts`): key never
  in a response or audit row; Owner-only link, Admin status; check results; open-shift refusal; first sync creates,
  adopts by SKU and archives POS-only items with no stock rows written; re-sync of price, barcode and removal with
  audit; outage releases the claim and audits the failure; tenant isolation; every refused write
  (`MANAGED_BY_INVENTORY`) and the POS-owned fields that stay editable; built-in shops unaffected; unlink.
- E2E (`tests/e2e/inventory-integration.spec.ts`, fake IMS on `E2E_PORT + 1`): an owner links a fresh shop,
  switches, syncs, and sees the read-only catalog and stock screens, in English and Arabic (RTL); Admin and
  Cashier access.
