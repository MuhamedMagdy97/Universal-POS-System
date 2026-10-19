# Phase 13 — Inventory System Integration: Data Model and API

Spec: [spec.md](spec.md). Decisions are referred to as I1–I23, IMS dependencies as D1–D4. "IMS" is the inventory
system at `D:/inventory sys`.

## 1. Migration `inventory_integration`

Created with **`npx prisma migrate dev --create-only`** and trimmed by hand (plain `migrate dev` drops
`POItem_one_line_per_item`). Every new column is nullable or has a default, so a POS-only shop's rows are untouched.

```prisma
enum InventorySource { BUILT_IN  EXTERNAL }
enum PostingKind     { RESERVE  FULFIL  CANCEL  RETURN }
enum PostingStatus   { PENDING  DONE  FAILED }

model Organization {
  // …existing fields…
  inventorySource InventorySource @default(BUILT_IN)          // I1
}

model InventoryLink {                                          // I3, one per org
  orgId            String    @id @db.Uuid
  baseUrl          String                                      // https://…, no path or query
  apiKeyCiphertext Bytes                                       // AES-256-GCM: iv(12) | ciphertext | tag(16)
  apiKeyKeyId      String                                      // which INTEGRATION_ENCRYPTION_KEY sealed it
  apiKeyLast4      String
  imsCompanyCurrency String?                                   // read at the connection check (I4)
  lastCheckAt      DateTime?
  lastCheckOk      Boolean   @default(false)
  lastSyncStartedAt  DateTime?
  lastSyncFinishedAt DateTime?
  lastSyncOk       Boolean?
  lastSyncSummary  Json      @default("{}")                    // counts + skipped items (no secrets)
  enabledAt        DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
}

model Branch          { externalWarehouseId String? }          // I5
model Category        { externalId          String? }          // I8
model Product         { externalProductId   String?            // I7
                        externalVariantId   String?            // simple products only
                        externalSyncedAt    DateTime?
                        notSellableReason   String? }          // I9: NO_PRICE | SERIALIZED | UNIT | STATUS
model ProductVariant  { externalVariantId   String?
                        notSellableReason   String? }

// I12–I15: one row per IMS call that must happen (or did). The outbox the scheduler drains.
model ExternalStockPosting {
  id             String        @id @default(uuid()) @db.Uuid
  orgId          String        @db.Uuid
  kind           PostingKind
  sourceType     String                                        // "Sale" | "Refund"
  sourceId       String        @db.Uuid
  lineNo         Int           @default(0)                     // merged sale line (0 for a whole-document return)
  saleItemId     String?       @db.Uuid
  externalVariantId String?
  qty            Int
  idempotencyKey String                                        // I13
  reservationId  String?                                       // IMS id, from the reserve answer
  reservationVersion Int?
  externalOrderRefId String?                                   // IMS sales_order_ref of the sale (for cancel)
  externalReturnId String?
  status         PostingStatus @default(PENDING)
  attempts       Int           @default(0)
  nextAttemptAt  DateTime      @default(now())
  lastErrorCode  String?                                       // IMS `code` only, never the body
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  @@unique([orgId, idempotencyKey])
  @@index([status, nextAttemptAt])
  @@index([orgId, sourceType, sourceId])
}
```

Hand-written SQL:

- Partial unique indexes per org on each external id: `Branch(orgId, externalWarehouseId)`,
  `Category(orgId, externalId)`, `Product(orgId, externalProductId)`, `Product(orgId, externalVariantId)`,
  `ProductVariant(orgId, externalVariantId)`, all `WHERE … IS NOT NULL`.
- One IMS variant id must never sit on a product **and** a variant of the same org. The sync is the only writer of
  external ids, so this is checked there and covered by a test; no trigger.
- `InventoryLink.orgId` references `Organization(id)`; `ExternalStockPosting.qty > 0`.
- `ExternalStockPosting` is not append-only: status, attempts and ids change as calls succeed.

New permission `integrations.manage` (Owner only) in `lib/auth/permissions.ts` (I2).

New environment variables in `lib/config.ts`, both optional so a POS-only deploy needs nothing new:
`INTEGRATION_ENCRYPTION_KEY` (base64, 32 bytes; `INTEGRATION_ENCRYPTION_KEY_ID`, default `k1`) and `CRON_SECRET`
(≥ 32 characters). Linking is refused with a clear message when the encryption key is not set.

## 2. Module layout (`modules/integrations`)

