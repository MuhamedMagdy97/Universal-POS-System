# Phase 6 / T3: Catalog Data Model

Scope: catalog **data model** for T3 "Catalog CRUD + constraints"
(`docs/planning/task-breakdown.md`). Services, API and UI are specified elsewhere.
Status: draft for review. Items marked **DECISION NEEDED** need an owner ruling before T3 build starts.

## 1. Starting point: the catalog already exists

The Phase 5 init migration (`prisma/migrations/20261011110422_init/`) already creates
`Category`, `Product`, `ProductVariant` and `Barcode` (`prisma/schema.prisma`, "Catalog" section),
matching `docs/architecture/database-design.md`. So T3 does **not** add the catalog. It
**hardens** it with additive columns, constraints and indexes. Everything below fits the
existing conventions (header of `prisma/schema.prisma`, ADR 11 in `docs/architecture/technology-decisions.md`):

| Convention | Already in place | Source |
|---|---|---|
| Tenant scoping | `orgId` on every catalog row; composite `(orgId, id)` FKs, so a row cannot point at another org's row | schema header, ADR 4 + 11 |
| Money | `Int` minor units in `*Minor` columns; CHECK `>= 0`; max 2,147,483,647 (`lib/money.ts` `MAX_STORABLE_MINOR`) | business rule 1 |
| VAT | Rate lives on `Organization.vatRateBp` (1400 / 1500 bp, `modules/presets/index.ts`); product has `vatApplicable` only; rate snapshotted on `SaleItem.vatRateBp` | business rule 3, requirements "VAT flag" |
| Quantities | `Int` in base unit (`EACH` = piece, `KG` = gram) | schema header, `UnitType` enum |
| Uniqueness | `UNIQUE(orgId, sku)` on Product and on ProductVariant; `UNIQUE(orgId, code)` on Barcode | business rule 8 |
| Delete policy | `isActive` deactivation; every FK into catalog is `ON DELETE RESTRICT` | business rule 8 |
| Tenant guard | `requireTenant()` / `tenantWhere()` / `assertTenantOwned()` in `lib/auth/tenant.ts`; `orgId` comes from the session only | `docs/architecture/security-model.md` |

## 2. Entity decisions

### Product
- Keep the existing fields: `sku`, `name`, `nameAr`, `unitType`, `priceMinor`, `costMinor`, `vatApplicable`, `isActive`, `categoryId?`.
- **Add `hasVariants Boolean @default(false)`.** `StockBalance` and `InventoryMovement` use `variantId = NULL` for
  "product without variants" (NULLS NOT DISTINCT index in the migration). T4 and T6 need an O(1) rule:
  *if `hasVariants`, every stock or sale line must name a variant; otherwise `variantId` must be NULL.*
  The catalog service sets the flag when the first variant is created. After that the flag cannot be switched
  off while variants exist, and cannot be switched on once the product has stock/sale rows with `variantId IS NULL`
  (checked against the inventory module through its seam, `docs/architecture/system-architecture.md`).
- **Add `pricesIncludeVat`? No.** This setting belongs to the org (see DECISION NEEDED D2), not the product.
- `costMinor` is the *current/default* cost for display and PO defaults. Historical cost lives on
  `POItem` / `GoodsReceiptItem.unitCostMinor`. T3 does not define cost-averaging (T5 concern).

### ProductVariant (MVP: flat variants, no attribute tables)
- Keep: `sku`, `name` (e.g. "Red / L"), `nameAr`, `priceMinor?` / `costMinor?` (NULL = inherit product), `isActive`.
- Variants inherit `unitType`, `vatApplicable` and `categoryId` from the product. No per-variant overrides in the MVP.
- **Add `sortOrder Int @default(0)`** for stable display in the POS picker.
- **Add `@@unique([orgId, productId, id])`.** This is the target for composite FKs that prove "this variant belongs to
  this product" (see Barcode below; T4/T6 can reuse it).
- Structured option tables (Size × Colour matrix) are deferred: **DECISION NEEDED D4**.

