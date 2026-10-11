# API Contracts

- Auth: session; `orgId` derived server-side, never client-supplied.
- Errors: `{code, message, details}` → 401/403/404/409/422.
- Idempotency-Key header on `POST /api/sales` (and receive/refund paths).
- Cursor pagination on lists and reports.
- Endpoints: `/api/sales` (create, void, history), `/api/refunds`,
  `/api/products|categories|barcodes`, `/api/inventory/{adjust,transfer}`,
  `/api/purchasing/{pos,receive}`, `/api/shifts/{open,close}` + cash movements,
  `/api/reports/*`. Full contract table: Phase 4 report.

## Catalog (built in Phase 6 / T3)

Design and rationale: [catalog-api-and-rules.md](../planning/phase-6/catalog-api-and-rules.md). This section is the
contract as built (`app/api/**`, `modules/catalog/schemas.ts`).

### Conventions

- **Pipeline.** `apiRoute` (`app/api/_lib/route.ts`) → `handleRoute` → `requireTenant` → service in `modules/catalog`.
- **`cache-control: no-store`** on every catalog response, success and error.
- **Read routes** pass `products.read` to `requireTenant` (403 before anything else).
- **Write routes** do *not* check the permission in the route. The service checks it first, audit-logs a denial as
  `catalog.permission.denied` (outside any transaction), and only then parses the body with the strict zod schema.
  So an unauthorised caller always gets 403 whatever it sends; only malformed JSON is rejected earlier (422).
- **Ids.** Bad uuid, unknown id and another tenant's id all answer 404.
- **Bodies.** Strict objects: unknown keys (`orgId`, `id`, `isActive`, `unitType` on PATCH, …) → 422.
  Money is integer minor units, `0 ≤ x ≤ MAX_STORABLE_MINOR`. SKUs are trimmed and upper-cased, `[A-Z0-9._/-]{1,64}`.
  Barcodes are printable ASCII without spaces, 1–64, exact case. Names are trimmed, NFC, 1–120.
- **Optimistic concurrency.** Every PATCH/archive/restore body needs `expectedUpdatedAt` (ISO datetime); mismatch →
  409 `STALE_WRITE` with `details.currentUpdatedAt`.
- **Cost.** `costMinor` appears only when the caller has `products.update`.
- **Warnings.** Product/variant writes return `warnings: ["PRICE_BELOW_COST"]` when price < cost (editors only).
- **Pagination.** `GET /api/products` only: `?limit` 1–100 (default 25), `?cursor` opaque base64url of `(sortKey, id)`,
  response `{ items, nextCursor }`, no totals. Bad cursor → 422 `INVALID_CURSOR`.

### Endpoints

| Method + path | Permission | Body / query | Success |
|---|---|---|---|
| `GET /api/products` | `products.read` | `q` (1–64), `categoryId`, `vatCategory`, `status=active\|archived\|all` (default active), `limit`, `cursor`, `sort=name\|updatedAt` | 200 `Page<ProductSummary>` |
| `POST /api/products` | `products.create` | `CreateProduct` (+ up to 10 `barcodes`) | 201 `ProductDetail` + `warnings` |
| `GET /api/products/{productId}` | `products.read` | — | 200 `ProductDetail` (variants + barcodes) |
| `PATCH /api/products/{productId}` | `products.update` | `UpdateProduct` | 200 `ProductDetail` + `warnings` |
| `POST /api/products/{productId}/archive` · `/restore` | `products.update` | `{ expectedUpdatedAt }` | 200 `ProductDetail` |
| `POST /api/products/{productId}/variants` | `products.create` | `CreateVariant` (price/cost `null` = inherit) | 201 `VariantDetail` + `warnings` |
| `PATCH /api/products/{productId}/variants/{variantId}` | `products.update` | `UpdateVariant` | 200 `VariantDetail` + `warnings` |
| `POST …/variants/{variantId}/archive` · `/restore` | `products.update` | `{ expectedUpdatedAt }` | 200 `VariantDetail` |
| `GET /api/categories` | `products.read` | `status` (default active) | 200 `CategoryNode[]` (whole tree, no cursor) |
| `POST /api/categories` | `products.create` | `{ name, nameAr?, parentId? }` | 201 `CategoryDetail` |
| `PATCH /api/categories/{categoryId}` | `products.update` | rename / re-parent + `expectedUpdatedAt` | 200 `CategoryDetail` |
| `POST /api/categories/{categoryId}/archive` · `/restore` | `products.update` | `{ expectedUpdatedAt }` | 200 `CategoryDetail` |
| `GET /api/barcodes?code=` | `products.read` | scanner lookup | 200 `LookupResult`; 404 `UNKNOWN_CODE` |
| `POST /api/barcodes` | `products.create` | `{ code, productId, variantId?, isPrimary? }` | 201 `BarcodeDetail` |
| `DELETE /api/barcodes/{barcodeId}` | `products.update` | — | 204 (hard delete, audited) |
| `GET /api/catalog/search?q=&limit=` | `products.read` | POS type-to-search, `limit` 1–50 (default 20) | 200 `SellableSummary[]` (active only, no cost) |

`LookupResult` never carries cost or stock. Archived items still resolve with `sellable:false` and
`reason: PRODUCT_ARCHIVED | VARIANT_ARCHIVED`; a code on a product with variants answers `reason: VARIANT_REQUIRED`
plus a `variants` picker list.

The back-office "save product" form uses `createProductAggregate` / `updateProductAggregate` (product + variants +
barcodes in one transaction) through Server Actions; there is no Route Handler for the aggregate.

### Error reasons (`details.reason`)

| HTTP / code | Reasons |
|---|---|
| 404 NOT_FOUND | unknown / other-tenant id; `UNKNOWN_CODE` on lookup |
| 409 CONFLICT | `SKU_TAKEN`, `BARCODE_TAKEN`, `NAME_TAKEN` (with `field`, `existingId`), `STALE_WRITE`, `CATEGORY_HAS_ACTIVE_CHILDREN`, `ALREADY_ARCHIVED`, `NOT_ARCHIVED`, `PRIMARY_BARCODE_TAKEN` |
| 422 VALIDATION_FAILED | zod issues (some carry `UNIT_NOT_SUPPORTED`, `DUPLICATE_BARCODE`, `DUPLICATE_SKU`, `INVALID_CURSOR`, `INVALID_PRICE`); `CATEGORY_INACTIVE`, `CATEGORY_CYCLE`, `CATEGORY_TOO_DEEP`, `VARIANT_PRODUCT_MISMATCH`, `VARIANT_REQUIRED`, `ITEM_NOT_SELLABLE` (seam only) |

`UNIT_IMMUTABLE` is declared but not raised: `unitType` is simply not an accepted PATCH key, so sending it is a strict-schema 422.
