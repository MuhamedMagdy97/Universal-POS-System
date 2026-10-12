# Phase 10 / T5 — Purchasing Specification

Status: **approved by the owner 2026-10-12.** The owner answered roles (P1), cost on receipt (P2), receiving rules
(P3), PO edits (P4) and reports (P5), all as recommended, and asked that the remaining choices be taken as recommended.
Those are marked **(rec)** and can still be overridden. Data model and API:
[purchasing-data-model-and-api.md](purchasing-data-model-and-api.md). Screens and tests:
[purchasing-ux-and-tests.md](purchasing-ux-and-tests.md). Task plan: [purchasing-plan.md](purchasing-plan.md).

Source: `docs/planning/task-breakdown.md` (T5, deps T4), `docs/product/requirements.md` ("purchasing lite (supplier,
PO, receive)"), `docs/product/user-flows.md` ("Create PO → receive (full/partial) → on-hand + ledger updated"),
`docs/product/user-roles-permissions.md` (`purchases.*`), and the as-built inventory ledger and checkout.

## 1. Key facts

- `modules/purchasing` is an empty stub. The tables exist since the init migration: `Supplier`, `PurchaseOrder`
  (`DRAFT → ORDERED → PARTIALLY_RECEIVED → RECEIVED`, `CANCELLED`), `POItem`, `GoodsReceipt` (unique
  `idempotencyKey`) and `GoodsReceiptItem`.
- The inventory seam `recordMovements(tx, ctx, { reason: "PURCHASE_RECEIPT", refType: "GoodsReceipt" })` already
  exists, adds stock with positive quantities, and refuses archived items (`assertStockable`).
- Cost lives on `Product.costMinor` and, as an override, `ProductVariant.costMinor` (`null` = inherit). Cost is shown
  only to `products.update` holders (business rule 16).
- Only one purchasing permission exists, `purchases.receive` (Owner, Admin).
- The reports framework (T9) runs canned reports in the shop's timezone with CSV export; purchase reports were left
  for this phase.

## 2. Goal and success

An owner or admin keeps a supplier list, raises a purchase order for a branch, and marks it ordered. When the goods
arrive, a branch manager (or owner, admin) receives some or all of each line. Each receipt adds the stock to that
branch through the ledger in the same transaction, sets the item's cost to the invoice cost, and never double-counts on
a retry. The owner can read what was received, by day and supplier, in a report with CSV.

Out of scope: purchase returns, supplier payments, balances and invoices, input VAT, receiving without a PO, barcode
labels, emailing or printing a PO (print layout comes with T10), multi-currency.

## 3. Decisions

