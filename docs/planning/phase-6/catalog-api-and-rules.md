# Phase 6 / T3 — Catalog API contracts, rules, permissions, audit

Scope: API contracts, validation and business rules, permissions, audit, and the
`modules/catalog` boundary. The data model (`prisma/schema.prisma`: `Category`,
`Product`, `ProductVariant`, `Barcode`, enum `UnitType`) and the UI are covered elsewhere.
Items marked **DECISION NEEDED** need an owner ruling. Each one has a recommended default.

## 1. Transport

Sources: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`,
`02-guides/server-actions.md`, `02-guides/backend-for-frontend.md`, and
`docs/architecture/api-contracts.md`.

1. **The contract is the set of Route Handlers under `app/api/{products,categories,barcodes}`.**
   `api-contracts.md` already names these endpoints and the `{code,message,details}` envelope.
   `handleRoute`/`parseJson` (`lib/http.ts`) and `toErrorBody` (`lib/errors.ts`) already
   implement them. Each handler does these steps in order:
   1. `handleRoute(...)`.
   2. `requireTenant(request.headers, { permission })` (`lib/auth/tenant.ts`).
   3. Parse the input with zod (`zod@4`, already used by `lib/auth/tenant.ts`).
   4. Call `modules/catalog` and return `Response.json`.
2. **Scanner lookup must be a `GET` Route Handler.** The Next docs say Server Actions are
   dispatched one at a time per client ("queued"). They also say actions should not be
   used for data fetching. A burst of scans needs parallel, non-queued reads.
3. **Back-office pages read in Server Components by calling `modules/catalog` directly.**
   They pass `requireTenant(await headers(), …)` and do not fetch their own `/api`. The BFF
   guide warns that a server-side fetch is an extra HTTP round trip.
4. **Server Actions are optional thin adapters for back-office forms.** Each action
   re-runs `requireTenant`, re-parses with the same zod schema, and calls the same service
   function. It returns `{ ok: true, data } | { ok: false, error: ErrorBody }`, built with
   `toErrorBody`. The docs say every action is a public POST, so we never trust UI gating.
   Actions are capped at 1 MB by default.
5. **Caching.** `cacheComponents: true` is set in `next.config.ts`. Handlers read
   `request.headers`, which keeps them dynamic. Tenant data is never put behind `'use cache'`.
   Responses send `cache-control: no-store`. If a Server Action mutates data, it calls
   `revalidatePath` or `refresh` for the affected admin route.
6. **Proxy.** `proxy.ts` already denies `/api/*` with a 401 when there is no session cookie.
   That check is only optimistic, so authorization still happens in the service layer.

## 2. Common conventions

- **Tenant.** `orgId` always comes from `TenantContext`. It is never accepted in a body or
  query. All queries use `tenantWhere(ctx)`. Loads by id go through `assertTenantOwned`.
  A missing record and a record owned by another tenant both return 404.
- **Branch.** The catalog is org-wide: no catalog table has a `branchId`, and PriceList is
  excluded from the MVP (`database-design.md`). Catalog endpoints take no `branchId`.
  Stock per branch belongs to inventory (T4), not to catalog responses.
- **Money.** Request and response bodies carry integer minor units (`priceMinor`,
  `costMinor`), never decimals (business rule 1). Forms convert input with
  `parseMajor`/`toMajorString` (`lib/money.ts`). Every amount must satisfy
  `0 ≤ x ≤ MAX_STORABLE_MINOR`.
- **Text.** Values are trimmed and NFC-normalized. `name` is 1–120 characters. `nameAr` is
  optional and 1–120 characters when present (EN/AR, `mvp-scope.md`).
- **Errors.** We keep the existing `ErrorCode` set. Specific causes go in
  `details.reason`, so `lib/errors.ts` needs no change:

| HTTP | code | `details.reason` (catalog) |
|---|---|---|
| 401 | UNAUTHENTICATED | — |
| 403 | FORBIDDEN | missing permission / no active org |
| 404 | NOT_FOUND | unknown or other-tenant id; `UNKNOWN_CODE` on lookup |
| 409 | CONFLICT | `SKU_TAKEN`, `BARCODE_TAKEN`, `NAME_TAKEN`, `STALE_WRITE`, `CATEGORY_HAS_ACTIVE_CHILDREN`, `ALREADY_ARCHIVED`, `NOT_ARCHIVED` |
| 422 | VALIDATION_FAILED | zod issues, plus `CATEGORY_INACTIVE`, `CATEGORY_CYCLE`, `CATEGORY_TOO_DEEP`, `UNIT_NOT_SUPPORTED`, `UNIT_IMMUTABLE`, `VARIANT_PRODUCT_MISMATCH`, `ITEM_NOT_SELLABLE` |

  For a 409 caused by a uniqueness clash, `details` is `{ reason, field, existingId }`.
  `existingId` is safe to return because the clash is inside the same tenant. The
  service catches Prisma `P2002` on catalog writes and rethrows it as the specific
  `AppError` above, so we no longer fall back to the generic `toErrorBody` message.
- **Optimistic concurrency.** Every `PATCH` body and every archive/restore body requires
  `expectedUpdatedAt` (ISO string). A mismatch returns 409 `STALE_WRITE`. This stops two
  admins from silently overwriting each other's price edits.
- **Idempotency.** Catalog writes do not take `Idempotency-Key`. `api-contracts.md`
  reserves it for sales, receive and refund. Retrying a create is safe in practice:
  the natural keys (`UNIQUE(orgId,sku)`, `UNIQUE(orgId,code)`) make it return 409 with
  `existingId`, and the client treats that as success-if-same. Archive and restore
  are idempotent by design (re-archiving returns 409 `ALREADY_ARCHIVED` with no side effect).
- **Pagination.** Lists use cursors, per `api-contracts.md`. `?limit` is 1–100 (default 25)
  and `?cursor` is an opaque base64 of `(sortKey, id)`. The response shape is
  `{ items, nextCursor: string | null }`. The default sort is `name ASC, id ASC`, and
  `sort=updatedAt` is also allowed. There are no offset or total counts. A count needs a
  full scan, so we leave it out until reports ask for it.

## 3. Permissions

Checks use `requireTenant(..., { permission })` and permission grants only, never role
names (`lib/auth/permissions.ts`).

| Operation | Permission | Owner | Admin | Manager | Cashier | Reporting |
|---|---|---|---|---|---|---|
| list/search/get products, categories | `products.read` | ✓ | ✓ | **?** | **?** | — |
| scanner lookup (`GET /api/barcodes?code=`) | `products.read` | ✓ | ✓ | **?** | **?** | — |
| create product/variant/category, add barcode | `products.create` | ✓ | ✓ | — | — | — |
| update, price change, archive/restore, remove barcode | `products.update` | ✓ | ✓ | — | — | — |

- **DECISION NEEDED (D1). Cashiers and Managers cannot read the catalog today.**
  `ROLE_PERMISSIONS` grants `products.read` only to Owner and Admin, so a cashier cannot
  search or scan at checkout. *Recommend:* add `products.read` to `MANAGER` and `CASHIER`,
  and extend `tests/unit/permissions.test.ts`. The alternative is to accept `sales.create`
  on the lookup and search routes, but that needs any-of support in `TenantRequirements`.
- **Cost is hidden from roles that cannot edit the catalog.** `costMinor` and other margin
  fields appear only when the caller has `products.update`. Other callers get a
  `ProductPublic` shape without cost. This also follows the Next guidance to constrain
  return values.
- **DECISION NEEDED (D2). Should price changes have their own permission?** *Recommend:*
  no for MVP. `products.update` covers them, and the change is audited with old and new
  values. Add `products.price` in Next if managers must reprice without full edit rights.

## 4. Operations

All schemas live in `modules/catalog/schemas.ts`, exported for handlers, actions and
tests. Lists below abbreviate the zod definitions.

### Products — `app/api/products/route.ts`, `app/api/products/[productId]/route.ts`
| Op | Method + path | Input | Output |
|---|---|---|---|
| list/search | `GET /api/products?q&categoryId&status=active\|archived\|all&limit&cursor&sort` | query (default `status=active`) | `Page<ProductSummary>` |
| get | `GET /api/products/{productId}` | uuid param (bad uuid → 404) | `ProductDetail` (variants + barcodes) |
| create | `POST /api/products` | `CreateProduct` | 201 `ProductDetail` |
| update / price change | `PATCH /api/products/{productId}` | `UpdateProduct` | `ProductDetail` |
| archive / restore | `POST /api/products/{productId}/archive` · `/restore` | `{ expectedUpdatedAt }` | `ProductDetail` |

```ts
CreateProduct = z.strictObject({
  sku: Sku, name: Name, nameAr: Name.optional(),
  categoryId: z.uuid().nullable().default(null),
  unitType: z.enum(["EACH", "KG"]).default("EACH"),     // see D4
  priceMinor: Minor, costMinor: Minor.default(0),
  vatApplicable: z.boolean().default(true),
  barcodes: z.array(BarcodeCode).max(10).default([]),  // created in the same tx
});
UpdateProduct = CreateProduct.omit({ barcodes: true, unitType: true }).partial()
  .extend({ expectedUpdatedAt: z.iso.datetime() });     // unitType immutable
Sku = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._\-\/]+$/);
Minor = z.int().min(0).max(MAX_STORABLE_MINOR);
```
`ProductSummary` contains `{ id, sku, name, nameAr, categoryId, unitType, priceMinor,
vatApplicable, isActive, variantCount, updatedAt }`. It adds `costMinor` when the caller
has `products.update`.

**Search (`q`, 1–64 characters).** If `q` exactly matches a barcode, that product is
returned first. Otherwise the search runs a case-insensitive `ILIKE` contains-match over
`sku`, `name` and `nameAr`. This is enough for MVP retail catalogs of 10k items or fewer.
The fallback plan for slow searches is the `pg_trgm` index in **D6**.

### Variants — `app/api/products/[productId]/variants/...`
| Op | Method + path | Input |
|---|---|---|
| create | `POST …/variants` | `{ sku, name, nameAr?, priceMinor?: Minor\|null, costMinor?: Minor\|null, barcodes? }` |
| update | `PATCH …/variants/{variantId}` | partial of the above + `expectedUpdatedAt` |
| archive/restore | `POST …/variants/{variantId}/archive` · `/restore` | `{ expectedUpdatedAt }` |
A `null` price or cost means the variant inherits it from the product (schema comment).
The variant must belong to `{productId}` in the same org, otherwise the request returns 404.

### Categories — `app/api/categories/route.ts`, `app/api/categories/[categoryId]/route.ts`
| Op | Method + path | Input |
|---|---|---|
| list | `GET /api/categories?status&parentId` | returns the whole tree (small); no cursor |
| create | `POST /api/categories` | `{ name, nameAr?, parentId?: uuid\|null }` |
| update | `PATCH /api/categories/{id}` | partial + `expectedUpdatedAt` (rename / re-parent) |
| archive/restore | `POST /api/categories/{id}/archive` · `/restore` | `{ expectedUpdatedAt }` |

### Barcodes — `app/api/barcodes/route.ts`, `app/api/barcodes/[barcodeId]/route.ts`
| Op | Method + path | Input / output |
|---|---|---|
| **scanner lookup** | `GET /api/barcodes?code=…` | → `LookupResult` or 404 `UNKNOWN_CODE` |
| add | `POST /api/barcodes` | `{ code, productId, variantId?: uuid\|null }` → 201 |
| remove | `DELETE /api/barcodes/{barcodeId}` | 204. This is a hard delete, which is safe because sales snapshot `sku` and name, not barcodes. |

```ts
BarcodeCode = z.string().trim().min(1).max(64).regex(/^[\x21-\x7E]+$/); // printable ASCII, no spaces
LookupResult = { productId, variantId: string | null, sku, name, nameAr,
  unitType, unitPriceMinor /* resolved variant→product */, vatApplicable,
  sellable: boolean, reason?: "PRODUCT_ARCHIVED" | "VARIANT_ARCHIVED" };
