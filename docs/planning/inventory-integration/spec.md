# Phase 13 — Inventory System Integration: Specification

Status: **Approved by the owner (2026-10-19), every decision as recommended**, including the five marked
**Owner: confirm** (each takes its recommended option, not the alternative). Not built. Data model and API: [data-model-and-api.md](data-model-and-api.md).

Source: the agreement of 2026-10-19 (the inventory system is master when both are used; products are sold alone or
bundled, so the link is a per-tenant toggle), the as-built POS modules (`modules/catalog`, `modules/inventory`,
`modules/sales`, `modules/purchasing`, `modules/audit`), and the inventory system's code at `D:/inventory sys`
(commit `d412a6b`), read only: `src/app/api/**`, `src/server/auth/session-ctx.ts`, `src/server/core/execute.ts`,
`src/server/inventory/reservations.ts`, `src/server/inventory/availability.ts`, `src/server/catalog/catalog.ts`,
`src/server/returns/sales-returns.ts`, `src/server/webhooks/webhooks.ts`, `src/proxy.ts`,
`docs/inventory/02-operations/12-sales-integration.md` and `docs/inventory/04-delivery/24-api-requirements.md`.
Below, "IMS" is the inventory system.

## 1. Key facts

**POS today**

- **Catalog.** `Product` (SKU, name, `nameAr`, `priceMinor`, `costMinor`, `vatCategory`, `unitType`, `hasVariants`,
  `isActive`), `ProductVariant` (price and cost `null` = inherit), `Barcode` (unique per org, one primary per item),
  `Category` tree. Other modules read it only through `modules/catalog/seam.ts` (`lookupCode`, `searchSellable`,
  `getSellableItems`, `getItemsForHistory`, `assertStockable`, `lockProducts`) and write cost through
  `applyReceivedCosts`.
- **Stock.** An append-only `InventoryMovement` ledger with a `StockBalance` cache per branch, written only through
  `recordMovements` (`modules/inventory/ledger.ts`). `Organization.blockNegativeStock` decides whether a sale may go
  below zero.
- **Sale.** `createSale` (`modules/sales/create.ts`) replays by `Idempotency-Key` + `requestHash`, then in **one
  database transaction**: locks the shift, bumps `Organization.lastSaleNo`, prices lines from `getSellableItems`,
  writes `SALE` movements (`policy: block|allow`), the sale, its items (with the P12 cost snapshot), payments and the
  `sale.created` audit row. Lines with the same item are merged first (`mergeLines`).
- **Refund and void.** `refundSale` (idempotent, `REFUND` movements back into stock) and `voidSale` (open shift only,
  no refunds yet, `SALE_VOID` movements) in `modules/sales/refunds.ts`.
- **The till shows no stock.** It only explains a refused sale: `INSUFFICIENT_STOCK` names the short lines
  (`app/(app)/pos/_lib/till.ts`).
- **No background worker.** Everything runs inside requests. Secrets come from environment variables
  (`lib/config.ts`: `DATABASE_URL`, `AUTH_SECRET`); nothing in the database is encrypted yet.
- **Purchasing** (T5) and **transfers, adjustments, opening stock** (T4) all write the POS ledger.

**IMS (what it really offers today)**

- **Auth.** `x-api-key` header. The key must belong to a *service user*; its roles give the permissions and its
  `salesChannel` (`pos`) is the channel of every request (`requestCtx`). Permissions are re-read on every request, so
  revoking the key or a role takes effect at once. Errors are `{ code, message, details, trace_id }`.
- **Everything sellable is a variant.** `Product` (`type` `simple` | `variant_parent`, `status`
  `draft|active|inactive|discontinued|archived`, `isSerialized`, `requiresBatch`, `baseUom`) has `ProductVariant`s
  (`sku` upper case and unique, one `barcode` unique per company, `name` optional, `sellPrice` / `costPrice`
  `Decimal(18,4)` and nullable, `status`, `version`, `updatedAt`), plus `SkuAlias` (retired SKUs) and `BarcodeAlias`
  (old barcodes until `expiresAt`). No Arabic name, no VAT category. `Company.currency` is a free string.
- **Catalog reads.** `GET /api/products?page&per_page≤200&status` (archived hidden unless `status=archived`; variants
  carry only `id, sku, name, status, barcode` — no prices, no `updatedAt`; no changed-since filter).
  `GET /api/products/{id}` returns the variants with prices, aliases and batches. `POST /api/products/lookup`
  resolves up to 200 codes. **No catalog webhooks**: the only events are `stock.low`, `stock.out`,
  `reservation.expired`, `po.approved`, `transfer.received`.
