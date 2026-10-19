# Known limitations

Everything below is **not built** in the current release. Collected on 2026-10-19 from the "Not built", "Deferred",
"Out of scope" and "Not done" notes in [`docs/planning/`](../planning/) and [`mvp-scope.md`](mvp-scope.md); items that
those notes deferred and a later task then built (voids and refunds, receipts and Z-report printing, PO printing, the
shift list, purchasing, the pay-in/pay-out/drop screen, split tenders on the till, profit and margin) are left out.
Updated 2026-10-19 after the Phase 14 checks. Source in brackets.

## Product-wide

- Online only: no offline checkout. Manual payments only (cash, card, wallet recorded by hand); no payment-provider
  integration. No native mobile or desktop app, no e-commerce, no full accounting. [mvp-scope]
- No tax e-invoicing: no ZATCA (Saudi) e-invoices or Egypt e-receipt certification, no tax QR codes. A receipt is a
  customer slip. [phase-11/hardening-spec §1–2]
- No industry modules beyond the retail preset (roadmap phase 12). Walk-in customers only: no customer records.
  [roadmap, mvp-scope]

## Accounts, shops and staff

- No email: no email verification, password reset by email or invite links (no mail provider). [onboarding-spec §2]
- No forced password change at first sign-in. One user belongs to one shop. Country and currency cannot change
  after setup. No billing, no shop deletion. [onboarding-spec §2, §6]
- Staff, branch and till screens have no API routes (Server Actions only). [onboarding-spec §6]

## Catalog

- Only `EACH` units: `KG` / weighted selling is refused with `UNIT_NOT_SUPPORTED`; quantities are whole numbers.
  [phase-6/catalog-api-and-rules §7, phase-7/inventory-spec]
- No Size × Colour option matrix for variants; variants inherit unit, VAT and category. [phase-6/catalog-data-model]
- One price per product (optional variant override); no price lists. [phase-6/catalog-data-model]

## Inventory

- No stock counts or count sessions, no two-step (in-transit) transfers, no low-stock notifications (the list and
  dashboard tile are on screen only), no cost valuation or COGS, no CSV import, no settings screen for `blockNegativeStock`. [phase-7/inventory-spec §5]
- The opening-stock grid saves at most 100 items at a time. The transfer form has no scan shortcut beyond Enter in
  the search box. [phase-7/inventory-as-built, deferred minors]

## Checkout (POS till)

- No discounts (`discountMinor` is always 0). [phase-8/checkout-spec Q3]
- A cashier can reprint only the last sale on their screen; older receipts are reprinted by a Manager or Owner from
  Returns. [phase-11/hardening-spec, user guide review]

## Shifts and cash

- No manager approval or threshold for a cash difference at close (recorded and shown only). A closed shift cannot
  be reopened; corrections are new entries. [phase-8/shift-close-spec S6, §2]

## Returns

- No exchanges, refunds without an original sale, store credit, discounts on refunds, or manager approval
  thresholds. Voids are refused once a sale has a refund. [phase-8/returns-void-spec §2, phase-status]

## Reports

- No split of 0% VAT into zero-rated and exempt. No charts beyond totals, scheduled or emailed reports, or custom
  reports. [phase-9/reports-audit-spec, phase-status]

## Purchasing

- No purchase returns, supplier payments, balances or invoices, input VAT, receiving without a PO, barcode labels,
  emailing a PO, or multi-currency. [phase-10/purchasing-spec §2, phase-status]

## Printing and hardening

- Browser printing only: no ESC/POS or printer drivers, no email or SMS receipts. [phase-11/hardening-as-built §4]
- Styles keep `'unsafe-inline'` in the Content Security Policy (scripts use a per-request nonce); every page
  renders per request, with no static shell. [phase-11/hardening-as-built §5]

## Operations

- No scheduled backups or point-in-time recovery set up in the repo; no deploy scripts or production environment.
  Migrations are forward-only. [operations/backup-restore, operations/deploy-and-rollback]

## Inventory system link (Phase 13)

- Categories are not synced. The scheduled catalog sync and posting retries need the host to call
  `/api/internal/inventory/run` every minute with `CRON_SECRET`; there is no built-in scheduler or webhook.
- The connection check cannot confirm the API key may reserve stock (the inventory system has no "who am I" route);
  a key without that permission is reported at the first sale.
- A sale is refused while the inventory system is unreachable (no offline queue). [inventory-integration/integration-spec]
