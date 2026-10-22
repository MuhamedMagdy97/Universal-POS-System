# Stock CSV import — spec / as-built

Status: built (feat/stock-csv-import). Closes the "no stock CSV import" inventory limitation. Owner approval: "as
recommended" (every decision below is the recommended option).

## Flow

`/inventory` → **Import CSV** → `/inventory/import?branch=…`: choose the branch (picker, when the user sees more
than one) and the mode (**Opening stock** or **Adjustments**), pick a file → the server checks it against that branch
and shows one row per record (item, quantity, stock after, Ready or its problems) → **Apply N rows** (only when every
row is ready) → "Stock updated" with a link back to the stock list. Nothing is written until confirm.

## Decisions

| Topic       | Decision                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission  | `inventory.adjust` (Owner, Admin, Manager), the same as the opening grid and the adjust dialog. The branch must be in the caller's scope (`requireBranch`, else 404). Denials of the confirm step are audited (`inventory.permission.denied`, operation `import`).                            |
| Linked shop | Refused with 409 `MANAGED_BY_INVENTORY` on preview and confirm (the inventory system is master); the page shows the managed notice instead of the form.                                                                                                                                       |
| One branch  | A file is for one branch, chosen on the screen. No branch column.                                                                                                                                                                                                                              |
| Columns     | Header row required, names case-insensitive, any order. `sku` and/or `barcode` (at least one of the two columns; per row at least one value), `qty` required. Adjustment mode adds `reason` (required) and `note`. Any other or repeated column → whole file refused.                         |
| Item lookup | Like the scanner: SKU upper-cased against product and variant SKUs, barcode exact. Both given and pointing at different items → `codeMismatch`. A product with variants needs the variant's code (`variantRequired`). The same item twice (by any code) → `duplicateInFile` on later rows.   |
| Opening     | `qty` is a whole number 1 … 1,000,000. Only for items with **no** ledger rows at the branch (`openingTaken` otherwise), archived items refused (`archived`): the opening grid's rules. Movement reason `OPENING_BALANCE`.                                                                     |
| Adjustment  | `qty` is a signed non-zero change (`-3`, `+5`, `5`; Arabic-Indic digits accepted), `reason` one of the adjust dialog's sub-reasons (`DAMAGED`, `EXPIRED`, `LOST_OR_STOLEN`, `COUNT_CORRECTION`, `FOUND`, `OTHER`; case and spaces/dashes ignored), with the same direction rules (`direction`) and a note required for `OTHER`. Never below zero (`insufficientStock`, preview shows "stock after"); an archived item may only lose stock. |
| Ledger      | Confirm goes through `applyLines` (the single stock write path: catalog check, product + balance locks, block-negative policy, ledger rows). No balance is written directly. Movements carry `refType "StockImport"`, `refId importId`.                                                     |
| Atomicity   | All-or-nothing: one transaction (120 s timeout). The file is checked again **under the balance locks**; any row error refuses it (`CSV_HAS_ERRORS`), so a sale or opening that landed after the preview cannot be overwritten or driven negative.                                         |
| Idempotency | The client picks an `importId` (UUID) per checked file. Confirm locks the rows, then looks for movements with that id: if found it returns `{ applied, replayed: true }` and writes nothing, so a double click or a retry after a dropped connection applies the file once.                 |
| Audit       | One `inventory.stock.imported` row per file: `{ branchId, mode, importId, lines: [{ ref, qtyDelta, adjustmentReason? }] }`, labelled "Stock imported (CSV)" on the audit screen.                                                                                                             |
| Limits      | Same as the product import (shared code): at most 1000 data rows (`CSV_TOO_MANY_ROWS`), ~900 KB of text (`CSV_TOO_LARGE`). Blank lines are skipped.                                                                                                                                          |
| Parser      | The product import's `parseCsv` plus `readCsvTable` (header, columns, limits, blank lines), moved into `modules/catalog/csv.ts` and used by both imports. No new dependency, no migration.                                                                                                  |

File-level refusals are 422 `VALIDATION_FAILED` with `details.reason` `CSV_EMPTY`, `CSV_MALFORMED`, `CSV_TOO_LARGE`,
`CSV_TOO_MANY_ROWS` (`max`), `CSV_MISSING_COLUMN` / `CSV_UNKNOWN_COLUMN` (`column`) or `CSV_HAS_ERRORS`.

## Code

- `modules/catalog/csv.ts` — `parseCsv`, `readCsvTable`, `csvFileError` (shared with `modules/catalog/import.ts`).
- `modules/inventory/import.ts` — `previewStockImport`, `importStock`; inputs in `modules/inventory/schemas.ts`
  (`StockImportPreviewInput`, `StockImportInput`, `normalizeSignedQty`).
- `app/(app)/inventory/actions.ts` — `previewStockImportAction`, `importStockAction`.
- `app/(app)/inventory/import/page.tsx`, `app/(app)/inventory/_components/stock-import.tsx`.
- Tests: `tests/unit/catalog-csv.test.ts` (shared reader), `tests/unit/inventory-form-helpers.test.ts`
  (`normalizeSignedQty`), `tests/integration/inventory-import.test.ts`, `tests/e2e/inventory-import.spec.ts`.

## Not done

- No template download, no multi-branch file, no counted-quantity ("set to") mode — use a stock count for that.
- No ledger-history label for imported rows: they show as "Opening balance" or their adjustment reason.