- **Selling.** `POST /api/pos-sales` sells **one variant from one warehouse per call** (reserve + fulfil in one IMS
  transaction, `Idempotency-Key` required, no partials, needs `sales.reserve` + `sales.fulfil`). There is no
  multi-line sale call. The two-step form is `POST /api/reservations` (atomic `available ≥ qty` check, TTL; `pos`
  default 900 s, `externalOrderId` groups reservations under one order) then
  `POST /api/reservations/{id}/fulfil|cancel|release|extend` (version-checked, idempotent), and
  `POST /api/sales-orders/{id}/cancel` releases every open reservation of an order. Short stock answers
  `409 insufficient_stock` with `details.available`.
- **Idempotency** (`execute`): per company and key, the response is stored in the same transaction; a replay with the
  same body returns it byte for byte; another body answers `409 conflict`.
- **Returns.** `POST /api/sales-returns` (`sales.return_create`) against **reservation ids** (the fulfilled order
  lines) creates a return in `requested`. It then needs `approve` by **a different user** (`requireNotCreator`),
  `receive` (into the warehouse's quarantine bin), and inspection before stock is restocked. A fulfilled reservation
  cannot be undone any other way.
- **Stock reads.** `GET /api/availability?variantId&warehouseId` (on hand, reserved, available, per batch);
  `GET /api/balances` (physical buckets per bin, paged).
- **Limits.** 300 requests per minute per API key on `/api/reservations` and `/api/pos-sales`, 600 on
  `/api/products/lookup` (`src/proxy.ts`). An unexpected IMS error answers **`409 conflict` "Unexpected error"**, not
  a 5xx.
- **Quantities** are decimals with up to 4 places; the POS sells whole units only.

## 2. Goal and success

A shop that also uses the IMS switches its POS to "inventory: IMS". From then on its products, variants, barcodes and
prices come from the IMS and cannot be edited in the POS; each sale checks and takes stock in the IMS at the moment
of payment and never twice; refunds and voids send the goods back to the IMS as returns; the till refuses to sell
when the IMS cannot be reached and says so. A shop that does not use the IMS sees no change at all: built-in stock,
purchasing and transfers keep working.

Out of scope: pushing POS-made products to the IMS, selling serialized items (serial capture at the till), choosing a
batch at the till, offline selling, multi-currency, more than one IMS per shop, a stock screen on the till, and
changes to the IMS itself (needed IMS changes are listed in §6 as dependencies for a separate IMS task).

## 3. Decisions

| # | Topic | Decision |
|---|---|---|
| I1 | The toggle | `Organization.inventorySource` = **`BUILT_IN`** (default, today's behaviour) or **`EXTERNAL`**. Every module that writes stock, catalog or purchasing checks it at one seam (`modules/integrations` → `inventorySourceOf(tx, orgId)`), never by reading settings ad hoc. Switching is a guarded flow (I20), never a plain field edit. **(rec)** |
| I2 | Who may link | A new permission **`integrations.manage`**, Owner only (linking changes where stock and prices live). Admin can see the status page (`settings.manage`) but not change the link or the key. Alternative: give it to Admin too. **Owner: confirm.** |
| I3 | Where the key lives | Table `InventoryLink` (one row per org): IMS base URL (https only, except `localhost` in development), the API key **encrypted with AES-256-GCM** under a new server secret `INTEGRATION_ENCRYPTION_KEY` (32 bytes, base64, in the environment like `AUTH_SECRET`; key id stored for rotation), and the last 4 characters for display. The key is **write-only**: never returned by any API, never sent to the browser, never logged, never put in audit metadata or error details. Decrypted only in the server-side IMS client, per call. **(rec)** |
| I4 | Connection check | "Test connection" (and every link or key change) calls the IMS with the key and must find: the key accepted, the service user's channel is `pos`, the permissions `products.view`, `sales.reserve`, `sales.fulfil`, `sales.cancel`, `sales.return_create` and `inventory.view` (or `sales.view`), and `Company.currency` equal to the org's currency (EGP/SAR). Anything else is shown in plain words and the link cannot be enabled. Answered by reading an IMS route per permission (§6 D3 asks the IMS for a "who am I" route). **(rec)** |
| I5 | Branches and warehouses | Each **active** POS branch maps to exactly one active IMS warehouse; two branches may not share one. Enabling needs every active branch mapped. A branch created later cannot sell until it is mapped (`INVENTORY_BRANCH_UNMAPPED`, shown on the till). Stored on `Branch.externalWarehouseId`. **(rec)** |
| I6 | Catalog sync: pull or webhook | **Pull.** The IMS emits no catalog events, so webhooks cannot carry catalog changes today. A sync lists every product (`GET /api/products`, 200 per page, plus `status=archived`) and reads each one (`GET /api/products/{id}`) for prices and aliases. It runs **every 15 minutes** from a scheduled call (I19), on **"Sync now"** (Owner, Admin), and once at enable. One sync per org at a time (advisory lock). Alternative: catalog webhooks — needs IMS work (§6 D1). **(rec)** |
| I7 | Mapping ids | The IMS **variant id** is the sellable id. An IMS `simple` product with one variant becomes a POS product **without** variants (`Product.externalVariantId`); a `variant_parent` product becomes a POS product **with** variants, one per IMS variant (`ProductVariant.externalVariantId`). `Product.externalProductId` keeps the IMS product id. Each external id is unique per org. POS ids never change, so sales history and reports keep working. A product that changes shape in the IMS (simple ↔ variant parent) is re-created: the old POS product is archived and a new one made (the POS refuses variant switches on items with history). **(rec)** |
| I8 | Field mapping | IMS wins for: SKU, name, barcode (primary) and live barcode aliases (extra `Barcode` rows), sell price, cost price, status, category (by path; categories synced with `Category.externalId`), unit (`each` → EACH, `kg` → KG, anything else EACH and flagged). Money: `round(decimal × 100)` minor units (EGP and SAR have 2 decimals); a sell price with more than 2 decimals is rounded half up and flagged. The IMS sell price is read as the **shelf price**, so the org's `pricesIncludeVat` keeps applying. **POS-owned** (editable in the POS when linked, kept across syncs): Arabic name, VAT category, variant sort order. **Owner: confirm the sell price includes VAT the same way as today's POS prices.** |
| I9 | What cannot be sold | Not sellable in the POS (synced, `isActive = false`, reason shown in the catalog): IMS status other than `active` (draft, inactive, discontinued, archived — the IMS refuses new reservations for all of them), **no sell price**, **serialized** products (the till cannot capture serials), units other than each and kg. Batch-tracked items **are** sellable: the IMS picks the batch (FEFO). **(rec)** |
| I10 | Archived and removed items | An IMS product or variant archived, or missing from the list, is **archived** in the POS, never deleted (sales history points at it). It comes back to life if the IMS reactivates it. Its barcodes stay on the archived row, so the till says "archived — not for sale", not "unknown". **(rec)** |
| I11 | Conflicts | The IMS is master, so a synced field is simply overwritten. Only uniqueness can clash: an incoming SKU or barcode already used by a **different** POS row. Rule: a row linked to the IMS always wins over an unlinked row (the unlinked row is archived and loses that barcode, audited); between two linked rows the IMS has already made it unique, so a clash means a stale row — the stale row is fixed first in the same sync. Anything still unresolved is skipped, listed on the status page and in the sync audit row; the rest of the sync goes on. **(rec)** |
| I12 | How a sale posts | **Reserve before, fulfil after.** Never call the IMS inside a POS database transaction (it would hold the shift and org locks during network calls). (1) Validate the sale without writing (shift open, items sellable, payments add up). (2) For each merged line, `POST /api/reservations` with the branch's warehouse, `externalOrderId` = the POS sale's idempotency key, and an idempotency key derived from it (§ data model 3). Lines run with up to 4 in parallel. (3) If any line is refused or fails: cancel the reservations already made (`sales-orders/{id}/cancel`) and refuse the sale — nothing was written in the POS. (4) Commit the POS sale exactly as today **without** POS stock movements, plus one `ExternalStockPosting` row per line holding the reservation id and version. (5) Right after commit, fulfil each reservation (`POST /api/reservations/{id}/fulfil`, idempotent). A fulfil that fails is retried by I19 until it succeeds; the stock is already held by the reservation, so the receipt is never wrong. Alternative: `POST /api/pos-sales` per line — rejected: one IMS transaction per line, and a failure on line 3 leaves lines 1–2 sold in the IMS with no clean undo (only a sales return that needs a second person's approval). **(rec)** |
| I13 | Idempotency | Every IMS call carries a key derived from the POS document key: `pos:{saleKey}:r:{lineNo}` for reserve, `pos:{saleKey}:f:{lineNo}` for fulfil, `pos:{refundKey}:ret` for a refund's return, `pos:sale:{saleId}:void` for a void. A till retry after a crash replays the same reservations (the IMS answers from its idempotency record), so stock is never held twice. Reservations of a sale that was never committed and never retried expire on their own after the IMS's `pos` TTL (900 s). The POS sale keeps its own `Idempotency-Key` + `requestHash` replay unchanged. **(rec)** |
| I14 | Refunds | A POS refund pays the customer at once as today (no POS stock movement) and **queues** an IMS sales return: `POST /api/sales-returns` with reason `pos_refund`, the POS refund number in the note, one line per refunded item (reservation id + qty). The return lands in `requested`; IMS staff approve, receive into quarantine and inspect it as for any customer return (the IMS needs a second person to approve). The refund is **not blocked** when the IMS is down: the return is retried by I19. Alternative: block refunds like sales. **Owner: confirm refunds are queued, not blocked.** |
| I15 | Voids | A void (open shift, no refunds, as today) needs the IMS too: if a sale line's reservation is **not yet fulfilled** it is cancelled; if fulfilled, the line goes into one IMS sales return with reason `pos_void`. Queued like I14, never blocked. **(rec)** |
| I16 | Stock on the till | **Unchanged: the till shows no stock.** The reservation at Pay is the stock check. A refused line shows the IMS's available quantity: "Only 2 left of Cola 330 ml". No stock call per scan (latency, the 300/min limit shared by all tills). Back office, when linked: the Stock screen shows each item's **available** quantity per branch from `GET /api/availability` (on demand, one item at a time on the item page; the list page shows a note and a link to the IMS). Alternative: an "available" figure next to each cart line. **(rec)** |
| I17 | IMS unreachable | **Block the sale.** A timeout (5 s per call, 10 s per sale), a network error, a 5xx, a `429`, or the IMS's catch-all `409 conflict` "Unexpected error" refuses the sale with `503 INVENTORY_UNAVAILABLE`: "Can't reach the inventory system. The sale was not completed; try again." The cart and its idempotency key stay, so Retry is safe. A rejected key (`403`) answers `INVENTORY_LINK_BROKEN`: "The inventory link needs attention — ask the owner." No offline mode and no "sell anyway" button. Refunds and voids are queued (I14, I15). **(rec — the POS is online-only)** |
| I18 | Read-only when linked | Refused with `409 MANAGED_BY_INVENTORY` (and hidden or disabled on screen): creating, editing, archiving and restoring products, variants and barcodes (except the POS-owned fields of I8), categories, opening stock, adjustments, transfers, suppliers, purchase orders and receiving. `blockNegativeStock` is ignored (the IMS never goes below zero). Kept: reports (sales, VAT, shifts, profit from the synced cost), past purchase orders and the POS ledger as read-only history. **(rec)** |
| I19 | Retries and the schedule | One protected route `POST /api/internal/inventory/run`, called **every minute** by the host scheduler with a `CRON_SECRET` header (the POS has no worker). Each run: posts pending fulfils, cancels, returns (oldest first, backoff 1, 2, 5, 15, 30, 60 min, capped), and starts a catalog sync when 15 minutes have passed. A posting that keeps failing for 10 minutes — or any fulfil older than 10 minutes, since the reservation expires at 15 — is flagged on the status page and the dashboard (Owner, Admin). Permanent errors (`422`, `404`) stop retrying and wait for a person. **(rec)** |
| I20 | Linking an existing shop | Guided, in order, refused if a step is not met: (1) URL + key, connection check (I4). (2) No open shifts and no open purchase orders (draft or ordered). (3) Map branches (I5). (4) **Dry run**: match POS items to IMS variants by SKU, then barcode; show matched, POS only, IMS only and conflicts; download the POS on-hand per branch as CSV for the IMS's own import. (5) Enable: matched POS rows get their external ids (ids kept, so history stays linked), POS-only rows are archived, IMS-only items are created, first sync runs. POS stock is **not** pushed to the IMS and IMS quantities are **never** copied into POS stock tables. **Owner: confirm POS-only items are archived, not kept as local items.** |
| I21 | Unlinking | Allowed to `integrations.manage`, with no open shifts and no pending postings. The POS goes back to built-in: catalog editable, external ids kept (so a re-link re-matches), and the POS stock is what it was at linking time — the screen says so and asks for a stock count (opening or adjustments). **(rec)** |
| I22 | Audit | New actions: `integration.inventory.linked`, `.unlinked`, `.key_changed`, `.branch_mapped`, `.permission.denied`, `.sync.completed` (counts: created, updated, archived, skipped), `.sync.failed`, `.posting.failed` (after the first retry) and `.posting.resolved`. Catalog changes from a sync write the existing catalog actions (`catalog.product.price_changed`, archived, restored) with `actorUserId = null` and `metadata.source = "inventory-sync"`. `sale.created`, `refund.create` and `sale.void` gain the IMS reservation and return ids. The key, the IMS URL's query string and IMS error bodies are never written to audit. **(rec)** |
| I23 | Sync performance | A full sync of 5 000 products (5 000 + 26 list calls) finishes in under 5 minutes against the IMS on the same network, writes only rows that changed, and holds no POS lock across HTTP calls (each product is applied in its own short transaction). A sync never blocks selling. **(rec)** |

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A sale is charged but the IMS never takes the stock (fulfil lost). | The fulfil is a stored `ExternalStockPosting` row written in the sale's transaction; I19 retries it; the reservation already holds the stock; the status page flags any fulfil older than 10 minutes, before the 15-minute reservation expiry. |
| R2 | Stock held twice on a retry or double click. | I13 keys derived from the sale's own key; integration test replays a sale after reservations were made but before commit. |
| R3 | The API key leaks. | I3: encrypted at rest, write-only, never in a response, log, audit row or client bundle; a test greps every response, log line and audit row of a full flow for the key. |
| R4 | The IMS is slow and the queue at the till grows. | I17 timeouts; lines reserved in parallel; perf check (§ data model 7) with 10 lines under 2 s on a LAN IMS. |
| R5 | The 300 requests/min limit per key is reached in a rush (all tills share one key; one call per line plus one fulfil per line). | Count it in the perf check; a `429` refuses the sale with I17's message rather than queueing; §6 D2 asks the IMS for a multi-line reserve. Document: about 150 lines per minute per shop. |
| R6 | Price on the shelf differs from the till during the 15 minutes before the next sync. | "Sync now" after a price change; §6 D1 (webhooks or changed-since) shortens it. Accepted. |
| R7 | Refunded goods are not back in IMS stock until IMS staff approve and receive the return. | Intended by the IMS (quarantine, inspection). The status page lists returns still `requested`. §6 D4 asks for a POS fast path. |
| R8 | A linked shop's POS ledger and IMS disagree and someone trusts the POS stock screen. | I18 makes POS stock read-only history and the screen says stock lives in the IMS. |
| R9 | `migrate dev` drops `POItem_one_line_per_item`. | `--create-only` and trim, as always. |
| R10 | The IMS answers an unknown failure as `409 conflict`, which looks like a business error. | I17 treats `conflict` without a known `details.reason` as unavailable; tests cover it. |

## 5. Acceptance

1. A POS-only shop (`BUILT_IN`) behaves exactly as before: the full existing test suite passes unchanged.
2. An owner links a shop: the connection check names a missing permission; after fixing it, mapping, dry run and
   enable complete; matched items keep their ids and their sales history.
3. A product created, repriced, re-barcoded or archived in the IMS shows in the POS after the next sync, with audit
   rows; a cashier cannot edit any synced field.
4. A 3-line sale on a linked till takes stock in the IMS once, even when the request is sent twice or the POS crashes
   between reserve and commit; a line short of stock refuses the whole sale and holds nothing.
5. With the IMS stopped, the till refuses the sale with the "Can't reach the inventory system" message and sells
   normally once it is back; a refund made during the outage reaches the IMS as a return afterwards.
6. The API key never appears in any response, log, audit row or page.
7. Works in Arabic, right to left. lint, tsc, vitest, `next build`, full Playwright green.

## 6. Dependencies on the IMS (separate IMS task; none blocks the first build)

| # | Ask | Why | Without it |
|---|---|---|---|
| D1 | `updatedSince` on `GET /api/products` with variant prices and `updatedAt` in the list, or catalog webhooks (`product.changed`). | Sync reads only what changed; minutes, not a full pass. | Full pull every 15 minutes (I6). |
| D2 | A multi-line reserve (one call, all or nothing). | One call per sale; no partial cancel; less rate limit use. | One call per line, cancel on failure (I12). |
| D3 | `GET /api/me` for an API key: channel, permissions, warehouses. | Exact connection check. | Probe one route per permission (I4). |
| D4 | A POS return fast path (create + receive by the channel, inspection after). | Refunded goods back in stock without a second approver. | Returns wait in `requested` (I14, R7). |

## 7. Next steps

1. Owner rules on I2, I8, I14 and I20 (or "every decision as recommended").
2. Build on its own branch in the order of [data-model-and-api.md](data-model-and-api.md) §8, with the usual gates.
3. Raise D1–D4 with the IMS as its own task.