```
Lookup matches `code` exactly, with no case folding. An archived item still resolves, with
`sellable:false` and a `reason`, so the cashier sees "archived" rather than "unknown".
The response holds no stock and no cost.

### Units
There is no endpoint. Units are the Prisma enum `UnitType` (`EACH`, `KG`). The labels
come from a constant (`UNIT_TYPES` with `{en, ar}`) exported by `modules/catalog`.

### Bulk import
`requirements.md` does not list import in the MVP, and `mvp-scope.md` excludes
"legacy migrations". **DECISION NEEDED (D3).** *Recommend:* defer it to Next. If it is
pulled in, use `POST /api/products/import` as a Route Handler, not an action, because
actions are limited to 1 MB. It would take CSV with at most 1000 rows, run all-or-nothing
in one transaction, and support `?dryRun=true` to return per-row zod errors. It would
require `products.create` + `products.update` and write one `catalog.import.completed`
audit event with row counts.

## 5. Business rules and validation

1. **SKU uniqueness.** `UNIQUE(orgId, sku)` exists on `Product` and on `ProductVariant`
   separately. The service also rejects a SKU used by *either* table (409 `SKU_TAKEN`).
   This check runs in the same transaction, and the unique indexes remain the final
   guard. Comparison is case-sensitive, matching the DB index. **D5** covers whether to
   normalize case.
2. **Barcode uniqueness.** `UNIQUE(orgId, code)` covers products and variants together.
   A code stays reserved while its item is archived. To reassign it, remove the barcode
   first. If `variantId` is set, the variant must belong to `productId`; otherwise 422
   `VARIANT_PRODUCT_MISMATCH`. The composite FKs block cross-tenant references.
3. **Prices.** `priceMinor ≥ 0` and `costMinor ≥ 0`, both integers and both storable. A
   price of `0` is allowed, for example for free items. A price below cost is allowed
   but returns `details.warnings: ["PRICE_BELOW_COST"]`. Changing a price never touches
   `SaleItem` rows, which keep their snapshots (rule 4). Checkout always reads the
   current price server-side (rule 2).
4. **VAT per market.**
   - The rate is never stored on the product. Checkout snapshots `Organization.vatRateBp`
     per line at sale time: 1400 for EG and 1500 for SA (`modules/presets` `MARKET_PRESETS`).
   - The product only carries `vatApplicable`. `false` means zero-rated or exempt, and the
     effective rate becomes 0.
   - The catalog API never accepts a VAT rate. **D7** covers whether price is net or gross.
5. **Archive, not delete.** Rule 8 says to deactivate instead of delete. The MVP exposes
   no hard delete for products, variants or categories. Only barcodes are hard-deleted.
   - Archived products and variants are excluded from default lists and search.
   - Lookup marks them as not sellable.
   - `catalog.getSellableItems` (§7) rejects them with 422 `ITEM_NOT_SELLABLE`. Checkout
     (T6) and purchasing receive (T5) call it inside their own transaction, so a stale
     cart cannot sell an archived item.
   - Archiving a product does not archive its variants. A variant is sellable only if
     both it and its product are active.
6. **Variants.** If a product has one or more active variants, sale and stock lines must
   name a `variantId`. If it has none, `variantId` must be null. Otherwise the line fails
   with 422 `ITEM_NOT_SELLABLE`. Variants inherit `unitType`, `vatApplicable` and
   `categoryId` from the product.
7. **Units.** `unitType` cannot change after creation (422 `UNIT_IMMUTABLE`), because the
   ledger and sales quantities depend on it. **DECISION NEEDED (D4):** the MVP fully
   supports only Retail, `SaleItem.qty` is an `Int`, and scale/weighted selling is
   deferred. *Recommend:* accept only `EACH` in T3 and return 422 `UNIT_NOT_SUPPORTED`
   for `KG` until the grocery preset defines KG quantity semantics (e.g. grams).
8. **Categories.**
   - The tree is at most 3 levels deep (422 `CATEGORY_TOO_DEEP`) and cannot contain
     cycles (422 `CATEGORY_CYCLE`).
   - The parent must be active and in the same org.
   - Names are unique among active siblings, compared case-insensitively after trimming
     (409 `NAME_TAKEN`).
   - A category cannot be archived while it has active children (409
     `CATEGORY_HAS_ACTIVE_CHILDREN`).
   - Archiving a category with products is allowed. The products stay sellable and keep
     their `categoryId`, but archived categories cannot be newly assigned (422
     `CATEGORY_INACTIVE`).
9. **Input hygiene.** Schemas are `strictObject`, so unknown keys return 422. Clients can
   never set `orgId`, `id`, `isActive`, `createdAt` or `updatedAt`. Each write is one DB
   transaction that includes its audit row.

## 6. Audit events

Audit events need a writer that is not built yet. `modules/audit` is an empty stub (T9),
but rule 11 and T3 acceptance require catalog audit now. **T3 therefore pulls in a
minimal `audit.record(tx, event)`.** It is append-only, writes `AuditEvent`, and fills
`orgId`, `branchId`, `actorUserId` and `requestId` from `TenantContext` + `RouteMeta`.

Each catalog event is written inside the same transaction as the change:

| action | entityType | metadata |
|---|---|---|
| `catalog.product.created` | Product | `{ sku, name, priceMinor, costMinor, vatApplicable, categoryId }` |
| `catalog.product.updated` | Product | `{ changes: { field: [old, new] } }` (non-price fields) |
| `catalog.product.price_changed` | Product | `{ priceMinor: [old,new], costMinor?: [old,new] }` |
| `catalog.product.archived` / `.restored` | Product | `{ sku }` |
| `catalog.variant.created/updated/price_changed/archived/restored` | ProductVariant | same pattern + `productId` |
| `catalog.barcode.added` / `.removed` | Barcode | `{ code, productId, variantId }` |
| `catalog.category.created/updated/archived/restored` | Category | `{ name, parentId, changes? }` |

A `PATCH` that changes both price and other fields writes two events. Reads and lookups
are not audited, but they are logged at debug level with the `requestId`. Events never
include secrets or session tokens.

## 7. Module boundary — `modules/catalog/index.ts`

The service layer has signatures of the form `(ctx: TenantContext, input, meta?)`. Route
handlers and actions call these functions; nothing touches catalog tables directly
(seam rule, `system-architecture.md`).

```ts
// Admin/API surface
listProducts, getProduct, createProduct, updateProduct, archiveProduct, restoreProduct,
createVariant, updateVariant, archiveVariant, restoreVariant,
listCategories, createCategory, updateCategory, archiveCategory, restoreCategory,
addBarcode, removeBarcode, lookupCode;
export * from "./schemas";            // zod schemas + inferred types
export { UNIT_TYPES };

