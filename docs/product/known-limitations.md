# Known limitations

Everything below is **not built** in the current release. Collected on 2026-10-19 from the "Not built", "Deferred",
"Out of scope" and "Not done" notes in [`docs/planning/`](../planning/) and [`mvp-scope.md`](mvp-scope.md); items that
those notes deferred and a later task then built (voids and refunds, receipts and Z-report printing, PO printing, the
shift list, purchasing, the pay-in/pay-out/drop screen, split tenders on the till, profit and margin) are left out.
Updated 2026-10-19 after the Phase 14 checks. Source in brackets.

## Product-wide

- Offline selling is **sales only** and opt-in (shop setting plus one enrolled browser per till); no refunds, voids,
  cash movements, shift open/close or customers offline, and not for shops linked to the inventory system. Unsynced sales
  on a lost or wiped device are lost. Limits: 12 h offline, 300 queued sales, session expiry. See
  [offline strategy](../architecture/offline-strategy.md). Manual payments only (cash, card, wallet recorded by hand); no payment-provider
  integration. No native mobile or desktop app, no e-commerce, no full accounting. [mvp-scope]
- Saudi receipts carry the ZATCA Phase 1 QR (simplified tax invoice); ZATCA Phase 2 (Fatoora clearance, CSID, UBL XML)
  is not built. Egypt ETA e-receipts are designed in [eta-e-receipt-spec](../planning/eta-e-receipt/eta-e-receipt-spec.md)
  and need the owner's ETA registration and credentials before they can be built. [zatca/zatca-phase1-spec]
- No industry modules beyond the retail preset (roadmap phase 12). Customer records have no loyalty, credit accounts or marketing; a sale names at most one customer.
  [roadmap, mvp-scope]

## Accounts, shops and staff

- No email: no email verification, password reset by email or invite links (no mail provider). [onboarding-spec §2]
- No forced password change at first sign-in. One user belongs to one shop. Country and currency cannot change
  after setup. No billing, no shop deletion. [onboarding-spec §2, §6]
- Staff, branch and till screens have no API routes (Server Actions only). [onboarding-spec §6]

## Catalog

- Units are `EACH` (whole pieces) and `KG` (grams, priced per kg). No other units, no weighed variants, no
  price per 100 g, and the shop cannot print scale labels. A shop linked to the inventory system cannot sell `KG`
  items. [ui-refresh/weighed-selling-spec]
- No Size × Colour option matrix for variants; variants inherit unit, VAT and category. [phase-6/catalog-data-model]
- One price per product (optional variant override); no price lists. [phase-6/catalog-data-model]

## Inventory

- No freezing sales during a stock count; a transit transfer is received once (no several partial receipts), no low-stock notifications (the list and
  dashboard tile are on screen only), no cost valuation or COGS. Stock CSV import is one branch per file, with no template download and no "set to counted" mode. [phase-7/inventory-spec §5]
- The opening-stock grid saves at most 100 items at a time. The transfer form has no scan shortcut beyond Enter in
  the search box. [phase-7/inventory-as-built, deferred minors]

## Checkout (POS till)

- No discount codes, promotions or price rules: discounts are typed at the till (line or sale, amount or percent). [discounts/discounts-spec]
- A cashier can reprint only the last sale on their screen; older receipts are reprinted by a Manager or Owner from
  Returns. [phase-11/hardening-spec, user guide review]

## Restaurants and cafés

- No split bills, merged tickets, tips, kitchen screen, printing by station, courses, floor plan, reservations,
  delivery zones or drivers, recipes or ingredient stock, or happy-hour prices. [ui-refresh/restaurant-cafe-spec §3]
- Options are not available on weighed items or items with variants, nor in a shop linked to the inventory system.
- Tables and open tickets need the server; offline, the till sells at the counter only.

## Salons

- No online booking, reminders (SMS or WhatsApp), deposits, working hours or rotas, chairs or rooms, packages,
  tips, commission per service, payroll, recurring appointments or a waitlist. [ui-refresh/salon-spec §3]
- The booking form takes a typed name and phone; picking an existing customer is API-only for now. Moving an
  appointment is API-only too: on screen, cancel and book again.
- Service items are not available in a shop linked to the inventory system.

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

- Purchase returns need a received PO or a direct receipt (none without one); supplier statements show direct
  receipt and return numbers as text, not links. No barcode labels,
  emailing a PO, or multi-currency. [phase-10/purchasing-spec §2, phase-status]

## Printing and hardening

- Browser printing only: no ESC/POS or printer drivers, no email or SMS receipts. [phase-11/hardening-as-built §4]
- Styles keep `'unsafe-inline'` in the Content Security Policy (scripts use a per-request nonce); every page
  renders per request, with no static shell. [phase-11/hardening-as-built §5]

## Operations

- No scheduled backups or point-in-time recovery set up in the repo; no deploy scripts or production environment.
  Migrations are forward-only. [operations/backup-restore, operations/deploy-and-rollback]

## Inventory system link (Phase 13)

- Categories deeper than three levels fold into their third-level ancestor. The scheduled catalog sync and posting retries need the host to call
  `/api/internal/inventory/run` every minute with `CRON_SECRET`; there is no built-in scheduler or webhook.
- The connection check cannot confirm the API key may reserve stock (the inventory system has no "who am I" route);
  a key without that permission is reported at the first sale.
- A sale is refused while the inventory system is unreachable (no offline queue). [inventory-integration/integration-spec]