| File | Role |
|---|---|
| `source.ts` | `inventorySourceOf(client, orgId)`, `assertBuiltIn(client, orgId)` → 409 `MANAGED_BY_INVENTORY` (I18). The only place modules ask "is this shop linked?". |
| `secret.ts` | `seal(plain)` / `open(link)` with `node:crypto` AES-256-GCM. Pure, unit-tested. Never exported from the barrel to client code (`server-only`). |
| `ims-client.ts` | The only code that talks to the IMS: `fetch` with `x-api-key`, `Idempotency-Key`, `x-request-id`, 5 s timeout. Maps answers to `ImsResult` (ok / business error with IMS `code` and `details` / unavailable / link broken, per I17). Never logs the key or bodies. |
| `link.ts` | `getLinkStatus`, `saveLink` (URL + key, runs the check), `checkConnection`, `mapBranches`, `dryRun`, `enable`, `unlink` (I4, I5, I20, I21). Need `integrations.manage` except `getLinkStatus` (`settings.manage`). |
| `sync.ts` | `syncCatalog(orgId)`: list → read → map → apply per product in its own transaction (I6–I11, I23). Advisory lock `pg_try_advisory_lock(hash(orgId))`. |
| `mapping.ts` | Pure: IMS product JSON → POS rows (shape, prices to minor units, status → `isActive` + `notSellableReason`, units). Unit-tested on recorded IMS payloads. |
| `postings.ts` | `reserveSaleLines`, `cancelReservations`, `fulfilPending`, `queueReturn`, `queueVoid`, `drainPostings(now)` (I12–I15, I19). |
| `index.ts` | Barrel. |

**Seams changed in other modules** (each one `if` at the existing write, nothing else moves):

- `modules/sales/create.ts`: when `EXTERNAL`, `createSale` calls `reserveSaleLines` **before** the transaction, then
  inside it skips `recordMovements` and writes the `ExternalStockPosting` rows (`FULFIL`, `PENDING`, with
  reservation id and version); after commit it calls `fulfilPending(saleId)` without awaiting the customer's
  response beyond 2 s. A failed transaction calls `cancelReservations`.
- `modules/sales/refunds.ts`: `refundSale` and `voidSale` skip `recordMovements` and write `RETURN` / `CANCEL`
  postings in the same transaction, then try them once after commit.
- `modules/catalog` writers (products, variants, barcodes, categories): `assertBuiltIn` first, except the POS-owned
  fields (`nameAr`, `vatCategory`, `sortOrder`), which have their own small patch path.
- `modules/inventory` (opening, adjust, transfer) and `modules/purchasing` (suppliers, POs, receipts): `assertBuiltIn`.
- `recordMovements` itself also refuses when `EXTERNAL` (a second guard: no code path may write POS stock for a
  linked shop).

## 3. Sale, refund and void flows

