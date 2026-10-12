# Phase 9 / T9 — Reports and Audit Trail: Data Model and API

Parent: [reports-audit-spec.md](reports-audit-spec.md). Decisions P1–P13 are approved (2026-10-12). Items marked
**(new)** are design choices made here that the spec left open; they are listed again in §11 for the owner.

## 1. Data model

No migration. Every report reads existing rows:

| Report | Rows read |
|---|---|
| Sales summary, cashiers | `Sale` (`COMPLETED` only), `Refund`, `User.name` |
| Payments | `Payment` → `Sale`, `Refund.method` |
| Products, categories, VAT | `SaleItem` → `Sale`, `RefundItem` → `Refund`, `Product`, `ProductVariant`, `Category` |
| Shifts | `RegisterShift`, `Register`, `CashMovement`, `Payment`, `Refund`, `User.name` |
| Refunds and voids | `Refund`, `Sale` (`VOIDED`), `User.name`, `Register` |
| Audit trail | `AuditEvent`, `User.name` |

Existing indexes cover the date filters: `Sale(orgId, branchId, createdAt)`, `AuditEvent(orgId, createdAt)`.
**(new)** `Refund` has no date index; refunds are few next to sales, so none is added now. Revisit if the R3 query-plan
check shows a sequential scan on a seeded volume.

## 2. Business day (P2)

The shop's timezone comes from `Organization.countryCode`: `EG → Africa/Cairo`, `SA → Asia/Riyadh`
(`modules/reports/timezone.ts`, one map, unit-tested).

**Gotcha:** Prisma `DateTime` columns are `TIMESTAMP(3)` *without* time zone and hold UTC. In SQL the local day is
therefore

    (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE $tz)::date

The first `AT TIME ZONE` marks the value as UTC, the second converts it to local wall time. Writing only one gives the
wrong day.

`from` and `to` are local dates (`YYYY-MM-DD`), both inclusive. The range filter stays index-friendly by converting the
bounds, not the column:

    "createdAt" >= ($from::timestamp AT TIME ZONE $tz) AT TIME ZONE 'UTC'
    AND "createdAt" < (($to::date + 1)::timestamp AT TIME ZONE $tz) AT TIME ZONE 'UTC'

`to − from` must be at most 365 days (366 calendar days, P8), and `from ≤ to`. Defaults when omitted: today (local) for
both.

## 3. Which rows count (P3, P10)

- A sale counts on the local day of `Sale.createdAt`, only when `status = COMPLETED`. A voided sale counts nowhere in the
  money reports (P3); it appears only in the refunds-and-voids list and as an informational void count.
