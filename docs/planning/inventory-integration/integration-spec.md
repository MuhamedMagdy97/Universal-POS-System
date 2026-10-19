# Phase 13 — Inventory System Integration: Slices

The decisions live in [spec.md](spec.md) (I1–I23, approved 2026-10-19, every decision as recommended) and the
schema, routes and test plan in [data-model-and-api.md](data-model-and-api.md). This page cuts that work into
slices that each ship as one PR, records what slice 1 built, and where it deliberately stops short. "IMS" is the
inventory system at `D:/inventory sys` (read only, never modified from here).

## Ground rules (all slices)

- **Optional, per shop.** `Organization.inventorySource` is `BUILT_IN` (default) or `EXTERNAL`. A POS-only shop
  sees no change: built-in stock, purchasing and transfers keep working, and nothing in the POS depends on the IMS
  being installed or reachable (I1).
- **IMS is master when linked.** Products, variants, barcodes, prices and categories sync **down** and are read-only
  in the POS.
  The POS never pushes catalog changes up (out of scope).
- **Stock quantities are never copied into POS stock tables.** Stock is read from the IMS on demand (slice 4) and
  taken in the IMS by sale posting (slice 2).
- **The API key is write-only.** AES-256-GCM sealed under `INTEGRATION_ENCRYPTION_KEY`, decrypted per call on the
  server, never returned, logged or audited (I3).

## Slices

