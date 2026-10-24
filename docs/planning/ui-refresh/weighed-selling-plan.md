# Weighed Selling (UI Refresh C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell, stock, buy, count and report KG items, with a weight typed at the till or read from a scale label.

**Architecture:** A KG quantity is an integer number of grams in the existing columns (W1). `lib/quantity.ts` holds
the only conversions: `lineMinor` for money, `parseQtyInput` / `formatQty` for screens. Every place that multiplied a
price or cost by a quantity calls `lineMinor` (TypeScript) or the SQL twin `lineValueSql` (reports). DTOs that list
items gain `unitType` so screens can parse and format per unit.

**Tech Stack:** Next.js 16.4, Prisma 7 (PostgreSQL 16), zod 4, Vitest, Playwright.

**Spec:** [weighed-selling-spec.md](weighed-selling-spec.md)

## Global Constraints

- Grams for KG, pieces for EACH, both integers 1 … 1,000,000 per line (`MAX_QTY` unchanged).
- KG money: `round(price × grams / 1000)` half up, per line, through `lineMinor` only. No float arithmetic on money.
- Screens: KG in kg with up to 3 decimals; Arabic-Indic digits and the Arabic decimal separator `٫` accepted.
- One migration, in PR 3 only (`scale_labels`), created with `--create-only` and trimmed (memory: plain `migrate dev`
  drops `POItem_one_line_per_item`); append-only rules for backfills do not apply (no backfill).
- Every existing test stays green; seeded shops are `EACH`-only, so their numbers must not move.

## Review Focus

- A cashier types `0,750`, `٠٫٧٥٠`, `.75` or `0.7505`: the first three are 750 g, the last is refused, never 7505 g.
  Test: Task 1 unit cases.
- A KG line with a line discount, then a sale discount, then a partial refund: VAT and totals still reconcile.
  Test: Task 3 integration.
- Profit for a KG sale: cost per kg × grams ÷ 1000, not × grams. Test: Task 3 integration on the profit report.
- A purchase receipt of 12.5 kg at EGP 40/kg values EGP 500, not EGP 500,000. Test: Task 7 integration.
- A scale label whose item code is the EAN-13 of an EACH product, or whose check digit is wrong, never adds a line.
  Test: Task 10 unit and E2E.

---

## PR 1: selling by weight

### Task 1: `lib/quantity.ts`

**Files:** Create `lib/quantity.ts`; Test `tests/unit/quantity.test.ts`.

**Interfaces — Produces:**
- `KG_SCALE = 1000`
- `lineMinor(unitPriceMinor: number, qty: number, unitType: "EACH" | "KG"): number` — EACH: `multiply`; KG:
  `divideRoundHalfUp(BigInt(price) * BigInt(qty), 1000n)` through the existing `lib/money.ts` guards.
- `parseQtyInput(raw: string, unitType): number | null` — EACH: today's `normalizeQty`; KG: digits with optional
  `.`/`,`/`٫` and at most 3 decimals → grams, 1 … `MAX_QTY`.
- `formatQty(qty: number, unitType, locale): string` — EACH `"3"`; KG `"0.750 kg"` / `"0.750 كجم"` (Latin digits,
  as money is shown today).
- `qtyInputValue(qty, unitType): string` — the bare number for an input box (`"0.750"` / `"3"`).

- [ ] Failing unit tests: `lineMinor(12000, 750, "KG") === 9000`; `lineMinor(1, 500, "KG") === 1` (half up);
  `lineMinor(1, 499, "KG") === 0`; `lineMinor(150, 3, "EACH") === 450`; `lineMinor(99_999_99, 1_000_000, "KG")` ok;
  `parseQtyInput("0.750","KG") === 750`, `"0,750"`, `"٠٫٧٥٠"`, `".75"` → 750; `"0.7505"`, `"0"`, `"1000.001"`, `"abc"`
  → null; `parseQtyInput("3","EACH") === 3`, `"1.5"` EACH → null; `formatQty(750,"KG","en") === "0.750 kg"`,
  `formatQty(1500,"KG","ar") === "1.500 كجم"`.
- [ ] Implement; run → PASS; commit.

### Task 2: KG products

**Files:** `modules/catalog/schemas.ts` (allow `KG` when there are no variants; refuse `KG` with variants as
`UNIT_NOT_SUPPORTED`), `modules/catalog/import.ts` (unitType column accepts `KG`), product form unit select,
`app/(app)/pos/_lib/till.ts` (`TillItem.unitType`), i18n (`catalog.unit.KG` "Per kg" / "بالكيلو").
Tests: `tests/unit/catalog-validation.test.ts`, `tests/integration/catalog-*.test.ts` (create KG ok, KG + variants
refused), product import case.

- [ ] Failing tests → implement → PASS → commit.

### Task 3: money paths in sales

**Files:** `modules/sales/totals.ts`, `modules/sales/offline.ts`, `modules/sales/create.ts` (lines carry `unitType`
into totals), `modules/reports/sql.ts` (`lineValueSql(price, qty, unitType)` = `CASE WHEN unit='KG' THEN
round(price::numeric * qty / 1000) ELSE price::bigint * qty END`) and the profit queries in
`modules/reports/queries.ts:230-250`.
Test: `tests/integration/weighed-sale.test.ts` (create).

- [ ] Failing integration: KG product EGP 120.00/kg, cost 80.00/kg; sale of 750 g + one EACH item, line discount on
  the KG line, sale discount; totals and VAT as hand-computed; stock −750; refund 250 g; void of a second sale; profit
  report cost = 60.00 for 750 g; `expectReconciled`. An offline-built sale of 1,250 g (`buildOfflineSale`) replays to
  the same totals.
