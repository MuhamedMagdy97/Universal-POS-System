# Phase 10 / T5 — Purchasing: Screens and Tests

Spec: [purchasing-spec.md](purchasing-spec.md). Back-office screens in EN and AR (RTL), Server Actions over
`modules/purchasing`, the same patterns as `/returns` and `/inventory`.

## 1. Screens

**Navigation.** A "Purchasing" header link for anyone with `purchases.manage` or `purchases.receive`.

**`/purchasing` (list).**
- Filters: status (Open by default; Draft, Received, Cancelled, All), branch (in scope), supplier. Search by number.
- Columns: number, supplier, branch, status badge, ordered/received units, total, date.
- A row links to its detail. "New purchase order" and "Suppliers" buttons appear for `purchases.manage`.
- Empty state: "No open purchase orders".

**`/purchasing/new` and `/purchasing/{id}` (detail and editor).**
- Header: number, status, supplier, branch, dates, note.
- When editable (P4) and the user has `purchases.manage`: a supplier picker (active only), a branch picker (only on
  new), and lines added by search or scan (the catalog search used by inventory). Each line has qty and unit cost,
  with a running line value and PO total. Save keeps the PO a draft.
- Actions by state, each through the shared confirm dialog: **Mark as ordered** (DRAFT); **Cancel** (DRAFT, or ORDERED
  with nothing received); **Close short** (PARTIALLY_RECEIVED, needs a reason); **Receive** (ORDERED or PARTIALLY_RECEIVED,
  for `purchases.receive`).
- Read-only lines show ordered, received and outstanding. A receipts section lists who received what and when.

**`/purchasing/{id}/receive`.**
- One row per line with outstanding > 0: item, SKU, outstanding, a qty input prefilled with the outstanding amount,
  and a unit cost input prefilled with the PO cost.
- "Receive nothing" zeroes all inputs, so the user can then type only what arrived. Optional note.
- The submit button reads "Receive N units". One idempotency key per form is kept across retries (R1). On success the
  user returns to the detail with a "Received" notice; on 409 the error shows and the page reloads current
  outstanding quantities.

**`/purchasing/suppliers`.** A table (name, phone, email, tax number, status) with an inline create and edit form and
Archive/Restore. Needs `purchases.manage`.

**`/reports`.** The new "Purchases received" report shows only for users with `purchases.manage`.

All money is shown in the org currency with integer minor-unit math (`lib/money`). Numbers and SKUs are `dir="ltr"` in
Arabic.

## 2. Tests

**Unit (`tests/unit/purchasing-rules.test.ts`, `purchasing-validation.test.ts`):** line merging, outstanding and status
derivation, transition guards, totals and overflow, PO number format, schema limits.

**Integration (`tests/integration/purchasing-*.test.ts`):**
- Suppliers: create, duplicate name ignoring case (409), archive blocks new POs, permission denied is audited.
- POs: create numbers PO-000001, PO-000002; edit replaces lines; edit after a receipt is 409; order, cancel and close
  transitions and their refusals; inactive and archived items refused; Manager cannot create (403, audited).
- Receiving: partial then full (status PARTIALLY_RECEIVED then RECEIVED); qty above outstanding is 409; zero lines is
  422; ledger rows `PURCHASE_RECEIPT` with `refType` GoodsReceipt; balances increase; `reconcile()` is clean; product
  and variant cost updated and audited; unchanged cost writes no audit row; an archived item is 422 and nothing is
  written; idempotent replay is 200 with no second stock row; the same key with another body is 409; **two parallel
  receipts for the last units: one wins, the other gets 409**; close short after a partial receipt.
- Isolation: another org's PO, supplier and items are 404; a Manager is 404 on a branch outside their scope.
- Receipts are append-only (an UPDATE is rejected by the trigger).
- Report: the purchases report matches seeded receipts per day and supplier in the Cairo timezone; 403 for Manager.
- Routes: 401/403/404/409/422/201/200 for each route, with the Idempotency-Key handling.

**E2E (`tests/e2e/purchasing.spec.ts`):** the admin creates a supplier and a PO with two lines and marks it ordered; a
manager receives part, then the rest; stock on `/inventory` shows the received quantities; the PO shows Received. Also:
a cashier gets no Purchasing link and is refused at `/purchasing`, and the Arabic list renders RTL.
