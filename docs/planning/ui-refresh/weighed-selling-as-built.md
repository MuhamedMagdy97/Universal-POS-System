# Weighed Selling (UI Refresh C): As Built

Built 2026-10-25 against [weighed-selling-spec.md](weighed-selling-spec.md) and
[weighed-selling-plan.md](weighed-selling-plan.md), in three stacked PRs: selling by weight, stock, purchasing and
reports in kg, and scale labels.

## What exists

- **Quantities** (`lib/quantity.ts`): KG quantities are grams in the existing integer columns; KG price and cost are
  per kg. `lineMinor` (half up, BigInt) is the only place a weight is priced; `lineValueSql` is its SQL twin for
  reports. `parseQtyInput` reads kg with `.`, `,` or `٫` and Arabic-Indic digits, at most 3 decimals; `formatQty`
  shows `0.750 kg` / `0.750 كجم`.
- **Catalog**: a product without variants can be `KG` (form, API, CSV `unit` column); a KG product cannot get
  variants (`UNIT_NOT_SUPPORTED`). Prices and costs say "per kg".
- **Till**: a KG item opens the weight box (search, tile or scan); the line edits its weight in kg, `+` / `−` step
  0.1 kg, prices show "/kg". Receipts (screen, print, offline) show `0.850 kg × EGP 12.00`. Refunds take kg up to the
  weight sold; voids return the whole weight.
- **Money paths**: sale create, offline pricing and replay, refunds, the profit cost snapshot, purchase orders,
  receipts, returns, supplier accounts and invoices, and the purchases and supplier-balance reports all go through
  `lineMinor` / `lineValueSql`.
- **Inventory**: stock list, ledger, adjust, opening stock, transfers (send, receive, detail), counts (sheet and
  session), reorder points, low stock and stock CSV import read and write kg.
- **Reports**: product and profit-by-product rows show kg for KG items. Category, profit-by-category, profit-by-day
  and purchases rows are `KG` when every line is weighed, `MIXED` ("—" on screen, empty in CSV) when grams and pieces
  meet, and quantity columns have no total once any row is weighed. Dashboard top items rank KG items by sale lines
  and show kg; the offline review shows negative stock in kg.
- **Unit totals** that would add grams to pieces show "—" (PO list and detail, receipt detail, direct receipts,
  transfers list); the receive button counts lines and the close dialog drops the unit count on a weighed order.
- **Scale labels** (migration `scale_labels`, settings only): Settings → Shop has a Scale labels card (Owner only,
  `shop.manage`, audited as `settings.scale_labels.updated`; prefixes `2x`, item code 4–6 digits, weight or price).
  `lib/scale-label.ts` parses EAN-13 labels. At the till a label's prefix + item code is looked up as an exact
  barcode (online `/api/barcodes`, offline the snapshot). A weight label adds its grams; a price label adds
  round(price × 1000 ÷ price per kg) grams and keeps the printed total, sent as `labels: [{ grams, totalMinor }]`.
  The server accepts a label only on a KG item and only within half a gram's worth of price × grams, per label and for
  the line as a whole (at most five labels' worth), else 422 `LABEL_MISMATCH`. A bad check digit is refused; a code
  that is not a weighed item's label falls back to the normal search, so the shop's own 20–29 barcodes still scan.
- **Linked shops**: an inventory-system item in `kg` is not sellable (`notSellableReason: "UNIT"`), and a sale of a
  KG item in a linked shop is refused, so grams are never posted to the inventory system as pieces.

## After the final review

- Many tiny price labels can no longer add their tolerances into a discount (whole-line bound).
- Purchasing and transfer screens no longer add grams to pieces; category, profit and purchases reports mark mixed
  rows.
- Scanning a weighed item during a count asks for the weight instead of adding 1 g.
- The shop's own in-store barcodes in the label range still scan when labels are on.

Known and left for later: the till picks up changed scale settings on its next page load; an offline sale whose label
no longer fits the price on replay is refused rather than flagged (the till derives the grams, so this needs odd
data); a count scan of a weighed item does not focus its counted box; the return document pages still total units
as stored.

## Deviations from the spec

| Spec | As built | Why |
| ---- | -------- | --- |
| W6 settings in the till snapshot | The till reads them from the server-rendered page | The till page is never rendered from the snapshot; the snapshot only prices |
| W6 price labels keep the printed total | Kept, within half a gram's worth per label and five labels' worth per line | Stops a hand-built request from undercharging with many labels |
| W9 aggregate rows show kg | `KG` only when every line is weighed, else `MIXED` ("—") | A category or day can hold both units |
| W10 synced `kg` items sellable | Not sellable in linked shops (W11 brought into PR 1) | The inventory system counts kg; grams would post as 1,000× the quantity |

## Tests

Unit: `quantity.test.ts`, `scale-label.test.ts`, `sales-totals.test.ts` (labels), `pos-till-helpers.test.ts`
(weighed lines, labels), `catalog-validation.test.ts`, `inventory-sys.test.ts`, `count-sheet.test.ts`,
`purchasing-rules.test.ts`. Integration: `weighed-sale.test.ts` (discounts, VAT, refunds, void, profit, reports,
CSV, mixed rows, offline, labels accepted and refused), `weighed-stock.test.ts`, `weighed-purchasing.test.ts`,
`scale-settings.test.ts`, `dashboard-profile.test.ts`, `inventory-sale-posting.test.ts` (linked kg refused),
`catalog-products`, `catalog-import`. E2E: `weighed-selling.spec.ts` (weight box, `+`, receipt, partial refund,
Arabic; scale-label settings, bad check digit, weight label, own 20-range barcode, price label to the sale line).

Owner action: before release, check production for KG sale lines from shops linked to the inventory system that
were posted as pieces before this change.
