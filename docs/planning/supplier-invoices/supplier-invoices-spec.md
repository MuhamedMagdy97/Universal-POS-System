# Supplier invoices and input VAT — Specification

Status: **approved by the owner 2026-10-20.** The owner asked that every choice be taken as recommended; those are
marked **(rec)** and can still be overridden. Builds on [purchasing-spec.md](../phase-10/purchasing-spec.md) (P1–P15),
[purchase-returns-spec.md](../purchase-returns/purchase-returns-spec.md) (R1–R13) and
[supplier-payments-spec.md](../supplier-payments/supplier-payments-spec.md) (S1–S15).

## 1. Goal

An owner or admin records the invoices and credit notes a supplier sends, with their input VAT; pays them (a payment is
allocated across open invoices, oldest first by default); sees each invoice as open, paid or overdue; and sees the
month's input VAT next to the output VAT from sales, so the VAT owed to the tax authority is visible.

Out of scope: invoice lines (an invoice is a header with totals), payment terms on the supplier, scanning or e-invoice
import (ETA / ZATCA purchase invoices), several VAT rates on one invoice, multi-currency, filing a VAT return.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| I1 | Documents | One table for **invoices** and **credit notes** (`kind`). Fields: supplier, the supplier's document number (1–40 characters), issue date (shop-local, not in the future), due date (invoices only, optional, ≥ issue date; none = never overdue), net, VAT, total = net + VAT, note. Amounts in minor units, net ≥ 0, VAT ≥ 0, total > 0. **(rec)** |
| I2 | Number | Unique per supplier and kind, ignoring case, among documents that are not voided (a voided number can be entered again, correctly). 409 `INVOICE_NUMBER_TAKEN`. **(rec)** |
| I3 | Linked receipts | An invoice links zero or more goods receipts of **that supplier** (any branch). A receipt is on at most one live (not voided) invoice: 409 `RECEIPT_ALREADY_INVOICED`. Zero receipts is allowed for freight or services. The net defaults to the linked receipts' value (Σ qty × unit cost, before VAT, P13). **(rec)** |
| I4 | Credit notes | Optional. A credit note may link **one purchase return** of that supplier (net defaults to the return's value; a return is on at most one live credit note: 409 `RETURN_ALREADY_CREDITED`) and may name **one open invoice** it reduces (its total may not exceed that invoice's open amount: 409 `AMOUNT_EXCEEDS_OPEN`). A return without a credit note keeps counting at cost, as today. **(rec)** |
| I5 | Input VAT | Default = VAT on the net at the shop's VAT rate (`vatOnNet`, 14% EG / 15% SA), the same rounding as sales. Editable: anything from **0** (a supplier that is not VAT-registered, or zero-rated goods) up to the default **+ 1 major unit** (100 minor). Why: suppliers round VAT per line, so a real invoice can be a few piastres/halalas above the rate on the total; anything more would claim more input VAT than the rate allows. Above the cap: 422 `VAT_ABOVE_RATE`. The screen warns (does not refuse) when VAT is below the default. **(rec)** |
| I6 | Append-only | Never edited or deleted (DB trigger). A mistake is undone by **voiding** (reason required), then entering the document again. Voiding sets `voidedAt/By/Reason` once; the trigger allows nothing else. Voiding an already-voided document answers 200 with no change (idempotent). Payments allocated to a voided invoice become unallocated credit; credit notes naming it keep counting on the balance. **(rec)** |
| I7 | Balance basis | **Received basis plus invoice adjustments** (rather than switching suppliers to "invoiced − payments"). Balance = value received − value returned (at cost, as S1) **+ for each live invoice: total − value of its linked receipts** **− for each live credit note: total − value of its linked return** − payments + reversals. So an invoice *replaces* the cost of the receipts it covers by what the supplier actually billed (cost + VAT ± price difference); an uninvoiced receipt keeps counting at cost. Why: a supplier with no invoices keeps exactly today's balance; an owner who starts entering invoices mid-way does not see years of uninvoiced receipts vanish (which "invoiced − payments" would do), and paying an invoice's VAT does not push the balance negative (which a pure received basis would do). History never changes: the invoice's effect falls on its issue date, a void reverses it on the void date. **(rec)** |
| I8 | Uninvoiced receipts | The supplier page shows the receipts not on a live invoice and their value; the Supplier balances report has an **Uninvoiced receipts** column (as of the end of the range). **(rec)** |
| I9 | Allocation | A payment can be allocated across open invoices of its supplier when it is recorded; the form pre-fills **oldest first** (by due date, then issue date, then number) up to the amount, and every line is editable. A payment's unallocated remainder can be allocated later (e.g. a deposit paid before the invoice arrived). Each allocation ≤ the invoice's open amount (409 `AMOUNT_EXCEEDS_OPEN`); their sum ≤ the payment's unallocated amount (409 `AMOUNT_EXCEEDS_UNALLOCATED`). Allocations are append-only; a reversed payment's allocations stop counting. Allocation never changes the balance, only which invoices are paid. **(rec)** |
| I10 | Invoice status | Computed: open amount = total − live allocations − live credit notes naming it. **Void**; **Paid** (open ≤ 0); **Overdue** (open > 0 and due date before today, shop timezone); otherwise **Open** (with the paid part shown). **(rec)** |
| I11 | Who | As supplier payments (S3): `purchases.manage` with a membership covering all branches; branch-limited admins and managers are refused (403, audited `purchasing.permission.denied`). Writes refused for a shop linked to the inventory system (409 `MANAGED_BY_INVENTORY`). Archived suppliers allowed (S10). **(rec)** |
| I12 | Idempotency | Creating a document, recording a payment with allocations and allocating later need an `Idempotency-Key`: the same key and body replay (200); another body answers 409 `IDEMPOTENCY_CONFLICT`. Concurrent writes for one supplier are serialised by a transaction-scoped advisory lock on the supplier, so the "at most one live invoice per receipt" and "≤ open amount" checks cannot race. **(rec)** |
| I13 | Audit | `purchasing.supplier_invoice.recorded` / `.voided` (kind, number, net, VAT, total, receipts, return, invoice), `purchasing.supplier_payment.allocated` (payment, allocations). **(rec)** |
| I14 | Input VAT report | **Input VAT** in Reports, right after *VAT summary*, gated like *Supplier balances* (`reports.view` + `purchases.manage`, every branch). One row per shop-local month of the issue date: invoices count, invoice net, invoice VAT, credit-note net, credit-note VAT, **input VAT** (invoice VAT − credit-note VAT), **output VAT** (sales VAT − refund VAT in that month, every branch — the same figures as *VAT summary*), and **net VAT** (output − input; positive = owed to the tax authority). Voided documents are left out entirely (re-run a month after a void). CSV and totals like every report. **(rec)** |
| I15 | Statement | New entries: **Invoice** and **Credit note** on the issue date (details: number, total, receipts it covers; amount column = the balance effect, I7) and **Invoice void** / **Credit note void** on the void's local day. **(rec)** |
| I16 | Screens | On `/purchasing/suppliers/{id}`: an **Invoices** section (number, kind, dates, total, VAT, paid, open, status, Void), a **New invoice / New credit note** form (pick receipts / a return, net and VAT pre-filled, editable), the payment form gains an allocation table, and each payment with an unallocated remainder gets **Allocate**. EN/AR, RTL. **(rec)** |