- A refund counts on the local day of `Refund.createdAt`, with `Refund.method`, against `Refund.branchId` (always the
  sale's branch, since the paying till must be in that branch).
- Money columns as stored: `Sale.totalMinor` is gross (VAT included), `Sale.subtotalMinor` is net, `Sale.vatMinor` is
  VAT; `Refund.totalMinor` is gross refunded, `Refund.vatMinor` its VAT. Net refunded = `totalMinor − vatMinor`.
- Every sum is `SUM(...)::bigint` in SQL, returned as a JS `number` after a `Number.isSafeInteger` check. Nothing is
  recomputed from prices.

## 4. The eight reports (P1)

Common filters: `branchId` (optional, §6), `from`, `to`. Each response is `{ report, currency, timezone, from, to,
branchId, rows, totals, truncated }`. Amounts are integer minor units.

| `{report}` | One row per | Columns | Sort |
|---|---|---|---|
| `sales-summary` | local day with any sale, refund or void | `day, salesCount, grossMinor, vatMinor, netMinor, refundsCount, refundsMinor, voidsCount, voidsMinor, netAfterRefundsMinor` | day asc |
| `payments` | payment method | `method, salesCount, salesMinor, refundsCount, refundsMinor, netMinor` | fixed: cash, card, wallet |
| `products` | product + variant | `productId, variantId, sku, name, nameAr, qtySold, qtyRefunded, grossMinor, refundsMinor, netMinor` | `netMinor` desc |
| `categories` | category of the product | `categoryId, name, nameAr, qtySold, qtyRefunded, grossMinor, refundsMinor, netMinor` | `netMinor` desc |
| `cashiers` | `Sale.cashierId` | `userId, name, salesCount, grossMinor, averageMinor, refundsCount, refundsMinor` | `grossMinor` desc |
| `shifts` | shift opened in the range | `shiftId, registerName, status, openedAt, openedBy, closedAt, closedBy, openingFloatMinor, cashSalesMinor, payInMinor, payOutMinor, dropMinor, cashRefundsMinor, expectedCashMinor, countedCashMinor, discrepancyMinor, discrepancyNote` | `openedAt` asc |
| `refunds-voids` | each refund and each void | `kind (REFUND/VOID), at, saleNumber, totalMinor, vatMinor, method, reference, reason, byName, registerName` | `at` desc |
| `vat` | VAT rate (`SaleItem.vatRateBp`) | `rateBp, netSalesMinor, vatSalesMinor, netRefundsMinor, vatRefundsMinor, netVatMinor` | rate desc |

Rules per report:

- **sales-summary:** `voidsCount`/`voidsMinor` are sales voided that day (`voidedAt`), shown for information and *not*
  subtracted (their sale is already excluded). `netAfterRefundsMinor = grossMinor − refundsMinor`.
- **payments:** sales side sums `Payment.amountMinor` (applied cash, so change is never counted). `salesCount` counts
  sales with that method, so a split-tender sale counts once per method.
- **products:** grouped by `(productId, variantId)`; names and SKU are the **current** catalog ones **(new)**, so a
  renamed product shows one row, not two. `qtySold`/`grossMinor` from sales in range; `qtyRefunded`/`refundsMinor` from
  refunds in range (P3), so a row can have refunds and no sales.
- **categories:** **(new)** by the product's **current** `categoryId` (sale lines snapshot no category). Products
  without a category go to one "Uncategorized" row (`categoryId: null`). A child category is its own row; no roll-up to
  the parent.
- **cashiers:** `averageMinor = round(grossMinor / salesCount)`, half up. Refunds are by `Refund.processedById`.
- **shifts:** **(new)** a shift is in range by the local day of `openedAt`. The cash breakdown reuses
  `cashBreakdown()` from `modules/registers/shifts.ts` (exported for this, no logic copied), so a closed shift's
  `expectedCashMinor` here equals the stored one (acceptance #1; tested). An open shift shows its live expected cash and
  `null` counted and discrepancy.
- **refunds-voids:** voids by `voidedAt`, refunds by `createdAt`. `reference` is the manual slip or wallet id already
  stored; never card data.
- **vat:** refunds use the rate of the sale line they refund (`RefundItem → SaleItem.vatRateBp`). **(new)** Rate 0 is
  one row labelled "0% (zero-rated or exempt)": sale lines do not snapshot the VAT category, so the two cannot be told
  apart. `netVatMinor = vatSalesMinor − vatRefundsMinor`.

Totals: one `totals` object with the column sums over **all** rows, computed in SQL, even when `rows` is truncated.

**Row cap (new).** JSON returns at most 500 rows (`truncated: true` beyond that). CSV returns every row. Only
`products`, `refunds-voids` and `shifts` can reach the cap in practice.

## 5. Audit trail (P6, P7)

`GET /api/audit` lists `AuditEvent` rows where `orgId = ctx.orgId`, newest first, 50 per page.

| Filter | Meaning |
|---|---|
| `from`, `to` | local dates, as §2, at most 366 days |
| `actor` | user id (picker lists the org's members) |
| `action` | exact action, or a suffix pattern `*.permission.denied` |
| `entityType`, `entityId` | exact match (`entityId` needs `entityType`) |
| `cursor` | opaque, base64url of `createdAt|id` from the last row |

Order `createdAt DESC, id DESC`; the next page is `(createdAt, id) < (cursor)`. Each row: `id, at, actorUserId,
actorName, action, entityType, entityId, branchId, requestId, metadata`. Metadata is shown as stored (already redacted at
write time). Events with `orgId = null` (pre-tenant auth events) are never listed.

## 6. Scope and permissions (P4, P5)

- Reports: `reports.view` (Owner, Admin, Manager, Reporting). The service checks it and audit-logs a refusal as
  `reports.permission.denied` (same pattern as `modules/sales/access.ts`).
- `branchId` given: must pass `canAccessBranch` (else 404, as elsewhere). `branchId` omitted: **all branches in the
  user's scope** (**(new)**: P4 offered "All my branches" to `allBranches` users only; a Manager scoped to two branches
  gets the same option over just those two). A user with no branch in scope gets 404.
- Audit trail: `users.manage` (Owner, Admin). No branch filter: the whole org, since only org-wide roles hold it.
  Refusal logs `audit.permission.denied`.
- **(new)** Exports are audited: `reports.exported` (`report`, `from`, `to`, `branchId`) and `audit.exported`
  (filters). Viewing on screen is not logged.

## 7. CSV (P9, R6)

- UTF-8 with BOM, CRLF line ends, RFC 4180 quoting, header row in the user's language (EN or AR).
- Money: major units with two decimals (`toMajorString`), no thousands separator. Dates: `YYYY-MM-DD`, times
  `YYYY-MM-DD HH:mm` in the shop's timezone.
- Formula injection: a text cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`. Numbers are written
  by the exporter itself and are never prefixed (a negative discrepancy stays a number).
- Filename: `{report}_{from}_{to}.csv`, `Content-Disposition: attachment`.
- A totals row at the end, labelled "Total".

## 8. Endpoints

| Method + path | Permission | Query | Success | Errors |
|---|---|---|---|---|
| `GET /api/reports/{report}` | `reports.view` | `branchId?, from?, to?, format? (json\|csv)` | 200 report JSON, or CSV | 404 unknown report, branch out of scope; 422 bad dates, range > 366 days, `from > to`; 403; 401 |
| `GET /api/audit` | `users.manage` | `from?, to?, actor?, action?, entityType?, entityId?, cursor?, format?` | 200 `{ rows, nextCursor }`, or CSV (all matching rows, capped at 50 000) | 422 bad filter or cursor; 403; 401 |

Both are GET only and have no side effects other than the export audit row.

## 9. Module layout

    modules/reports/
      index.ts         public API: getReport, listAuditEvents, getDashboardTiles, REPORT_NAMES
      timezone.ts      country → IANA zone, local-date parsing and range checks
      access.ts        reports.view / users.manage checks, branch scope → branch id list
      queries/*.ts     one file per report: a single $queryRaw with Prisma.sql fragments
      audit-trail.ts   cursor paging and filters
      csv.ts           pure CSV writer (BOM, quoting, injection guard)
      schemas.ts       zod for query strings

`modules/registers` exports `cashBreakdown` for the shifts report; reports never write.

## 10. Dashboard tiles (P11)

`getDashboardTiles(ctx)` for `reports.view` users, today (local) over all branches in scope: net sales
(`grossMinor − refundsMinor`), sales count, refunds total, open shifts count. Users without `reports.view` keep the
current greeting.

## 11. New choices for the owner to check

1. Product names and categories in reports are the current catalog ones, not the names at sale time.
2. 0% VAT is one row: zero-rated and exempt are not split (no snapshot). A split needs `vatCategory` on `SaleItem`
   (a migration, like the cost snapshot deferred in P12).
3. The shifts report lists shifts by the day they **opened**.
4. "All my branches" is offered to every user with more than one branch in scope.
5. JSON shows at most 500 rows; CSV has all of them.
6. CSV exports are recorded in the audit trail.