- [ ] Implement → PASS → commit.

### Task 4: till, receipts and refunds screens

**Files:** `app/(app)/pos/_components/till.tsx` (weight box; KG cart line keeps `qtyText`; `+`/`-` step 100 g),
`app/(app)/pos/_lib/till.ts` (`addToCart(cart, item, qty = 1)`, `setLineQty` per unit, `bumpQty` step by unit),
`modules/sales/receipt.ts` + `receipt-print.tsx` + Z-report and on-screen receipt (`unitType` on lines,
`formatQty`), `app/(app)/returns/_components/return-panel.tsx` (refund qty in kg for KG lines), i18n
(`pos.weight.title` "Weight (kg)" / "الوزن (كجم)", `pos.weight.add`, `pos.weight.invalid`).
Test: `tests/e2e/weighed-selling.spec.ts` (create).

- [ ] Failing E2E (fresh grocery shop through onboarding, KG product "Tomatoes" EGP 12.00/kg with stock 10 kg):
  search Tomatoes → weight box → type `0.750` → Enter → line shows `0.750 kg`, total 9.00; `+` → `0.850 kg`;
  charge exact cash; receipt shows `0.750`-style kg text; Returns: refund `0.250` kg → refund total 3.00 (the line
  is 0.850 kg × 12.00 = 10.20, so 0.250 → 3.00); Arabic till shows `كجم`.
- [ ] Implement → PASS; full gate; commit; push; PR 1; merge after review and CI.

## PR 2: stock, purchasing and reports in kg

### Task 5: inventory

**Files:** inventory DTOs gain `unitType` (stock list, ledger, low stock, counts, transfers, opening, import
preview) in `modules/inventory/*`; screens in `app/(app)/inventory/**` parse with `parseQtyInput` and show with
`formatQty`; `modules/inventory/import.ts` reads kg decimals for KG rows. Tests: extend
`tests/integration/inventory-*.test.ts` with a KG opening, adjustment −0.25 kg, transfer 1.5 kg, count 9.75 kg;
one E2E opening stock in kg.

### Task 6: purchasing

**Files:** `modules/purchasing/{orders,receipts,returns,invoices,rules}.ts` use `lineMinor` with the product's
unit; DTOs gain `unitType`; `app/(app)/purchasing/**` parse/format per unit; `app/(app)/purchasing/_lib/purchasing.ts`
totals through `lineMinor`; report SQL for purchases uses `lineValueSql` joined on `Product.unitType`. Tests: PO
12.5 kg × 40.00/kg = 500.00; receive 12.5 kg → stock +12,500 g, last cost 40.00/kg; return 2 kg; supplier invoice
value; Purchases received report value.

### Task 7: reports and CSV

**Files:** `modules/reports/queries.ts` quantity rows carry `unitType`; `app/(app)/reports/page.tsx` and
`modules/reports/csv.ts` format KG quantities as kg text; `getTopItemsToday` counts KG items by sale lines. Tests:
Products report row for a KG item shows `0.750 kg`; CSV the same; top items mixes a KG and an EACH item correctly.

- [ ] Each task: failing tests → implement → PASS → commit. End of PR 2: full gate, push, PR, merge.

## PR 3: scale labels and linked shops

### Task 8: scale-label setting (migration)

**Files:** `prisma/schema.prisma` (`scaleLabelsEnabled Boolean @default(false)`, `scaleLabelPrefixes String[]
@default(["20","21","22","23","24","25","26","27","28","29"])`, `scaleItemDigits Int @default(5)`,
`scaleValueKind ScaleValueKind @default(WEIGHT)`, enum `ScaleValueKind { WEIGHT PRICE }`), migration
`scale_labels` (`--create-only`, trim to these columns), `modules/org/scale.ts` (get/update, Owner only via
`shop.manage`, audit `settings.scale_labels.updated`), a "Scale labels" card on Settings → Shop. Tests: integration
update/no-op/denied; item digits 4–6; prefixes two digits starting with 2.

### Task 9: label parsing at the till

**Files:** `lib/scale-label.ts` (`parseScaleLabel(code, settings): { lookupCode: string; value: number } | null`,
EAN-13 check digit), the till's `find()` (a label is tried before the normal lookup: `lookupCode` = prefix + item
code is looked up as a barcode; it must be a KG item), `modules/sales/schemas.ts` + `totals.ts` + `create.ts`
(optional `labelTotalMinor` on a KG line), snapshot and offline carry the settings.

Decision (W6, price labels): grams = round(price × 1000 ÷ price per kg); the line's gross is the printed
`labelTotalMinor`, accepted by the server only when |labelTotalMinor − lineMinor(price, grams)| ≤ ceil(price per kg ÷
2000) (half a gram's worth), else 422 `LABEL_MISMATCH`. Weight labels send grams only.

Tests: unit parse (weight label, price label, bad check digit, unknown prefix, wrong length); unit totals with a
label total; integration sale with a label total accepted and one refused; E2E scanning a weight label and a price
label in a grocery shop.

### Task 10: linked-shop KG items

**Files:** `modules/integrations/inventory-sys/mapping.ts` (a `kg` base unit → `notSellableReason: "UNIT"`),
till message for that reason exists. Test: mapping unit test; integration sale refused for a synced KG item.

### Task 11: verification and PR 3

- [ ] Full gate; screenshots (grocery till weight box EN/AR, receipt, stock in kg); as-built note, known
  limitations update (remove the KG line), phase status; final whole-branch review; fix pass; PR 3; merge.