Keys (I13; `saleKey` is the till's `Idempotency-Key`, `n` the merged line number from 1):

| Call | IMS route | Idempotency-Key | Body |
|---|---|---|---|
| Reserve line | `POST /api/reservations` | `pos:{saleKey}:r:{n}` | `{ variantId, warehouseId, qty, externalOrderId: saleKey }` |
| Cancel all (failed sale) | `POST /api/sales-orders/{orderRefId}/cancel` | `pos:{saleKey}:cancel` | `{ reason: "pos_sale_failed" }` |
| Fulfil line | `POST /api/reservations/{id}/fulfil` | `pos:{saleKey}:f:{n}` | `{ version }` |
| Void, unfulfilled line | `POST /api/reservations/{id}/cancel` | `pos:sale:{saleId}:void:{n}` | `{ version, reason: "pos_void" }` |
| Void, fulfilled lines | `POST /api/sales-returns` | `pos:sale:{saleId}:void` | `{ reasonCode: "pos_void", note: "POS sale 000123", lines: [{ reservationId, qty }] }` |
| Refund | `POST /api/sales-returns` | `pos:{refundKey}:ret` | `{ reasonCode: "pos_refund", note: "POS refund of sale 000123", lines: [{ reservationId, qty }] }` |

Sale on a linked till, step by step:

1. `requirePermission`, parse, `requireBranch`, replay by key (unchanged). Branch has `externalWarehouseId` or 409
   `INVENTORY_BRANCH_UNMAPPED`.
2. Read-only pre-check: shift open, `getSellableItems` (archived / not sellable refuse here, before any IMS call),
   every item has an external variant id, `settlePayments` passes.
3. Reserve all lines (up to 4 at a time). Results: all ok → step 4. Any `insufficient_stock` → cancel the order's
   reservations and answer the existing `409 INSUFFICIENT_STOCK` with `details.lines[].available` from the IMS (the
   till already names the lines). `archived_conflict` / `discontinued_conflict` → `422 ITEM_NOT_SELLABLE` and
   trigger a sync. Unavailable / broken → cancel what was reserved (best effort) and answer
   `503 INVENTORY_UNAVAILABLE` / `409 INVENTORY_LINK_BROKEN`.
4. The existing transaction, minus stock movements, plus the `FULFIL` postings. If it throws (e.g. the shift closed
   meanwhile) → cancel the reservations, rethrow.
5. After commit: fulfil the postings (parallel, 2 s budget). Whatever is not `DONE` stays `PENDING` for the
   scheduler. The response is the sale as today; the receipt does not wait for the IMS.

A refund's return needs the sale's reservation ids: they are on the sale's `FULFIL` postings. A refund of a line
whose fulfil is still `PENDING` waits: its `RETURN` posting is created with `nextAttemptAt` after the fulfil
(the scheduler drains `FULFIL` before `RETURN` for the same sale).

## 4. Catalog sync

1. Take the org's advisory lock; skip when held. Record `lastSyncStartedAt`.
2. Page through `GET /api/products?per_page=200` and `?status=archived&per_page=200`; collect product ids and
   `updatedAt`/`version`.
3. For every product: `GET /api/products/{id}` (up to 4 at a time). Without D1 every product is read, because a
   variant price change does not move the product's `updatedAt`.
4. Map (`mapping.ts`) and apply in one short transaction per product: categories by path (create missing, keyed by
   `externalId`), product and variants upserted by external id, barcodes replaced to match (primary = IMS
   `barcode`, others = live `BarcodeAlias`), cost and price written only when changed, catalog audit per change
   (I22), conflicts per I11.
5. POS rows with an external id that the IMS no longer lists are archived (I10).
6. Write `lastSyncFinishedAt`, `lastSyncOk`, `lastSyncSummary`; audit `integration.inventory.sync.completed`.

An IMS failure mid-sync stops it, keeps what was applied (each product is consistent on its own), and audits
`.sync.failed` with the IMS error code. The next run starts over.

## 5. POS API

| Route | Who | What |
|---|---|---|
| `GET /api/integrations/inventory` | `settings.manage` | Status: source, URL, key last 4, last check, last sync and summary, branch map, counts of pending and failed postings, returns still `requested`. Never the key. |
| `PUT /api/integrations/inventory` | `integrations.manage` | `{ baseUrl, apiKey? }` — saves (sealed) and runs the check. Omitting `apiKey` keeps the current one. |
| `POST /api/integrations/inventory/check` | `integrations.manage` | Re-runs I4. |
| `PUT /api/integrations/inventory/branches` | `integrations.manage` | `{ map: [{ branchId, warehouseId }] }`; the warehouse list comes from the IMS (`GET /api/warehouses`). |
| `POST /api/integrations/inventory/dry-run` | `integrations.manage` | Match report (I20 step 4); `?format=csv` for the on-hand export. |
| `POST /api/integrations/inventory/enable` | `integrations.manage` | I20 step 5. 409 `OPEN_SHIFTS`, `OPEN_PURCHASE_ORDERS`, `BRANCH_UNMAPPED`, `CHECK_FAILED`. |
| `POST /api/integrations/inventory/unlink` | `integrations.manage` | I21. 409 `OPEN_SHIFTS`, `PENDING_POSTINGS`. |
| `POST /api/integrations/inventory/sync` | `settings.manage` | Sync now (202; runs in the request with a 60 s cap, the scheduler finishes a longer one). |
| `POST /api/integrations/inventory/postings/{id}/retry` | `integrations.manage` | Puts a `FAILED` posting back to `PENDING`. |
| `GET /api/inventory/availability?branchId&productId&variantId` | `inventory.read` | I16: the IMS's on hand / reserved / available for one item at the branch's warehouse. 404 when not linked. |
| `POST /api/internal/inventory/run` | `CRON_SECRET` header | I19, all linked orgs. Not reachable with a session cookie; constant-time secret compare. |

New error reasons: `MANAGED_BY_INVENTORY` (409), `INVENTORY_UNAVAILABLE` (503), `INVENTORY_LINK_BROKEN` (409),
`INVENTORY_BRANCH_UNMAPPED` (409). Each gets EN/AR till and back-office messages.

## 6. Screens (EN / AR)

- **Settings → Inventory system** (`/settings/inventory`): status card, URL and key form (key field always empty,
  "ends in •••• 1a2b"), Test connection, branch-to-warehouse table, dry run with counts and CSV, Enable / Unlink
  with a confirm dialog stating what becomes read-only, Sync now, pending and failed postings with Retry.
- **Catalog** when linked: a banner "Products are managed in the inventory system", synced fields read-only, the
  Arabic name and VAT category still editable, the not-sellable reason on each item.
- **Inventory → Stock** when linked: a note and a link to the IMS; the item page shows IMS availability per branch.
  Opening, adjust and transfer actions hidden.
- **Purchasing** when linked: history read-only, "New PO" hidden, a note pointing to the IMS.
- **Till:** the two new messages (I17) and the IMS available quantity in the existing short-stock message.

| Key | EN | AR |
|---|---|---|
| Settings tab | Inventory system | نظام المخزون |
| Managed banner | Products are managed in the inventory system. | تتم إدارة المنتجات من نظام المخزون. |
| Unavailable (till) | Can't reach the inventory system. The sale was not completed; try again. | تعذر الاتصال بنظام المخزون. لم تكتمل عملية البيع، حاول مرة أخرى. |
| Link broken (till) | The inventory link needs attention — ask the owner. | الربط مع نظام المخزون يحتاج إلى مراجعة — اطلب من المالك. |
| Branch unmapped (till) | This branch is not linked to a warehouse yet. | هذا الفرع غير مربوط بمستودع بعد. |

## 7. Test plan

- **Unit:** `secret.ts` round trip, wrong key and tampered ciphertext fail; `mapping.ts` on recorded IMS payloads
  (simple, variant parent, no price, serialized, discontinued, archived, kg, 4-decimal price); IMS answer
  classification (I17, including `409 conflict` "Unexpected error" → unavailable); key derivation (I13);
  backoff schedule.
- **Fake IMS:** a small in-process HTTP server in `tests/support/fake-ims.ts` implementing only the routes of §3–§4
  with the IMS's real answer shapes (copied from the IMS code at `d412a6b`), its idempotency rule (same key + body
  replays, other body → `409 conflict`), short stock, and switches for down / slow / 403 / 429.
