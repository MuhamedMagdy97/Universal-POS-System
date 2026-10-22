# Product CSV import — spec / as-built

Status: built (feat/catalog-csv-import). Closes the "no CSV import" catalog limitation.

## Flow

`/catalog/products` → **Import CSV** → `/catalog/products/import`: pick a file → the server checks it and shows one
row per record (Ready, or its problems) → **Import N products** (only when every row is ready) → "Imported N
products" with a link back to the list. Nothing is written until confirm.

## Decisions

| Topic       | Decision                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission  | `products.create` (Owner, Admin, Manager), same as creating one product. Denials of the confirm step are audited (`catalog.permission.denied`, operation `import`).                                                          |
| Linked shop | Refused with 409 `MANAGED_BY_INVENTORY` (`assertBuiltIn`) on preview and confirm; the page shows the managed notice instead of the form.                                                                                     |
| Columns     | Header row required, names case-insensitive, any order. Required: `name`, `sku`, `price`. Optional: `nameAr`, `barcode` (one per row), `category`, `vatCategory` (`STANDARD` default, `ZERO_RATED`, `EXEMPT`). Unknown or repeated column → whole file refused. |
| Validation  | Each row is parsed with `CreateProduct` (the create-product schema), price with `majorPrice(orgCurrency)`, and inserted with `insertProduct`, so no rule is duplicated. Unit is always `EACH`; cost is not imported (0). |
| Category    | Matched by name (case-insensitive) or Arabic name among the org's **active** categories. No match → `categoryNotFound`; several (same name under different parents) → `categoryAmbiguous`. Categories are never created. |
| Duplicates  | SKU (after upper-casing) and barcode repeated in the file → `duplicateInFile` on the later rows; already used in the org (products, variants, barcodes) → `skuTaken` / `barcodeTaken`.                                     |
| Limits      | At most 1000 data rows (`CSV_TOO_MANY_ROWS`) and ~900 KB of text (`CSV_TOO_LARGE`; Server Action bodies are capped at 1 MB). Blank lines are skipped.                                                                    |
| Atomicity   | All-or-nothing: confirm re-validates the file and refuses it (`CSV_HAS_ERRORS`) if any row has an error; all rows go in one transaction (120 s timeout). A SKU/barcode taken by a concurrent save rolls everything back (409). |
| Audit       | Each product writes `catalog.product.created` (and `catalog.barcode.added`), like a manual create, plus one `catalog.product.imported` row (`{ created }`) per file.                                                        |
| Parser      | Hand-written RFC 4180 reader (`modules/catalog/csv.ts`): UTF-8 BOM, quoted fields with commas, `""` and line breaks, LF/CRLF/CR. Unclosed quote → `CSV_MALFORMED`. No new dependency.                                     |

File-level refusals are 422 `VALIDATION_FAILED` with `details.reason` `CSV_EMPTY`, `CSV_MALFORMED`, `CSV_TOO_LARGE`,
`CSV_TOO_MANY_ROWS` (`max`), `CSV_MISSING_COLUMN` / `CSV_UNKNOWN_COLUMN` (`column`) or `CSV_HAS_ERRORS`.

## Code

- `modules/catalog/csv.ts` — parser; `modules/catalog/import.ts` — `previewProductImport`, `importProducts`.
- `app/(app)/catalog/actions.ts` — `previewImportAction`, `importProductsAction`.
- `app/(app)/catalog/products/import/page.tsx`, `app/(app)/catalog/_components/product-import.tsx`.
- Tests: `tests/unit/catalog-csv.test.ts`, `tests/integration/catalog-import.test.ts`, `tests/e2e/catalog-import.spec.ts`.

## Not done

- No audit-screen label for `catalog.product.imported` (the audit section of the messages is owned elsewhere; the raw
  action name shows until a label is added).
- No updating existing products by SKU, no variants, no cost column, no template download.