### Barcode
- Keep: `code`, `productId`, `variantId?`, `UNIQUE(orgId, code)`.
- **Add composite FK `(orgId, productId, variantId) → ProductVariant(orgId, productId, id)`.** The existing separate FKs
  allow a barcode whose `variantId` belongs to a *different* product of the same org. With the composite FK and
  PostgreSQL's default MATCH SIMPLE, a NULL `variantId` skips the check, so product-level barcodes still work.
- **Add `isPrimary Boolean @default(false)`** with a partial unique index (one primary per product/variant). The primary
  barcode is the one printed on labels later (barcode labels are listed under "Next" in `docs/product/requirements.md`).
- **Add `@@index([orgId, productId])`** for the "barcodes of product X" lookups in the edit screen.
- Barcodes are the one catalog row that may be **hard-deleted**: nothing else references them, because `SaleItem` snapshots
  the SKU, not the barcode. A deleted code becomes reusable. The delete is audit-logged (rule 11).
- Rule: if `product.hasVariants`, `variantId` is required (service-enforced; see trigger option in §4).

### Category
- Keep: tree via `(orgId, parentId)` self-FK, `name`, `nameAr`, `isActive`.
- **Add `sortOrder Int @default(0)`.**
- **Add unique sibling name:** `UNIQUE(orgId, parentId, lower(name)) NULLS NOT DISTINCT` (raw SQL, so two roots
  cannot share a name).
- Cycle prevention and max depth (recommend 3) are service-enforced. The self-FK already prevents cross-tenant parents.
- Deactivating a category does **not** cascade to products. Products stay sellable; the category is only hidden in filters.

### Units of measure
- Keep `UnitType { EACH, KG }`. No unit table and no conversions in the MVP (`docs/product/target-customers.md`:
  KG belongs to the Grocery preset, which is "coming-soon"; scale integration is "Future").
- For `KG`, `priceMinor` means **price per kg**, and `qty` is in grams. Line amount = round-half-up(price × g / 1000),
  computed in T6. **DECISION NEEDED D5** on whether KG products can be created at all while only Retail is "included".
- `unitType` is **immutable once the product has movements or sale lines**, because it changes what the stored qty integers mean.

### Tax classes / VAT linkage
- **No TaxClass table in the MVP.** `vatApplicable = true` → org rate; `false` → 0. This matches requirements ("VAT flag")
  and keeps the single-rate-per-org model of `Organization.vatRateBp`.
- **DECISION NEEDED D3:** zero-rated vs. exempt are both 0 VAT, but ZATCA/ETA reporting (Future) separates them. Option:
  replace the boolean later with `enum VatCategory { STANDARD, ZERO_RATED, EXEMPT }`. Adding it now with
  `vatApplicable` kept as a derived column is additive and avoids a backfill later.

### Prices
- One price per product (variant override optional). No price lists (deferred, `database-design.md` "Excluded").
- Currency is implicit: it is the org currency (`Organization.currency`). Catalog rows carry no currency column.
  **DECISION NEEDED D6:** lock `Organization.currency` once any product exists (org-module rule).
- Price history is not stored in the catalog. `SaleItem` snapshots serve history (rule 4), and price changes are
  written to `AuditEvent` with before/after in `metadata`.

### SKU rules
- **Normalisation (service):** trim, collapse inner spaces, upper-case; charset `[A-Z0-9._/-]`, 1-64 chars.
  DB backstop: CHECK `sku = upper(btrim(sku)) AND length(sku) BETWEEN 1 AND 64`.
- **Cross-table collision (DECISION NEEDED D1):** `Product.sku` and `ProductVariant.sku` are unique *within* their own
  tables, but a variant can reuse a product's SKU, so a SKU lookup could return two items. Recommendation: one SKU
  namespace per org, enforced by a trigger on both tables that takes `pg_advisory_xact_lock(hashtext(orgId || sku))`
  and rejects a match in the other table. The lock is what makes the check race-safe.
- Barcode code: CHECK `code ~ '^[\x21-\x7E]{1,64}$'` (printable ASCII, no spaces). EAN/UPC check-digit validation is
  service-side, and a warning only (Code128 codes are alphanumeric).

