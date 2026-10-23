# Offline till: slice 4 as built (back office: review list, late sales on the shift report)

Spec: `offline-till-spec.md` (OF13, OF14, slice 4). This covers the back-office half of slice 4 only; the till's
close guard and device report (OF14) are a separate change.

## What exists

- **Permission** `sales.review` (Owner, Admin, Manager) in `lib/auth/permissions.ts`.
- **Offline sales to review** (`/reports/offline-review`, header link "Offline review" next to Reports and Audit
  trail). `listOfflineReview(ctx, { cursor })` in `modules/sales/review.ts`: sales with any `offlineFlags`, in the
  caller's branches (`branchesInScope`), newest received first, 50 per page with the audit trail's cursor. Details
  come from the `sale.offline.flagged` audit rows; the screen shows per flag what OF13's "Manager sees" column asks:
  - `PRICE_CHANGED`: line (item name and SKU), sold price, current price, difference (per unit).
  - `ITEM_ARCHIVED`: item.
  - `STOCK_NEGATIVE`: item, resulting quantity (at replay).
  - `DISCOUNT_OVER_LIMIT`: cashier, discount, limit now.
  - `LATE_FOR_CLOSED_SHIFT`: shift (register, opened, closed), sale, cash effect (cash applied to the sale).
  - `STALE_SNAPSHOT`, `CLOCK_SKEW`: sale with the snapshot / sold / received / shift-opened times.
  - `TOTALS_DIFFER`: the till's total and the total at today's rates.
- **Mark reviewed**: `markOfflineSaleReviewed(ctx, saleId)` appends a `sale.offline.reviewed` audit row (Sale and
  AuditEvent are append-only, so no column is updated); the list leaves out sales that have one. The sale row is
  locked so two managers write one row; repeating it is a no-op. Same permission and branch scope as the list.
  Refusals are audited as `sales.permission.denied`.
- **Shift report late offline sales** (OF13 "Shift closed meanwhile"): the Z-report (`getZReport`) and the Shifts
  report now show cash sales **as at the close**, so the terms add up to the stored expected cash again, and beside
  the stored expected / counted / difference: `lateOfflineSales` (count), `lateOfflineCashMinor` and
  `correctedExpectedCashMinor` (stored expected + late cash). The stored close is never rewritten. A late sale is
  one with the `LATE_FOR_CLOSED_SHIFT` flag. The printed Z-report adds the two lines only when there is a late sale.
- No migration.
- Tests: `tests/integration/offline-sales.test.ts` (late sale on the Z-report and Shifts report; review list per
  flag, permission, tenant and branch isolation, mark reviewed), `tests/e2e/offline-review.spec.ts`.

## Deviations

1. **Route under Reports** (`/reports/offline-review`) rather than a new "Sales" area: there is no sales back-office
   section yet, and the reports header is where the audit trail lives.
2. **`ITEM_ARCHIVED` shows no "archived at"**: slice 1's flag row records only the SKUs, and the catalog keeps no
   archive time on the product. The audit trail's `catalog.product.archived` row has it.
3. **Reviewed sales leave the list** (no "show reviewed" filter); the audit trail lists `sale.offline.reviewed`.
4. **"Rejected" entries** (hard refusals) never reach the server; they stay on the device (slice 2/3).
5. The list has no index on `offlineFlags`; it scans the shop's sales in scope. A partial index can follow if needed.