// Cross-module surface (inventory T4, purchasing T5, sales/checkout T6, returns T8)
type CatalogItemRef = { productId: string; variantId: string | null };
type SellableItem = CatalogItemRef & { sku: string; name: string; nameAr: string | null;
  unitType: UnitType; unitPriceMinor: number; costMinor: number; vatApplicable: boolean };
/** Tx-aware. Throws 404 for unknown/other-tenant refs and 422 ITEM_NOT_SELLABLE when
    archived or the variant rule fails. Returns rows in input order — snapshot source for SaleItem. */
getSellableItems(tx: Db | Tx, orgId: string, refs: CatalogItemRef[]): Promise<SellableItem[]>;
/** Same validation without the active check, for history (refunds, reports). */
getItemsForHistory(tx, orgId, refs): Promise<SellableItem[]>;
/** Stock-bearing check for inventory/purchasing (active + variant rule). */
assertStockable(tx, orgId, ref): Promise<void>;
```
Catalog never reads or writes inventory or sales tables. The POS screen gets catalog
data and on-hand stock together by calling `catalog.lookupCode` and `inventory` (T4)
side by side. Catalog does not join stock.

## 8. Tests required (T3 acceptance)

- **Unit tests** in `tests/unit/catalog-*.test.ts`. They cover the schemas (SKU and
  barcode charset, minor-unit bounds, strict keys), the category cycle and depth rules,
  sellability, variant price inheritance, and the permission matrix after D1.
- **Integration tests** against local PG16. They cover:
  - every cross-tenant id returns 404,
  - `SKU_TAKEN` across products and variants,
  - `BARCODE_TAKEN`,
  - `STALE_WRITE`,
  - archived items rejected by `getSellableItems`,
  - an audit row written in the same transaction, and no audit row on rollback.
- **Route tests** check each status code and envelope and that a cashier never sees
  `costMinor`.

## DECISION NEEDED

- **D1.** Grant `products.read` to Cashier and Manager (recommended). Without it, POS
  search and scan are blocked.
- **D2.** Separate `products.price` permission? Recommend no for MVP.
- **D3.** Bulk CSV import in MVP? Recommend defer to Next. §4 has a sketch if it is kept.
- **D4.** Allow `KG` in T3? Recommend `EACH` only until the grocery preset defines KG quantity.
- **D5.** SKU case: recommend case-sensitive storage, matching the DB index, with a
  case-insensitive duplicate warning. The alternative is to uppercase on write.
- **D6.** Search: `ILIKE` now, `pg_trgm` GIN index plus Arabic normalization (alef forms,
  taa marbuta, diacritics) when catalogs exceed about 10k items.
- **D7.** Is `priceMinor` VAT-inclusive (gross) or exclusive (net)? Recommend **inclusive**,
  since KSA requires shelf prices to include VAT and it is common in EG. Store it as a
  per-org setting (`pricesIncludeVat`, default true) so checkout uses `vatInGross` or
  `vatOnNet`. This needs a schema column, owned by the data-model spec.
- **D8.** The minimal `audit.record` writer moves forward into T3 from T9 (recommended).