### Active / archived state
- `isActive = false` means "archived": hidden from POS search and new POs, but still visible in reports and in history.
- No `deletedAt` column. **Hard delete** of Product/Variant/Category is allowed only if the row is unreferenced
  (FK `RESTRICT` makes the DB reject it otherwise). The service tries the delete first and falls back to deactivation, then audits.
- Archiving a product does not touch variants' `isActive`. Effective sellability = `product.isActive AND (variant?.isActive)`.
- Archiving a product with on-hand stock is allowed, with a warning (stock remains in the ledger; T4 may adjust it out).

## 3. Proposed Prisma additions (diff-style; not applied)

```prisma
model Product {
  // ...existing fields unchanged...
  hasVariants   Boolean  @default(false)   // NEW
  // vatCategory VatCategory @default(STANDARD)  // only if D3 = adopt now

  @@unique([orgId, id])
  @@unique([orgId, sku])
  @@index([orgId, categoryId])
  @@index([orgId, isActive, name])          // NEW: POS/admin list + prefix search
}

model ProductVariant {
  // ...existing fields unchanged...
  sortOrder  Int      @default(0)          // NEW

  @@unique([orgId, id])
  @@unique([orgId, sku])
  @@unique([orgId, productId, id])          // NEW: target for "variant belongs to product" FKs
  @@index([orgId, productId])
}

model Barcode {
  // ...existing fields unchanged...
  isPrimary Boolean  @default(false)       // NEW
  updatedAt DateTime @default(now()) @updatedAt  // NEW (isPrimary is mutable)

  // NEW: replaces nothing; added alongside the existing variant relation in SQL
  // (Prisma cannot model a 3-column FK on a nullable column cleanly; declare in raw SQL)
  @@unique([orgId, code])
  @@index([orgId, productId])               // NEW
}

model Category {
  // ...existing fields unchanged...
  sortOrder Int      @default(0)           // NEW

  @@unique([orgId, id])
  @@index([orgId, parentId])
}

// Only if D3 = adopt now
enum VatCategory {
  STANDARD
  ZERO_RATED
  EXEMPT
}
```