| Slice | Scope | Spec | Status |
|---|---|---|---|
| 1 | Toggle, link settings, connection check, catalog sync (pull, "Sync now"), read-only guards | I1–I4, I6–I11, I18, I22 (part) | **Built** (PR #34) |
| 2 | Sale posting: branch → warehouse map, reserve before / fulfil after, outbox, till messages; **also** refunds and voids (slice 3), stock at the till and the retry route (part of slice 4) | I5, I12–I15, I16 (till), I17, I19 (part) | **Built** (PR #36) |
| 3 | Refunds and voids as IMS sales returns / cancels, queued | I14, I15 | Built with slice 2 |
| 4 | The 15-minute sync in the scheduler route, the 10-minute flag, the postings list and Retry, posting audit; stock on the item page deferred | I19, I22 (I16 deferred) | **Built** (slice 4 PR) |
| 5 | Guided enable for an existing shop: dry run, CSV of POS on-hand | I20 | |
| 6 | Secrets sweep, perf (5 000 products, 10-line sale), manual run against the real IMS | R3, R4, I23 | |
| — | Category sync: the IMS category tree and each product's category, read-only when linked | I8 (categories) | **Built** (category sync PR) |

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
| I8 categories | Not synced; categories and a product's category stay **POS-owned** and editable when linked. | Superseded by category sync (below). |
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

## Slice 2 as built (2026-10-19)

Sale posting, refunds and voids (slices 2 and 3), stock at the till, and the retry route. Built-in shops are
unchanged: every new path runs only when `inventorySource = EXTERNAL`.

- **Data:** migration `inventory_sale_posting` — enums `PostingKind` (`FULFIL`, `CANCEL`, `RETURN`) and
  `PostingStatus`, table `ExternalStockPosting` (the outbox: kind, source, line, qty, idempotency key, IMS
  reservation id + version, order ref, return id, status, attempts, `nextAttemptAt`, last IMS code; unique per org
  and key), `Branch.externalWarehouseId` with a partial unique index per org. Created with `--create-only`, the
  generated `DROP INDEX "POItem_one_line_per_item"` removed.
- **Module:** `modules/integrations/inventory-sys/postings.ts` — `reserveSale`, `releaseSale`,
  `recordSaleFulfils`, `recordRefundReturn`, `recordVoidReturn`, `postAfterCommit`, `drainPostings`,
  `availableAtBranch`. `client.ts` gained `imsPost` (`Idempotency-Key` header; the IMS `code` and
  `details.available` / `details.status` are kept, never the body). The catalog seam gained
  `externalVariantIdsOf`.
- **Sale** (`modules/sales/create.ts`): replay by key first (a replay of a linked sale also sends any fulfil left
  unsent); then shift open, items sellable, branch mapped, every item linked — all before any IMS call; reserve all
  merged lines (4 at a time, 5 s per call, 10 s per sale); commit with no POS movements, the `FULFIL` rows and the
  reservation ids in `sale.created`; fulfil after commit (2 s budget, the rest stays `PENDING`). A transaction that
  fails after reserving releases the holds, unless a concurrent request with the same key committed (it holds the
  same reservations).
- **Refund / void** (`modules/sales/refunds.ts`): no POS movements; one `RETURN` row in the transaction, sent after
  commit. A refund's return lists the refunded lines' reservations (`pos_refund`, "POS refund of sale 000123"); it
  waits while the sale has a `PENDING` fulfil. A void: each fulfil not yet sent is turned into a cancel of its hold
  (`pos:sale:{saleId}:void:{n}`), and one return (`pos_void`) takes back the lines already fulfilled.
- **Second guard:** `recordMovements` refuses for a linked shop (`MANAGED_BY_INVENTORY`).
- **Errors:** new code `INVENTORY_UNAVAILABLE` (503) in `lib/errors.ts`; reasons `INVENTORY_LINK_BROKEN` (409),
  `INVENTORY_BRANCH_UNMAPPED` (409), `INVENTORY_REJECTED` (409); short stock is the existing `409
  INSUFFICIENT_STOCK` with the IMS's available quantity as `lines[].onHand`; an archived, discontinued or missing
  IMS item is `422 ITEM_NOT_SELLABLE`. The till shows the three new EN/AR messages and keeps the sale key after
  `INVENTORY_UNAVAILABLE`, so Retry reuses the IMS keys.
- **Branch map:** `GET|PUT /api/integrations/inventory/branches` and a table on Settings → Inventory system (shown
  once the connection check passed): each active branch → one active IMS warehouse (`GET /api/warehouses`), never
  two on one; Owner changes it, audited `integration.inventory.branch_mapped`. The status shows postings waiting
  and refused.
- **Retries:** `POST /api/internal/inventory/run` (header `x-cron-secret`, constant-time compare, 404 while the
  optional `CRON_SECRET` is unset, no session) drains due postings of every linked shop; "Sync now" drains the
  shop's postings first. Backoff 1, 2, 5, 15, 30, 60 min; an IMS refusal (4xx other than the I17 outage answers)
  marks the row `FAILED`.
- **Unlink** (`PUT …/source` to `BUILT_IN`) is refused with `PENDING_POSTINGS` while any posting is pending (I21).

### Where slice 2 departs from the spec (owner pre-approved "as recommended")

| Spec | As built | Why |
|---|---|---|
| Task brief: "post sales to `POST /api/pos-sales`" | Reservations, as I12 decided. | `pos-sales` is one IMS transaction per line; I12 rejected it. |
| I13 keys `pos:{saleKey}:r:{n}` | `pos:{saleKey}:{attempt}:r:{n}` (and `:f:`, `:cancel`); `externalOrderId` = `sha256(saleKey)[0:32]:{attempt}`. | A refused sale cancels its holds; a retry with the same till key would otherwise replay the cancelled reservations and commit a sale whose fulfils can never succeed. The attempt is the count of `SaleAttempt` cancel rows for that key, so a crash before commit (no row) still replays the same holds (R2). The hash keeps `externalOrderId` within the IMS's 100 characters. |
| I16 "the till shows no stock" | The till shows the IMS's **available** quantity at the branch's warehouse (`GET /api/availability`, 4 at a time, 3 s, per scan); unknown (unmapped, unlinked item, IMS down) shows nothing. | Asked for in the slice-2 brief. `/api/availability` is not under the IMS's 300/min limit (that covers `/api/reservations` and `/api/pos-sales`). |
| I19 | The route drains postings only; the 15-minute catalog sync and the "older than 10 minutes" flag are not in it yet. | Slice 4. The status page shows the pending and refused counts. |
| I22 `.posting.failed` / `.posting.resolved` audit | Not written; `lastErrorCode` and the status counts carry it. | With the postings list and Retry button (slice 4). |
| I4 write permissions | Still not probed; a key without `sales.reserve` answers `INVENTORY_LINK_BROKEN` at the first sale. | IMS D3 (`GET /api/me`). |
| Holds of an attempt whose every reserve timed out | Not cancelled (no order id is known); they expire after the IMS's `pos` TTL (900 s). | Rare; the stock is held, never sold. |
| A refunded line whose fulfil `FAILED` | Left out of the IMS return. | Nothing of it was taken in the IMS. |

### Tests (slice 2)

- Integration (`tests/integration/inventory-sale-posting.test.ts`, fake IMS with reservations, fulfil, cancel,
  order cancel, sales returns, availability, warehouses and the IMS's idempotency rule): a 3-line sale reserves,
  commits with no POS stock rows, fulfils once, replays with no new IMS call; crash between reserve and commit then
  retry holds nothing twice; a short line refuses the whole sale with the IMS's quantity, cancels the others, and
  the same cart and key sell on retry with fresh holds; outage (network, 503, the IMS's `409 conflict` on one line)
  → 503 and the other line's hold cancelled; refused key and unmapped branch; a failing transaction releases the
  holds; a failed fulfil stays `PENDING` and drains later; `recordMovements` refuses; refund → return, refund
  during an outage → queued then sent, refund before fulfil → waits; void of a fulfilled sale → return, of an
  unfulfilled one → holds cancelled; till availability and its outage; branch map access, unknown and shared
  warehouses, swap; unlink refused with pending postings; scheduler route secret and drain.
- Unit: the till's new messages and key keeping.
- E2E (`tests/e2e/inventory-sale.spec.ts`, fake IMS on `E2E_PORT + 2`): an owner links a fresh shop, maps its
  branch, switches, sees the IMS stock at the till and sells; in Arabic (RTL) the IMS stops, the sale is refused
  with the outage message, and Retry sells once it is back.

## Slice 4 as built (2026-10-19)

The scheduled catalog sync, the "older than 10 minutes" flag, the postings list with Retry, and the posting
audit. No migration. Built-in shops are unchanged: the scheduler only looks at links of `EXTERNAL` shops, and the
postings list only shows once a link is saved.

- **Scheduler** (`POST /api/internal/inventory/run`, `runInventorySchedule` in `link.ts`): drains due postings
  as before, then syncs the catalog of every linked shop whose `lastSyncStartedAt` is null or over 15 minutes old
  (I6, I19), oldest first, one shop after another. The per-org claim (`syncLockedUntil`) still applies: a shop
  whose "Sync now" is running is skipped (not counted as failed). A failed sync is recorded and audited as for
  "Sync now"; the claim sets `lastSyncStartedAt`, so the shop is retried 15 minutes later. Answers
  `{ sent, synced, failed, stale }`.
- **No actor** (I22): `AuditActor.userId` may be null; scheduled syncs and drain audits write `actorUserId = null`.
- **10-minute flag** (I19, R1): a posting `PENDING` with `createdAt` over 10 minutes ago is *stale*. The status
  carries `postings.stale` and Settings → Inventory system shows an alert line; the list marks each such row.
- **Postings list** (Settings → Inventory system, EN/AR; `GET /api/integrations/inventory/postings?page=N`):
  `PENDING` and `FAILED` postings of the shop, oldest first, 20 a page — kind, the sale (or "refund of sale …", or
  "a sale that was not completed" for a refused sale's cancel), status, attempts, last IMS code, next attempt in the
  shop's timezone. `settings.manage` (Owner, Admin), tenant-scoped (another shop's id answers 404).
- **Retry** (`POST /api/integrations/inventory/postings/{id}/retry`, `settings.manage`): a `FAILED` or waiting
  posting becomes `PENDING` due now (attempts kept), audited `integration.inventory.posting.retried` with the
  person, then the shop's due postings are drained (10 s budget); answers the posting's status afterwards.
- **Audit** (I22): `.posting.failed` when its first retry failed too (`attempts = 2`), or at
  once when the IMS refused it for good (`FAILED` on the first attempt); metadata: kind, source, line, attempts,
  IMS code, status. `.posting.resolved` when a posting that had failed is sent.
- **I4 write permissions:** the IMS (`D:/inventory sys`, read only) has **no** `GET /api/me` or other "who am I"
  route for an API key (only `/api/auth/[...all]`, Better-Auth sessions). The check stays as slice 1 built it;
  probing writes would hold or move stock. Needs IMS D3.

### Where slice 4 departs from the spec (owner pre-approved "as recommended")

| Spec | As built | Why |
|---|---|---|
| I16 stock on the back-office item page | Not built. | The slice-4 brief named the scheduler, the postings list and the I4 probe; the till already shows IMS stock (slice 2). |
| I19 "flagged on … the dashboard" | Flagged on Settings → Inventory system (status line and list) and in the scheduler's answer; not on the dashboard. | One place to act on it (Retry is there). |
| I22 `.posting.failed` "after the first retry" | Also at once for a permanent refusal (`422`/`404`), which never retries. | A refused posting waits for a person; the audit says so straight away. |
| I22 `.posting.resolved` | Written for any posting sent after a failure, including one that failed only once (no `.posting.failed` before it). | Keeps the rule on the row alone (no flag column). |
| Retry permission | `settings.manage` (Owner, Admin); also a new `integration.inventory.posting.retried` audit. | Spec: Owner/Admin act on the status page; the person who pressed Retry is recorded. |
| Scheduler shops | Synced one after another in one run. | A slow IMS delays the next shop to the next minute's run; parallel runs if many linked shops share a deploy. |
| I4 write permissions | Not probed. | No `GET /api/me` in the IMS (D3). |

### Tests (slice 4)

- Integration (in `tests/integration/inventory-sale-posting.test.ts`, fake IMS): the scheduler syncs a shop only
  when its last sync is over 15 minutes old, with no actor, and not again at once; skips a claimed shop; records an
  outage as a failed sync; the stale count in the status, list and scheduler answer; `.posting.failed` once after
  the first retry fails and `.posting.resolved` once sent; a `422`-refused fulfil is listed with its sale number,
  Owner/Admin retry it (refused again stays `FAILED`; accepted → `DONE`, IMS stock taken), cashiers get 403,
  another shop 404; paging 20 at a time.
- Unit: an audit row with no actor.
- E2E (`tests/e2e/inventory-postings.spec.ts`, fake IMS on `E2E_PORT + 3`): a linked shop sells while the IMS
  refuses the fulfil; the refused posting is listed with the sale number; in Arabic (RTL) Retry sends it, the IMS
  stock drops and the list empties.

## Category sync as built (2026-10-19)

Categories now come from the IMS for a linked shop; built-in shops are unchanged (every new path runs only from the
sync, and the guards only refuse when `inventorySource = EXTERNAL`).

- **IMS side** (`D:/inventory sys`, read only): `GET /api/categories?includeArchived=true` answers
  `{ items }`, a flat list in tree order (`path`) with `id`, `parentId`, `name` (1–100 characters, no `/`),
  `depth` (1–5), `sort`, `archived`; it needs `products.view`, which the sync key already has. The product detail
  (`GET /api/products/{id}`) carries `categoryId`. Sibling names are unique per parent, case-**sensitive**.
- **Data:** migration `inventory_category_sync` — `Category.externalCategoryId` with a partial unique index per org.
  Created with `--create-only`, the generated `DROP INDEX "POItem_one_line_per_item"` removed.
- **Sync** (`sync.ts` → `syncCategories`, writes in `modules/catalog/external.ts`): before the products, read the
  whole tree (archived included), map it (`mapImsCategories`, pure), apply parents first, one category per
  transaction: the linked row, else an unlinked POS category with the same name (case-insensitive) under the same
  parent is **adopted** (keeps its id), else created. Name, parent, sort order and archived state follow the IMS.
  Then every active POS category not linked to a listed IMS category (removed there, or POS-only and not adopted)
  is archived. Each product's `categoryId` follows its IMS `categoryId` (none or unknown → no category), including
  products adopted by SKU. Audit: the usual `catalog.category.created|updated|archived|restored` and
  `catalog.product.updated` (`changes.categoryId`) with `metadata.source = "inventory-sync"`. The summary gains
  `categories: { listed, created, updated, unchanged, archived }`.
- **Guards:** `createCategory`, `updateCategory`, `archiveCategory`, `restoreCategory` answer
  `409 MANAGED_BY_INVENTORY` for a linked shop; a product's `categoryId` joined the synced fields
  (`syncedProductChanges`), so changing it answers `409 MANAGED_BY_INVENTORY` with `fields: ["categoryId"]`.
- **Screen:** Catalog → Categories shows "Categories are managed in the inventory system." (EN/AR) and hides add,
  rename and archive (they already followed `can.create` / `can.update`, which are off when linked).

### Where category sync departs from the spec (owner pre-approved "as recommended")

| Spec | As built | Why |
|---|---|---|
| I8 Arabic category name | The category's Arabic name stays as it was but cannot be edited while linked (all category writes refused). | The task refuses rename; the categories screen hides edits when linked. A nameAr-only edit can be allowed later like products' POS-owned fields. |
| Depth | The IMS nests 5 levels, the POS 3: an IMS category at level 4 or 5 is not created; it and its products fold into its level-3 ancestor (note `CATEGORY_FOLDED:{id}`). | Keeps the POS's depth rule; no product loses its category. |
| Name clash | The IMS allows `Snacks` and `snacks` as siblings, the POS does not: the second (in the IMS's order) is skipped (`CATEGORY_NAME_TAKEN`), its products have no category, and its children become roots. A rename that would clash with a sibling (for example two categories swapping names) is skipped the same way until it no longer clashes. | One category per transaction; never blocks the product sync. |
| Product sort/filter | Unchanged: the till and catalog filters read POS categories, now the synced ones. | — |

### Tests (category sync)

- Unit (`tests/unit/inventory-sys.test.ts`): `mapImsCategories` keeps three levels, folds deeper ones, orders
  parents first, treats an unknown parent as a root; the product mapping carries `categoryId`.
- Integration (`tests/integration/inventory-sys.test.ts`, fake IMS now serves `GET /api/categories`): first sync
  builds the tree, adopts by name, folds levels 4–5, keeps archived IMS categories archived, archives POS-only
  ones and files products (an adopted product loses its POS category); re-sync renames, moves, archives and
  restores with audit and re-files products; a sibling-name clash is skipped; category writes and a product's
  category change are refused when linked, a built-in shop still creates categories.
- E2E (`tests/e2e/inventory-integration.spec.ts`): after the first sync the categories screen lists the synced
  category with the managed notice and no add/rename buttons, in English and Arabic (RTL).