| # | Topic | Decision |
|---|---|---|
| P1 | Who does what | New `purchases.manage` (suppliers, create, edit, order, cancel, close short) for Owner and Admin. `purchases.receive` for Owner, Admin **and Manager**. Either permission lets a user view POs. Everything is branch-scoped: a user sees and acts on POs of branches in their membership scope. **Owner: as recommended.** |
| P2 | Cost on receipt | Each received line sets the item's cost to the received unit cost ("last cost"): the variant's `costMinor` for a variant line, the product's `costMinor` otherwise. Unchanged cost writes nothing. A change is audited as `catalog.cost.received` with old and new cost and the receipt. **Owner: as recommended.** |
| P3 | Receiving rules | Receive only from ORDERED or PARTIALLY_RECEIVED. Per line, `0 ≤ qty ≤ outstanding`; at least one line > 0. The unit cost may be corrected at receipt (defaults to the PO line cost). No over-receipt: edit the PO first (only before the first receipt) or raise a new PO. A partially received PO can be **closed short** (reason required): it becomes RECEIVED and the outstanding quantity is dropped. **Owner: as recommended.** |
| P4 | Editing | Lines, quantities, costs, note and supplier are editable while DRAFT, or ORDERED with nothing received. After the first receipt the PO is frozen except receive and close short. Cancel is allowed from DRAFT or ORDERED with nothing received. **Owner: as recommended.** |
| P5 | Reports | One new report, **Purchases received**: per local day and supplier, the number of receipts, units and value (Σ qty × unit cost). It needs `reports.view` and `purchases.manage`, because it shows cost. The PO list on the purchasing screen covers "what is still open". **Owner: as recommended.** |
| P6 | Cost on purchasing screens | Purchasing documents show their own unit costs to anyone who may view them. Managers therefore see and enter cost on POs and receipts of their branches. The catalog's cost field stays hidden from them (rule 16 unchanged). **(rec)** |
| P7 | PO number | A per-org counter (`Organization.lastPoNo`, like `lastSaleNo`) bumped in the create transaction, formatted `PO-000001`. Gap-free, since a rollback gives the number back. **(rec)** |
| P8 | Lines | 1 to 200 lines. One line per item (the same product and variant twice is merged). `qtyOrdered` 1 to 1 000 000 (whole units, like the ledger). Unit cost 0 to 2 147 483 647 minor units. The line value must fit 2^53. The item must be stockable (active, variant rule) when it is added or changed and when it is received. **(rec)** |
| P9 | Receiving an item archived after ordering | Refused with 422 `ITEM_NOT_SELLABLE` (the ledger never adds stock to an archived item). The user receives the other lines and closes the PO short, or restores the item. **(rec)** |
| P10 | Idempotency | `POST …/receipts` requires an `Idempotency-Key`. The same key and body replay the first receipt (200). The same key with a different body answers 409 `IDEMPOTENCY_CONFLICT`. Stored as `GoodsReceipt.requestHash`, like sales and refunds. **(rec)** |
| P11 | Concurrency | Every PO write locks the PO row (`SELECT … FOR UPDATE`) and re-reads status and received quantities after the lock. Two receipts racing for the last units cannot both pass. Lock order: PO, then the products and balances (inventory), so it cannot deadlock with sales. **(rec)** |
| P12 | Suppliers | Name required (1 to 120 characters) and unique per org, ignoring case. Phone, email and tax number are optional. Suppliers are archived, never deleted. An archived supplier cannot get a new PO or be put on one; existing POs with it carry on. **(rec)** |
| P13 | Money | Costs are the amounts on the supplier invoice, before VAT; no input VAT is tracked. Totals are computed from lines (never stored) in integer minor units, in the org currency. **(rec)** |
| P14 | Receipts are history | `GoodsReceipt` and `GoodsReceiptItem` become append-only (DB trigger), like the ledger. A mistaken receipt is corrected with a stock adjustment, not by editing the receipt. **(rec)** |
| P15 | Audit | `purchasing.supplier.created/updated/archived/restored`, `purchasing.po.created/updated/ordered/cancelled/closed`, `purchasing.receipt.created`, `catalog.cost.received`, and `purchasing.permission.denied` for refused attempts. **(rec)** |

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A retry or double click receives twice and doubles stock. | P10 idempotency key on the receipt; the screen keeps one key per form. Integration test replays. |
| R2 | Two people receive the same PO at once and exceed the ordered quantity. | P11 PO row lock and re-check; a concurrency test runs two receipts in parallel. |
| R3 | Stock, receipt and PO disagree after a failure. | One transaction for receipt rows, PO quantities, ledger rows, cost and audit; `reconcile()` stays clean in tests. |
| R4 | Cost leaks to a cashier. | Cashiers have neither purchasing permission. Catalog cost stays hidden from managers. Route tests check 403s. |
| R5 | A Manager acts on another branch's PO. | Every service resolves the PO by org and checks the PO's branch against the caller's scope (404 outside). Isolation tests. |
| R6 | Last-cost overwrites a cost the owner set by hand. | Accepted (P2). Every change is audited with the old value, and the receipt keeps its own cost. |
| R7 | A deadlock between receiving and selling the same items. | Both take product locks then balance locks in id order through the same inventory path; the PO lock is taken first and only by purchasing. |

## 5. Interfaces

- Suppliers: `GET/POST /api/purchasing/suppliers`, `PATCH /api/purchasing/suppliers/{id}`, `POST …/{id}/archive`,
  `POST …/{id}/restore`.
- Purchase orders: `GET/POST /api/purchasing/pos`, `GET/PATCH /api/purchasing/pos/{id}`, `POST …/{id}/order`,
  `POST …/{id}/cancel`, `POST …/{id}/close`.
- Receipts: `POST /api/purchasing/pos/{id}/receipts` (Idempotency-Key).
- Report: `GET /api/reports/purchases` through the existing reports route.
- Screens: `/purchasing` (list), `/purchasing/new`, `/purchasing/{id}` (detail and editor),
  `/purchasing/{id}/receive`, `/purchasing/suppliers`.

## 6. Next steps

1. Data model and API, screens and tests: written alongside this spec.
2. Build per [purchasing-plan.md](purchasing-plan.md) with the usual gates: lint, typecheck, unit, integration and route
   tests, E2E, `next build`.
