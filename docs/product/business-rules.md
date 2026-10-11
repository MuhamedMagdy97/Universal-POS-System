# Business Rules (must hold across DB, API, POS, reports, tests)

1. Money in integer minor units (qirsh/halala). No float arithmetic.
2. Server recomputes all sale totals; client totals are preview only.
3. VAT rate comes from org at sale time and is snapshotted per line (round-half-up per line, summed).
4. Price edits never rewrite historical SaleItems (snapshots preserved).
5. Inventory changes only via append-only InventoryMovement rows with reason + ref; StockBalance is a cache reconciled against the ledger.
6. Negative stock blocked by default.
7. Refund per line ≤ sold − already-refunded; refunds reference the original sale; voids retain the original with compensating movements + audit.
8. `UNIQUE(orgId, sku)`, `UNIQUE(orgId, barcode)`; deactivation instead of delete for referenced products.
9. Closed shifts immutable; corrections via new audit-logged entries.
10. Every tenant-scoped query enforces orgId (+ branch where applicable) server-side.
11. Audit events append-only; no user delete; never log secrets.

## Catalog (Phase 6)

12. SKUs are trimmed and upper-cased on write (`[A-Z0-9._/-]`, 1–64) and share one namespace across products and
    variants per org. Barcodes keep their exact case.
13. Shelf prices are VAT-inclusive by default: `Organization.pricesIncludeVat`, default `true` (EG and SA). VAT
    treatment per product is `vatCategory` (standard / zero-rated / exempt); the rate always comes from the org.
14. Products, variants and categories are archived, never deleted; archived SKUs and barcodes stay reserved.
    Only barcodes are hard-deleted.
15. An item's first barcode is its primary; removing the primary promotes the next one.
16. Cost (`costMinor`) is visible only to callers with `products.update`.

Details: [catalog-api-and-rules.md](../planning/phase-6/catalog-api-and-rules.md).
