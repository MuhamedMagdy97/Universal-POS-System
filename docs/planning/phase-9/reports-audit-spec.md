# Phase 9 / T9 — Reports and Audit Trail Specification

Status: **approved by the owner 2026-10-12.** Every decision in §3 is accepted as recommended: the eight reports (P1),
audit trail for Owner and Admin only (P6), profit and margin deferred (P12), T9 before T5 (P13). Data model and API:
[reports-audit-data-model-and-api.md](reports-audit-data-model-and-api.md). Screens and tests:
[reports-audit-ux-and-tests.md](reports-audit-ux-and-tests.md). Task plan: [reports-audit-plan.md](reports-audit-plan.md).

Source: `docs/planning/task-breakdown.md` (T9, deps T6–T8), `docs/product/requirements.md` ("8 canned reports, audit
trail"), `docs/quality/acceptance-criteria.md` (#1: a sale's receipt, ledger and report must match),
`docs/product/user-roles-permissions.md` (`reports.view`), and the as-built checkout, shift close and returns.

## 1. Key facts

- `modules/reports` is an empty stub. The requirements promise "8 canned reports, audit trail" but do not name them;
  §3 proposes the eight.
- The data exists: `Sale` and `SaleItem` (snapshots), `Payment`, `Refund` and `RefundItem`, `RegisterShift`
  (expected, counted, discrepancy), `CashMovement`, `InventoryMovement` and `AuditEvent` (append-only).
- Indexes already support date ranges: `Sale(orgId, branchId, createdAt)`, `AuditEvent(orgId, createdAt)`.
- **No timezone is stored.** `Organization` has `countryCode` (EG, SA) but no timezone. A "day" must be the shop's
  local day, not UTC (Cairo is UTC+2/+3 with DST, Riyadh is UTC+3).
- **No cost on sale lines.** `SaleItem` snapshots price and VAT but not cost (checkout D3). Profit and margin from
  today's `Product.costMinor` would be wrong after any cost change.
- `reports.view` is held by Owner, Admin, Manager and Reporting. Cashiers hold none.
- **T5 (purchasing) is not built.** `modules/purchasing` is a stub, though the `Supplier`, `PurchaseOrder` and
  `GoodsReceipt` tables exist. No purchase report is possible until T5.

## 2. Goal and success

An owner, admin, manager or reporting user can pick a branch (within their scope) and a date range and read eight
canned reports whose numbers match the receipts, the ledger and the shift closes to the piastre (acceptance #1). An
owner or admin can search the audit trail. Every report can be exported to CSV that opens correctly in Excel,
Arabic included.

Out of scope: charts beyond simple totals, scheduled or emailed reports, profit and margin (no cost snapshot),
purchase reports (T5 not built), custom report building.

## 3. Decisions

| # | Topic | Proposal |
|---|---|---|
| P1 | The eight reports | 1 **Sales summary** by day (sales count, gross, VAT, net, refunds, voids, net after refunds). 2 **Payments** by method (sales and refunds per cash, card, wallet). 3 **Products** (qty sold, qty refunded, net revenue, top first). 4 **Categories** (same, by category). 5 **Cashiers** (sales count and value per cashier). 6 **Shifts** (Z-report per shift: opening float, cash sales, pay-ins, pay-outs, drops, cash refunds, expected, counted, discrepancy and note). 7 **Refunds and voids** (each one with reason, method, by whom, paying till). 8 **VAT** (output VAT by rate for the period, refunds deducted). **Owner:** confirm or swap any of the eight. |
| P2 | Business day and timezone | A day runs midnight to midnight in the shop's timezone, derived from the country: EG → `Africa/Cairo`, SA → `Asia/Riyadh` (IANA names, so DST is handled). Computed in SQL with `AT TIME ZONE`. No migration. A per-org timezone setting can come later. **(rec)** |
| P3 | When a refund counts | On the day it was made, not the day of the sale (cash-book view, matches the shift close). A void removes its sale entirely from every report, because a voided sale never counts. **(rec)** |
| P4 | Scope | Branch picker limited to the user's membership scope, plus "All my branches" for users with `allBranches`. Reports never cross organizations. **(rec)** |
| P5 | Who sees reports | `reports.view` (Owner, Admin, Manager, Reporting). Cashiers do not. **(rec)** |
| P6 | Who sees the audit trail | The audit trail exposes who did what, including denied attempts. **(rec)** Owner and Admin only, through `users.manage`; no new permission. **Owner:** confirm, or add Manager. |
| P7 | Audit trail screen | Newest first, cursor-paged (50 per page), filtered by date range, actor, action (for example `sale.void`, `refund.create`, `shift.closed`, `*.permission.denied`) and entity. Metadata shown as key and value. Read-only (events are append-only already). **(rec)** |
| P8 | Date range limit | At most 366 days per query, so a report stays fast without materialized views. **(rec)** |
| P9 | CSV export | One CSV per report and for the audit trail, UTF-8 with BOM (Excel shows Arabic correctly), money as major units with two decimals, dates in the shop's timezone. **(rec)** |
| P10 | Money correctness | Every total is integer minor units summed in SQL; nothing is recomputed from prices. Tests assert each report against the same seeded sales, refunds, voids and shift closes. **(rec)** |
| P11 | Dashboard | Replace the placeholder dashboard with today's tiles for users with `reports.view`: net sales, sales count, refunds, open shifts. **(rec)** |
| P12 | Profit and margin | Deferred. Doing it right needs a cost snapshot on `SaleItem` (a migration and a checkout change). **Owner:** confirm deferring. |
| P13 | Purchases | No purchase report until T5 is built. **Owner:** decide whether T5 comes before or after T9. |

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Days split at UTC midnight, so a late-evening sale lands on the wrong day. | P2 timezone in SQL; test a sale at 23:30 Cairo time. |
| R2 | Report totals drift from receipts or shift closes. | P10: totals summed from the same rows the close uses; one test seeds a day and checks every report against it. |
| R3 | Slow queries over long ranges. | P8 limit; existing indexes; check query plans on a seeded volume. |
| R4 | The audit trail leaks data a role should not see. | P6 limits it to Owner and Admin; metadata never holds secrets (audit rule). |
| R5 | A branch-limited user sees another branch's numbers. | P4: every query filters by the user's branch scope; isolation tests per report. |
| R6 | CSV injection (a cell starting with `=`, `+`, `-` or `@` runs as a formula in Excel). | Prefix such cells with `'` on export; unit-tested. |

## 5. Interfaces (to be detailed in the API part)

- `GET /api/reports/{report}?branchId=&from=&to=` (`reports.view`) → JSON rows and totals; `&format=csv` → CSV.
  `{report}` is one of `sales-summary`, `payments`, `products`, `categories`, `cashiers`, `shifts`,
  `refunds-voids`, `vat`.
- `GET /api/audit?from=&to=&actor=&action=&entity=&cursor=` (`users.manage`) → newest first, 50 per page; `&format=csv`.
- Screens: `/reports` (report picker, branch, date range, table, totals, CSV button), `/audit`, and the dashboard tiles.

## 6. Next steps

1. ~~Owner answers P1, P6, P12 and P13~~ — done 2026-10-12, all as recommended.
2. Write `reports-audit-data-model-and-api.md` and `reports-audit-ux-and-tests.md`.
3. Write the task plan, then build with the same gates: lint, typecheck, unit, integration and route tests, E2E.