- **Integration (sales):** linked sale reserves and fulfils once; replay of the same request; crash between reserve
  and commit then retry (same reservations, nothing held twice); a short line refuses the sale and cancels the
  others; IMS down → `503` and no POS rows; shift closed during the reserve → reservations cancelled; fulfil fails →
  `PENDING`, drained later; no `InventoryMovement` row written for a linked org; refund and void queue the right IMS
  calls, including the refund-before-fulfil order.
- **Integration (catalog):** first sync creates items; price, barcode, alias, category and status changes apply and
  audit; removed item archived, reactivated item restored; I11 clash cases; shape change re-creates the product;
  POS-owned fields survive a sync; a failing IMS mid-sync leaves consistent products.
- **Guards:** every refused write (I18) answers `MANAGED_BY_INVENTORY` for a linked org and works for a built-in
  org; `recordMovements` refuses for a linked org.
- **Link flow:** connection check messages per missing permission and currency mismatch; enable refused with open
  shifts, open POs, unmapped branch; dry run matches by SKU then barcode; unlink restores editing.
- **Secrets (R3):** run a full link, sync, sale and refund; assert the key string is in no HTTP response, no captured
  log line, no `AuditEvent.metadata`, no `lastSyncSummary`, and not in the client bundle (`next build` output grep).
- **Access:** `integrations.manage` routes 403 for Admin, Manager, Cashier, Reporting; status 200 for Admin; the
  cron route 401 without or with a wrong secret.
- **Regression:** the whole existing suite runs on `BUILT_IN` orgs unchanged (acceptance 1).
- **Perf:** 10-line sale against the fake IMS with 20 ms latency per call answers under 2 s; sync of 5 000 fake
  products under 5 minutes (I23).
- **E2E:** owner links a shop to the fake IMS in English and Arabic (RTL), sells on the till, stops the fake IMS and
  sees the outage message, restarts it and sells.
- **Manual, once, against the real IMS** (dev databases of both apps): link, sync, a sale, a refund, check the IMS
  reservation, movement and sales return; recorded in the as-built notes.

## 8. Build order

1. Migration, permission, config, `source.ts` guards (no behaviour change for built-in orgs; full suite green).
2. `secret.ts`, `ims-client.ts`, fake IMS, link and check routes, settings screen (status, key, branches).
3. `mapping.ts`, `sync.ts`, sync routes, catalog read-only UI.
4. Sale flow (`postings.ts`, `createSale`), cron route, till messages.
5. Refund and void flows.
6. Dry run, enable, unlink; Stock and Purchasing read-only screens; availability on the item page.
7. Secrets test, perf, E2E, manual check against the real IMS, as-built notes.
