# Supplier payments and balances — Specification

Status: **approved by the owner 2026-10-20.** The owner asked that every choice be taken as recommended; those are
marked **(rec)** and can still be overridden. Builds on [purchasing-spec.md](../phase-10/purchasing-spec.md) (P1–P15)
and [purchase-returns-spec.md](../purchase-returns/purchase-returns-spec.md) (R1–R13).

## 1. Goal

An owner or admin sees what the shop owes each supplier, records the payments made to them, and corrects a mistaken
payment with a reversal. A supplier page shows a statement (goods received, goods returned, payments, running
balance) for a date range, and a **Supplier balances** report lists every supplier's opening balance, movements and
closing balance, with CSV.

Out of scope: supplier invoices and invoice matching, credit notes as documents, payment terms and due dates, paying
from a till, multi-currency, allocating a payment across several POs, editing or deleting a payment.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| S1 | Balance | Balance owed to a supplier = value received (goods receipt lines at their received unit cost) − purchase returns (at their stored unit cost, R4) − payments + reversed payments. Positive = the shop owes the supplier; negative = the supplier owes the shop (overpaid or returns after payment). Computed from the source rows every time; no stored running total to drift. **(rec)** |
| S2 | One account per supplier | Suppliers are org-wide, so the account is too: receipts and returns from every branch count, and a payment has no branch. **(rec)** |
| S3 | Who | `purchases.manage` (Owner, Admin) for the statement, payments, reversals and the report. Because the account spans branches, the caller's membership must cover **all branches**; a branch-limited admin is refused (403, audited as `purchasing.permission.denied` / `reports.permission.denied`). **(rec)** |
| S4 | Payment fields | Amount (> 0, minor units), method `CASH`, `BANK_TRANSFER`, `CARD`, `CHEQUE`, `OTHER`; date (shop-local `YYYY-MM-DD`, not in the future); reference (≤ 80, e.g. cheque or transfer number); note (≤ 500). **(rec)** |
| S5 | Allocation | Unallocated by default: a payment reduces the supplier balance, not a PO. An optional PO link (same supplier, same org) is for reference only and shows on the statement; it does not change the PO. **(rec)** |
| S6 | Overpaying | Allowed: the balance goes negative (a credit with the supplier), e.g. a deposit before delivery. The form shows the current balance. **(rec)** |
| S7 | Till cash | **Supplier payments do not touch till cash or shifts.** They are back-office records; a supplier paid in cash from a drawer is recorded by the cashier as a cash pay-out on the shift as today, and separately here by the owner. Linking the two is a later feature. **(rec)** |
| S8 | Idempotency | `POST …/payments` and `POST …/payments/{id}/reverse` require an `Idempotency-Key`. The same key and body replay the first result (200); the same key with another body answers 409 `IDEMPOTENCY_CONFLICT`. Stored as `SupplierPayment.requestHash`, like receipts (P10). **(rec)** |
| S9 | Append-only | `SupplierPayment` rows are never updated or deleted (DB trigger). A mistake is corrected by a **reversal**: a new row with `reversalOfId` set, the same amount and method, dated the day it is recorded, with a required reason. A payment is reversed at most once (unique `reversalOfId`, 409 `PAYMENT_ALREADY_REVERSED`); a reversal cannot itself be reversed (409 `PAYMENT_NOT_REVERSIBLE`) — record a new payment instead. **(rec)** |
| S10 | Archived suppliers | Payments and reversals are allowed for an archived supplier (settling an old account is normal). **(rec)** |
| S11 | Linked shop | Refused for a shop linked to the inventory system (integration spec I18) with 409 `MANAGED_BY_INVENTORY`, like every purchasing write. Reading the statement and the report still works. **(rec)** |
| S12 | Audit | `purchasing.supplier_payment.recorded` (supplier, amount, method, date, PO) and `purchasing.supplier_payment.reversed` (supplier, payment reversed, amount, reason). **(rec)** |
| S13 | Statement | Entries in the date range, oldest first: each goods receipt (PO number, value), each purchase return (return number, value), each payment and reversal (method, reference, PO). An opening balance (everything before the range) and a closing balance; each entry carries the running balance. Receipts and returns fall on their shop-local day; payments on their date. Ties on one day go in the order they were recorded. Range rules as for reports (max 366 days, shop timezone); default this month. **(rec)** |
| S14 | Report | **Supplier balances** in Reports, gated like *Purchases received* (`reports.view` + `purchases.manage`): one row per supplier with an opening balance or movements in the range — Opening, Received, Returned, Paid (net of reversals), Closing. Totals and CSV like every report. The account is org-wide (S2), so the report always covers every branch; a branch filter is ignored. **(rec)** |
| S15 | Screens | `/purchasing/suppliers/{id}`: supplier details, balance, statement with a date filter, **Record payment** form and a **Reverse** button on each payment (with a reason). The suppliers list links each supplier to it (an **Account** button); balances for every supplier are in the report (S14). EN/AR, RTL. **(rec)** |

## 3. Data

- `enum SupplierPaymentMethod { CASH BANK_TRANSFER CARD CHEQUE OTHER }`.
- `SupplierPayment` (orgId, supplierId, amountMinor, method, paidOn `date`, reference, note, purchaseOrderId?,
  reversalOfId?, idempotencyKey, requestHash, createdById, createdAt). Unique (orgId, idempotencyKey) and
  (orgId, reversalOfId). Composite FKs on (orgId, supplierId), (orgId, purchaseOrderId), (orgId, reversalOfId).
- CHECKs: `amountMinor > 0`, reference ≤ 80 and note ≤ 500 characters, `reversalOfId <> id`.
- Append-only trigger (`pos_reject_mutation`), like receipts and returns. One migration.

## 4. API

- `GET /api/purchasing/suppliers/{id}/statement?from&to` → `{ supplier, currency, timezone, from, to,
  openingMinor, closingMinor, balanceMinor, entries[] }`.
- `POST /api/purchasing/suppliers/{id}/payments` (Idempotency-Key) body `{ amountMinor, method, paidOn,
  reference?, note?, purchaseOrderId? }` → 201 `{ paymentId }`, 200 on replay. Errors: 404 (supplier or PO not in
  the org, or PO of another supplier), 422 (`PAYMENT_DATE_IN_FUTURE`, bad fields), 403, 409 `MANAGED_BY_INVENTORY`.
- `POST /api/purchasing/suppliers/{id}/payments/{paymentId}/reverse` (Idempotency-Key) body `{ reason }` → 201
  `{ paymentId }` (the reversal), 200 on replay. Errors: 404, 409 `PAYMENT_ALREADY_REVERSED` /
  `PAYMENT_NOT_REVERSIBLE`.
- `GET /api/reports/supplier-balances?from&to[&format=csv&locale]`.

## 5. Tests

- Unit: balance and running-balance math (receipts, returns, payments, reversals, opening balance).
- Integration: payment lowers the balance and is audited; idempotent replay and key conflict; reversal restores the
  balance, only once, never of a reversal; rows cannot be updated or deleted; another org's supplier, PO or payment
  answers 404; a PO of another supplier is refused; manager and branch-limited admin refused; future date refused;
  the statement's opening/closing and running balance; the report's rows and totals match the statements.
- E2E: receive a PO, record a payment on the supplier page, see it in the statement with the new balance, reverse it.