## 3. Data

- `enum SupplierDocumentKind { INVOICE CREDIT_NOTE }`.
- `SupplierInvoice` (orgId, supplierId, kind, number, issuedOn `date`, dueOn `date`?, netMinor, vatMinor, totalMinor,
  note, purchaseReturnId?, appliesToInvoiceId?, idempotencyKey, requestHash, createdById, createdAt, voidedAt?,
  voidedById?, voidReason?). Unique (orgId, idempotencyKey); partial unique index (orgId, supplierId, kind,
  lower(number)) where not voided. Composite FKs on (orgId, supplierId), (orgId, purchaseReturnId),
  (orgId, appliesToInvoiceId).
- `SupplierInvoiceReceipt` (orgId, invoiceId, goodsReceiptId): the receipts an invoice covers. Unique (invoiceId,
  goodsReceiptId).
- `SupplierPaymentAllocation` (orgId, paymentId, invoiceId, amountMinor > 0, idempotencyKey, requestHash,
  createdById, createdAt). Unique (orgId, idempotencyKey, invoiceId).
- CHECKs: total = net + VAT, net ≥ 0, VAT ≥ 0, total > 0, number 1–40 characters, note ≤ 500, a credit note has no
  due date and an invoice no return / applied invoice, void columns all set or all null.
- Triggers: links and allocations append-only (`pos_reject_mutation`); `SupplierInvoice` rejects deletes and any update
  other than setting the void columns once. One migration.

## 4. API

- `GET /api/purchasing/suppliers/{id}/invoices` → `{ invoices[], uninvoicedReceipts[], uncreditedReturns[] }`.
- `POST /api/purchasing/suppliers/{id}/invoices` (Idempotency-Key) body `{ kind, number, issuedOn, dueOn?, netMinor,
  vatMinor, note?, goodsReceiptIds?, purchaseReturnId?, appliesToInvoiceId? }` → 201 `{ invoiceId }`, 200 on replay.
- `POST /api/purchasing/suppliers/{id}/invoices/{invoiceId}/void` body `{ reason }` → 200.
- `POST /api/purchasing/suppliers/{id}/payments` gains `allocations?: [{ invoiceId, amountMinor }]`.
- `POST /api/purchasing/suppliers/{id}/payments/{paymentId}/allocations` (Idempotency-Key) body
  `{ allocations: [{ invoiceId, amountMinor }] }` → 201, 200 on replay.
- `GET /api/reports/input-vat?from&to[&format=csv&locale]`.

## 5. Tests

- Unit: default and maximum input VAT; oldest-first allocation; invoice status; balance effects of invoices, credit
  notes and voids in the running balance.
- Integration: another org's supplier, receipt, return, invoice or payment answers 404; idempotent replay and key
  conflict; number unique until voided; a receipt on one live invoice only; VAT above the cap refused; void is
  idempotent, releases allocations and reverses the balance effect; rows cannot be updated or deleted; allocation
  caps; statement and Supplier balances agree; Input VAT report totals by month.
- E2E: receive a PO, enter its invoice with VAT, pay it (allocation pre-filled), see it Paid and the statement balance
  back at zero.
