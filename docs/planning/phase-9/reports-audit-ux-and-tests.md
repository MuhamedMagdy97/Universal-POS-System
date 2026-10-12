# Phase 9 / T9 — Reports and Audit Trail: Screens and Tests (as built)

Parent: [reports-audit-spec.md](reports-audit-spec.md). API and rules:
[reports-audit-data-model-and-api.md](reports-audit-data-model-and-api.md).

## 1. Screen: `/reports` ("Reports")

Header link **Reports** for roles with `reports.view` (Owner, Admin, Manager, Reporting). Others see "You can't view
reports".

The page is a Server Component driven by the URL: `?report=&branch=&from=&to=`. A plain GET form holds the controls,
so every view is a shareable link and the back button works.

| Control | Behaviour |
|---|---|
| Report | Eight tabs (a select on narrow screens), default **Sales summary**. |
| Branch | The user's branches; **All my branches** first when there is more than one. Hidden when there is one. |
| Dates | From and To (local dates), with quick picks: Today, Yesterday, This week, This month, Last month. Week starts Saturday (EG and SA). |
| Export CSV | A link to the same URL on `/api/reports/{report}?format=csv`. |

States: loading skeleton; empty ("No sales in this period"); range error (shown under the dates, the old table stays);
truncated ("Showing the first 500 rows. Export CSV for all of them").

Table: header row, a sticky **Total** row at the bottom, amounts right-aligned and LTR in both languages. Shift rows
with a non-zero discrepancy show it in the warning colour with the note. Open shifts show "Open" and no count.

The heading line reads "Cairo time" or "Riyadh time" so the day boundary is never a surprise.

## 2. Screen: `/audit` ("Audit trail")

Header link for `users.manage` (Owner, Admin). Filters: dates, actor (member picker), action (a select of known actions
plus "Denied attempts", which sends `*.permission.denied`), entity type. List columns: time, who, action, entity, and a
details toggle that shows metadata as key and value. **Older events** opens the next cursor page and **Newest** goes back
to the first (links, so the page stays a plain server render). **Export CSV** uses the
same filters.

Action names are shown as readable labels (`sale.void` → "Sale voided") from an i18n map; an unknown action shows its
raw name.

## 3. Dashboard

For `reports.view` users, four tiles for today across their branches: net sales, sales, refunds, open shifts. Each tile
links to the matching report for today. Others keep the greeting.

## 4. EN/AR

All strings are `reports.*` and `audit.*` keys in both dictionaries. Numbers, amounts, SKUs and sale numbers render LTR
inside RTL. CSV headers follow the user's language.

## 5. Tests

| Layer | File | Covers |
|---|---|---|
| Unit | `tests/unit/reports-timezone.test.ts` | country → zone; local date parsing (Arabic-Indic digits); range limits; quick-pick ranges, week starting Saturday |
| Unit | `tests/unit/reports-csv.test.ts` | BOM, CRLF, quoting of commas, quotes and newlines; injection prefix on `=`, `+`, `-`, `@`; numbers never prefixed; Arabic text round-trips |
| Unit | `tests/unit/audit-cursor.test.ts` | cursor encode/decode, malformed cursor refused |
| Integration | `tests/integration/reports.test.ts` | **One seeded day** (sales in cash, card, wallet and split; a partial refund on the same day; a refund the next day of an earlier sale; a void; pay-in, pay-out, drop; a closed shift with a short count) checked against all eight reports; the **acceptance #1 check**: sales summary gross = Σ receipts, payments cash − cash refunds + float ± movements = shift expected, VAT totals = Σ line VAT |
| Integration | `tests/integration/reports.test.ts` | **R1** a sale at 23:30 Cairo time on day D lands on D, not D+1; same for Riyadh |
| Integration | `tests/integration/reports.test.ts` ("scope") | **R5** a branch-scoped manager never sees another branch's rows; another org's data never appears; out-of-scope branch → 404 |
| Integration | `tests/integration/reports-routes.test.ts` | 401, 403 (cashier, plus `reports.permission.denied` written), 404 unknown report, 422 bad range, CSV headers and filename, `reports.exported` written |
| Integration | `tests/integration/audit-trail.test.ts` | newest first, paging without gaps or repeats across equal timestamps, each filter, Manager refused, other org's events never listed |
| E2E | `tests/e2e/reports.spec.ts` | a cashier sells two units of a run-specific item; the admin finds them in today's Products report and the till's open shift in Shifts (float + cash sales); CSV download starts; inverted range error; Arabic RTL; cashier has no link and is refused |
| E2E | `tests/e2e/audit.spec.ts` | a cashier's report request is refused; the admin finds it under "Denied attempts" with its metadata; manager has no link and is refused at `/audit` |

The E2E specs run as the seeded **admin** (it holds `reports.view` and `users.manage`, like the owner), since the
E2E setup signs in no owner. Other specs sell in parallel, so assertions look only at the run's own item and till.

**R3 query plans (as built):** `tests/integration/reports-perf.test.ts`, skipped unless `REPORTS_PERF=1`. It seeds
100 000 sales (one line and one cash payment each) and 2 000 refunds on one branch over a year, then runs every report
over 366 days. Result on the local PostgreSQL 16 (2026-10-12):

| Report | Time | Rows |
|---|---|---|
| sales-summary | 298 ms | 366 |
| payments | 180 ms | 3 |
| products | 123 ms | 1 |
| categories | 108 ms | 1 |
| cashiers | 56 ms | 1 |
| shifts | 14 ms | 0 |
| refunds-voids | 71 ms | 500 (capped) |
| vat | 97 ms | 1 |

The sales range query runs in 54 ms as a parallel sequential scan: the seeded org is most of the table and the range
covers all of it, so the planner skips the `(orgId, branchId, createdAt)` index. The plan also shows the day bounds
converted correctly (2025-03-11 00:00 Cairo = 2025-03-10 22:00 UTC). No index or materialized view is needed at this
volume; `Refund` still has no date index (§1).