Hand-written SQL appended to the same migration (same pattern as the init migration's "Hand-written invariants" block):

```sql
-- Variant must belong to the barcode's product (NULL variantId skips: MATCH SIMPLE)
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_orgId_productId_variantId_fkey"
  FOREIGN KEY ("orgId","productId","variantId")
  REFERENCES "ProductVariant"("orgId","productId","id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "Barcode_one_primary_per_item" ON "Barcode"("orgId","productId","variantId")
  NULLS NOT DISTINCT WHERE "isPrimary";
CREATE UNIQUE INDEX "Category_sibling_name_key" ON "Category"("orgId","parentId",lower("name")) NULLS NOT DISTINCT;
ALTER TABLE "Product" ADD CONSTRAINT "Product_sku_format"
  CHECK ("sku" = upper(btrim("sku")) AND length("sku") BETWEEN 1 AND 64);
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_sku_format"
  CHECK ("sku" = upper(btrim("sku")) AND length("sku") BETWEEN 1 AND 64);
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_code_format" CHECK ("code" ~ '^[\x21-\x7E]{1,64}$');
ALTER TABLE "Product" ADD CONSTRAINT "Product_name_nonblank" CHECK (length(btrim("name")) > 0);
-- If D1 = shared namespace: trigger pos_guard_sku_namespace() on Product + ProductVariant
--   BEFORE INSERT OR UPDATE OF "sku": advisory xact lock on (orgId, sku), reject a match in the other table.
-- If D7 = trigram search: CREATE EXTENSION IF NOT EXISTS pg_trgm; GIN indexes on name / nameAr / sku.
```

## 4. Constraint enforcement summary

| Invariant | Where |
|---|---|
| Row belongs to caller's org | `requireTenant` + `tenantWhere` (service) and composite FKs (DB) |
| SKU unique per org (per table) | existing unique indexes |
| SKU unique across product + variant | trigger (D1) |
| Barcode unique per org | existing `UNIQUE(orgId, code)` |
| Barcode variant belongs to its product | new composite FK |
| `hasVariants` ⇒ barcode/stock/sale line names a variant | service (T3/T4/T6). Optional DB trigger on Barcode only |
| Money non-negative integer | existing CHECKs + `lib/money.ts` `assertStorable` |
| No delete of referenced rows | existing FK `RESTRICT` |
| `unitType` immutable after first movement/sale | service (needs an inventory-module query through the seam) |
| Every create/update/archive audited | service → `AuditEvent` (rule 11) |

## 5. Migration plan (additive only)

1. One new migration, e.g. `prisma/migrations/<ts>_catalog_hardening/`, generated with
   `prisma migrate dev --create-only`, then the hand-written SQL from section 3 appended.
2. Only `ADD COLUMN ... DEFAULT`, `ADD CONSTRAINT`, `CREATE [UNIQUE] INDEX`, `CREATE FUNCTION/TRIGGER`, and optionally `CREATE TYPE`.
   No drops, renames or type changes. Existing rows satisfy the defaults.
3. Pre-flight for environments that already hold data (dev/test only today): a SQL check script lists non-normalised SKUs,
   duplicate sibling category names, barcodes whose variant belongs to another product, and product/variant SKU collisions.
   Fix the data first. Constraints are added `NOT VALID` + `VALIDATE` only if a table is large (not needed for MVP).
4. Backfill `Product.hasVariants = EXISTS(variant)` in the same migration (`UPDATE`; additive).
5. Tests (Vitest against `pos_test`): each constraint rejects a bad row, and cross-tenant references fail at the DB level.
   Mirrors the existing invariant tests from Phase 5.

## 6. Interactions with later tasks (not designed here)

- **T4 inventory ledger:** keyed by `(orgId, branchId, productId, variantId?)`. The catalog guarantees `hasVariants` and
  `ProductVariant @@unique([orgId, productId, id])`, so T4 can add the same "variant belongs to product" composite FK to
  `StockBalance` / `InventoryMovement`. Catalog never writes stock: opening stock entered on the product form is a call to
  `inventory.recordOpeningBalance()` (`MovementReason.OPENING_BALANCE`), per the seam rule.
- **T5 purchasing:** reads `costMinor` as the PO default only. Archived products are excluded from new POs.
- **T6 checkout:** resolves scan input as `Barcode.code` → SKU (product, then variant). Effective price = `variant.priceMinor ?? product.priceMinor`.
  VAT = `vatApplicable ? org.vatRateBp : 0`, snapshotted on `SaleItem`. The catalog must expose a read function that
  returns exactly these snapshot fields (`skuSnapshot`, `nameSnapshot`, `nameArSnapshot`, `unitType`).
  Note: the CASHIER role has no `products.read` (`lib/auth/permissions.ts`). The POS lookup needs either that grant or
  a sales-scoped read path (**DECISION NEEDED D8**).

## 7. DECISION NEEDED

- **D1** Single SKU namespace across Product + ProductVariant (trigger) vs. allowing overlap. *Rec: single namespace.*
- **D2** VAT-inclusive vs. exclusive shelf prices. KSA consumer prices are normally shown VAT-inclusive, and `lib/money.ts` supports both
  (`vatInGross` / `vatOnNet`). *Rec: org-level `pricesIncludeVat` (org module, preset default `true` for both markets).* Needed before T6.
- **D3** Keep `vatApplicable` boolean vs. add `VatCategory` (STANDARD / ZERO_RATED / EXEMPT) now. *Rec: add now, additive, for future e-invoicing.*
- **D4** Variant attributes: free-text variant `name` (MVP) vs. option/value tables. *Rec: free text; options in "Next".*
- **D5** Allow `KG` products in MVP Retail, or hide the option until the Grocery preset is "included". *Rec: hide in UI, keep the enum.*
- **D6** Lock `Organization.currency` (and country) once catalog/sales data exist. *Rec: lock.*
- **D7** Search: `pg_trgm` GIN indexes for name/nameAr/SKU contains-search vs. b-tree prefix only. *Rec: pg_trgm (available in PG16 and Neon/Supabase).*
- **D8** CASHIER catalog read access for POS scan/search: grant `products.read` vs. a sales-scoped lookup. *Rec: grant `products.read` to CASHIER.*
- **D9** Category max depth (rec 3) and whether a product may have multiple categories (rec: single, as today).
