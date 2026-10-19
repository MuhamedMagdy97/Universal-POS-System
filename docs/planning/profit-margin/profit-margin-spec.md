# P12 — Profit and Margin Reporting: Specification

Status: **Spec approved by the owner (2026-10-19, every decision as recommended). BUILT on `profit-margin/build`** —
see §11.

Source: P12 in `docs/planning/phase-9/reports-audit-spec.md` (deferred 2026-10-12 because `SaleItem` has no cost
snapshot), `reports-audit-data-model-and-api.md` §11 ("a migration, like the cost snapshot deferred in P12"),
purchasing P2 and P13 (`docs/planning/phase-10/purchasing-spec.md`: last cost from receiving, costs before VAT), and
the as-built `modules/sales`, `modules/catalog`, `modules/purchasing` and `modules/reports`.

## 1. Key facts

- **Cost today lives only on the catalog.** `Product.costMinor` is `Int @default(0)`; `ProductVariant.costMinor` is
  `Int?` (`null` = inherit the product's). A cost of `0` cannot be told apart from "never set".
- **Receiving sets the last cost.** `applyReceivedCosts` (`modules/catalog/costs.ts`), called from
  `modules/purchasing/receipts.ts` inside the receipt transaction, writes the received `unitCostMinor` onto the variant
  (variant line) or the product (product line) and audits `catalog.cost.received`. Owners and admins can also edit
  cost by hand on the product screen (`catalog.product.price_changed`).
- **Costs are before VAT** (purchasing P13: supplier invoice amounts before VAT; no input VAT tracked).
- **Checkout already has the cost in hand.** `createSale` (`modules/sales/create.ts`) calls `getSellableItems`, which
  returns each line's resolved `costMinor` (variant cost, else product cost) marked "internal use only". It is not
  written to `SaleItem` and never returned by the sales API or the receipt.
- **`SaleItem` is append-only** (trigger `SaleItem_append_only` rejects UPDATE and DELETE). Past lines cannot be
  backfilled without switching the trigger off.
- **Refunds** write `RefundItem(qty, amountMinor, vatMinor)` against a `saleItemId`; amounts are a proportional share
  of the sale line, the last refund taking the remainder (`modules/sales/refunds.ts`). A void removes the whole sale
  from every report (T9 P3).
- **Quantities are whole numbers** (`Qty` is an integer ≥ 1); `unitType` KG exists but is sold in whole units today.
- **Who sees cost:** `canSeeCost` = `products.update` = Owner and Admin. Manager, Cashier and Reporting never see cost.
  Reports already support a second grant per report (`EXTRA_PERMISSION` in `modules/reports/access.ts`, used by
  `purchases` → `purchases.manage`).
- **Reports** build products, categories and VAT from one `lineFacts` set (sale lines of completed sales in range plus
  refund lines of refunds in range, refunds on the day they were made). On the T9 perf seed (100 000 sales, 366 days)
  the slowest report is `sales-summary` at 298 ms; `products` 123 ms, `categories` 108 ms.

## 2. Goal and success

An owner or admin picks a branch and a date range and reads gross profit and margin by product, by category and by
day, with the same totals as the Products, Categories and Sales summary reports for revenue, and exports each to CSV.
Profit uses the cost the item had **at the moment it was sold**, so a later delivery at a new price does not rewrite
last month's profit. Lines sold without a known cost are shown, not hidden or guessed.

Out of scope: weighted-average or FIFO costing, inventory valuation (stock × cost) report, cost of shrinkage and
write-offs, landed cost (freight, duties), discounts (none exist yet: `discountMinor` is always 0), a profit tile on the
dashboard (see M12), editing cost on a past sale.

## 3. Decisions

| # | Topic | Decision |
|---|---|---|
| M1 | Where cost is kept | A new nullable column **`SaleItem.unitCostMinor`** (per unit, before VAT), written at checkout from the `costMinor` that `getSellableItems` already returns: the variant's cost, else the product's — i.e. the last cost set by receiving or by hand. Per unit, not per line, so a refund's cost is exact (`unitCostMinor × refunded qty`) with no rounding share. **Owner: confirm last cost (not average cost).** |
| M2 | Cost not known | A resolved cost of **0 is stored as `NULL` (unknown)**, because `Product.costMinor` defaults to 0 and 0 almost always means "never entered". Such lines count in revenue but not in cost or profit; every profit report shows "Revenue without cost" and "Lines without cost" so the gap is visible. A genuinely free item (cost 0) shows as unknown — acceptable. Alternative: count unknown as cost 0 (overstates profit). **Owner: confirm.** |
| M3 | Refunds | A refund line reverses its share of cost: `unitCostMinor × RefundItem.qty`, booked on the refund's day like its revenue (T9 P3). So a day can show negative profit. Refunded items going back to stock do not change cost. **(rec)** |
| M4 | Voids | A voided sale counts nowhere, cost included (T9 P3 unchanged). **(rec)** |
| M5 | Revenue for margin | **Net of VAT**: sale line `lineTotalMinor − vatMinor`, refund line `amountMinor − vatMinor`. Costs are before VAT (purchasing P13), so both sides match. Gross profit = net revenue with cost − cost. Margin % = gross profit ÷ net revenue with cost (lines without cost are left out of both, M2). Margin is shown to one decimal; "—" when that revenue is 0. **(rec)** |
| M6 | Sales before the migration | Left `NULL` (unknown). No backfill: the table is append-only, and today's cost would be a guess presented as fact. Old ranges simply show their revenue as "without cost". Alternative: a one-off backfill from current cost with the trigger off, marked as estimated. **Owner: confirm no backfill.** |
| M7 | Who sees profit | **`reports.view` + `products.update`** (Owner, Admin): the same people who see cost anywhere else. Manager and Reporting do not. Alternative: add Reporting (accountants). **Owner: confirm, or add Reporting.** |
| M8 | Reports | Three new canned reports, after the existing nine: **Profit by product**, **Profit by category**, **Profit by day**. Columns: qty sold, qty refunded, net revenue (ex VAT), revenue without cost, cost, gross profit, margin %. Profit by day also shows lines without cost. Each has CSV (same rules as T9 P9). The existing reports are unchanged. **Owner: confirm the three and the columns.** |
| M9 | Performance | Each profit report ≤ 300 ms over 366 days on the T9 perf seed (100 000 sales, 2 000 refunds), checked in `reports-perf.test.ts`. No new index or materialized view expected: the queries are the existing `lineFacts` with one more column. **(rec)** |
| M10 | Cost never leaks | `unitCostMinor` is never in the sales API response, the receipt, the reprint, the returns lookup or any report a non-M7 user can open. A test asserts it per surface. **(rec)** |
| M11 | Audit | No new audit actions: the cost snapshot is part of the sale write (already audited `sale.created`), and cost changes are already audited (`catalog.cost.received`, `catalog.product.price_changed`). Running a report is not audited (as T9). **(rec)** |
| M12 | Dashboard | No profit tile for now; add one later if wanted (it would be shown only to M7 users). **Owner: confirm, or ask for a "gross profit today" tile.** |

## 4. Data model change (sketch)

```prisma
model SaleItem {
  // …existing fields…
  // Cost per unit before VAT at the moment of sale (P12 M1). NULL = unknown (M2, M6).
  unitCostMinor  Int?
}
```

Migration `add_sale_item_cost`, created with **`npx prisma migrate dev --create-only`** and trimmed by hand: plain
`migrate dev` also drops the `POItem_one_line_per_item` index (a partial index Prisma does not model). The trimmed SQL
is only:

```sql
ALTER TABLE "SaleItem" ADD COLUMN "unitCostMinor" INTEGER;
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_unitCostMinor_nonneg" CHECK ("unitCostMinor" IS NULL OR "unitCostMinor" >= 0);
```

Adding a nullable column rewrites no rows and fires no row trigger, so `SaleItem_append_only` is untouched and every
existing line reads `NULL`. No change to `RefundItem` (M3 derives refund cost from the sale line).

Checkout change (`modules/sales/create.ts`): in the `saleItem.createMany` mapping add
`unitCostMinor: item.costMinor > 0 ? item.costMinor : null`. No other sales code changes.

## 5. API sketch

- `REPORT_NAMES` gains `profit-products`, `profit-categories`, `profit-days`; `EXTRA_PERMISSION` maps each to
  `products.update` (M7). The picker already hides reports a user cannot run (`canRunReport`).
- Same route as every report: `GET /api/reports/{report}?branchId=&from=&to=` → `{ rows, totals }`; `&format=csv` →
  CSV. 403 for users without both grants (audited `reports.permission.denied` as today). Range limit 366 days (T9 P8).
- Queries (`modules/reports/queries.ts`): `lineFacts` gains three columns — net revenue with cost, net revenue without
  cost, cost — computed per line as:
  - sale line: `net = lineTotalMinor − vatMinor`; `cost = unitCostMinor × qty` when not `NULL`.
  - refund line: `net = amountMinor − vatMinor`; `cost = si.unitCostMinor × ri.qty` when not `NULL`.
  - all sums as `bigint` (`unitCostMinor × qty` can pass 32 bits over a year).
  Profit by product and by category group like `products` and `categories`; profit by day groups like
  `sales-summary` (shop-timezone day, T9 P2). Margin is computed in TypeScript from the integer totals as basis points
  (`round(profit × 10 000 ÷ revenueWithCost)`), and the totals row recomputes margin from the totals, never by summing
  (`marginBp` joins `NOT_TOTALLED` in `columns.ts`, like `averageMinor`).
- Row shape (product): `{ productId, variantId, sku, name, nameAr, qtySold, qtyRefunded, netRevenueMinor,
  revenueNoCostMinor, costMinor, grossProfitMinor, marginBp | null }`; category and day rows the same with their key,
  day rows plus `linesNoCost`.

## 6. Screens (EN / AR)

The existing `/reports` screen; no new page. The three reports appear in the picker for Owner and Admin only, with the
same branch, date range, table, totals row and CSV button. A one-line note above the table when any line has no cost:
"Some items were sold without a cost. Their revenue is shown separately and left out of profit." Money uses Latin
digits in both locales (D10); margin shows as `23.4%`.

| Key | EN | AR |
|---|---|---|
| Report: profit by product | Profit by product | الربح حسب المنتج |
| Report: profit by category | Profit by category | الربح حسب الفئة |
| Report: profit by day | Profit by day | الربح حسب اليوم |
| Net revenue (ex VAT) | Net revenue (ex VAT) | صافي الإيرادات (بدون الضريبة) |
| Revenue without cost | Revenue without cost | إيرادات بلا تكلفة |
| Cost | Cost | التكلفة |
| Gross profit | Gross profit | إجمالي الربح |
| Margin | Margin | هامش الربح |
| Lines without cost | Lines without cost | بنود بلا تكلفة |
| Missing-cost note | (sentence above) | بعض الأصناف بيعت دون تكلفة. إيراداتها معروضة منفصلة ولا تدخل في حساب الربح. |

CSV headers use the same labels in the user's locale (UTF-8 with BOM, formula-injection guard, as T9 P9 and R6).

## 7. Test plan

- **Unit:** margin basis points (rounding, zero revenue → `null`, negative profit); totals row recomputes margin; new
  dictionary keys present in EN and AR (existing key-set test).
- **Integration (`tests/integration/reports.test.ts` fixture):** a product with a received cost sold, then partly
  refunded, then its cost changed by a new receipt and sold again → profit by product uses each sale's own cost; the
  refund reverses exactly `unitCost × qty` on the refund's day; a voided sale is absent; a product with cost 0 is
  stored `NULL` and lands in "revenue without cost"; a variant inherits the product's cost and a variant with its own
  cost uses it; net revenue in each profit report equals net revenue (minus VAT) in Products, Categories and Sales
  summary for the same range (acceptance #1); a day split at 23:30 Cairo time.
- **Checkout:** `createSale` writes `unitCostMinor`; the sales API response, receipt and reprint contain no cost (M10).
- **Access (route tests):** Manager, Reporting and Cashier get 403 on all three; Owner and Admin get 200; a
  branch-limited admin sees only their branches (T9 R5).
- **Migration:** applies on a database with existing sales; old lines read `NULL`; `SaleItem` still rejects UPDATE.
- **Perf:** `reports-perf.test.ts` (with `REPORTS_PERF=1`) seeds cost on the perf lines and asserts each profit report
  under 300 ms (M9); results recorded in the as-built notes.
- **E2E:** admin opens Profit by product in English and Arabic (RTL), sees the totals and downloads the CSV.

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Last cost is not the true cost when stock bought at different prices is mixed, so profit is approximate. | Stated in M1 and in the screen's help text; average cost can replace the source of `unitCostMinor` later without a schema change. |
| R2 | Many products have no cost (never received, never entered), so profit looks incomplete. | M2 makes the gap visible per report; owners fill cost on the product screen or by receiving. |
| R3 | Cost leaks to cashiers or managers through a sales or receipt payload. | M10 test per surface; cost stays out of the existing `SaleDetail` mapping. |
| R4 | `unitCostMinor × qty` overflows 32-bit in SQL sums. | Cast to `bigint` before multiplying and summing (§5); test with a large line. |
| R5 | `migrate dev` drops `POItem_one_line_per_item`. | `--create-only` and trim to the two statements in §4; review the SQL in the PR. |
| R6 | Old periods show little or no profit after go-live. | M6: they show as "revenue without cost", not as zero cost; the note explains it. |

## 9. Acceptance

1. A sale made after the migration stores each line's cost; a later cost change does not alter that sale's profit.
2. A partial refund reduces cost by exactly its quantity's cost on the refund's day; a void removes the sale.
3. Net revenue in each profit report reconciles with the Products, Categories and Sales summary reports.
4. Only Owner and Admin can open the three reports or their CSV; no other surface returns cost.
5. Each profit report answers under 300 ms on the perf seed.
6. Works in Arabic, right to left. lint, tsc, vitest, `next build`, full Playwright green.

## 10. Next steps

1. ~~Owner rules on M1, M2, M6, M7, M8 and M12~~ — done 2026-10-19, all as recommended.
2. ~~Build on its own branch~~ — done, see §11: migration (create-only, trimmed), checkout line, three queries, access, columns, EN/AR
   keys, tests; then as-built notes.

## 11. As built (2026-10-19)

Migration `20261019001514_add_sale_item_cost` (created with `--create-only`; the generated
`DROP INDEX "POItem_one_line_per_item"` removed, leaving the `ADD COLUMN` and the check constraint). Checkout writes
`unitCostMinor` in `createSale` (split tenders need nothing: cost is per line, payments are separate rows). Reports:
`profit-products`, `profit-categories`, `profit-days` in `modules/reports` (queries, columns, access, service),
the missing-cost note on `/reports`, 11 new EN/AR keys.

Tests: `tests/integration/profit.test.ts` (snapshot, variants, cost 0 → unknown, refund on its own day, void, 23:30
Cairo, reconciliation with the VAT report, access for every role, Arabic CSV, no cost in the sale or receipt payload,
`SaleItem` still append-only), `tests/unit/reports-margin.test.ts` (margin rounding and formatting, margin never
totalled), `tests/e2e/reports.spec.ts` (admin in English and Arabic with CSV; manager and reporting see no profit
report), and `reports-perf.test.ts` now seeds a cost on nine lines in ten.

Perf (`REPORTS_PERF=1`, 100 000 sales and 2 000 refunds over 366 days, local PostgreSQL 16): profit-products 42 ms,
profit-categories 50 ms, profit-days 74 ms (target 300 ms). No index added.

Deviations and additions:

- **Queries:** a separate `profitFacts` beside `lineFacts` instead of extra columns on it, so the VAT, Products and
  Categories queries are untouched. Products and categories skip the local-day conversion they do not group by.
- **Margin when revenue with cost is negative** (a refund-only day) is "—" too, not only when it is 0.
- **Sort:** profit by product and by category list the highest gross profit first (then net revenue, then name).
- **Missing-cost note** shows whenever the report's "revenue without cost" total is not zero.
- **Cost change in the tests** goes through `applyReceivedCosts` (the seam receiving calls), not a full purchase order.
- **Migration test:** not a separate test; the test and E2E databases apply the migration over existing data on every
  run, and `profit.test.ts` checks the append-only trigger still holds with the new column.
- **CSV in E2E:** only the filename is checked in the browser; the content (Arabic headers, margin, recomputed total)
  is checked in `profit.test.ts`.
