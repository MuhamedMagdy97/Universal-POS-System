# Restaurant and Café (UI Refresh D): Specification

Status: **Draft for the owner's review (2026-10-25).** Every choice below is the recommended one.

Source: [overview](README.md), [business profiles as built](business-profiles-as-built.md),
[weighed selling as built](weighed-selling-as-built.md). Today a sale is created whole and paid at once
(`createSale`); there are no open orders, no tables, no options on a line, and the till prints only the customer
receipt. Café shops already get tap tiles (`tillLayout: "tiles"`) and say "Menu items".

## 1. Goal

A restaurant or café runs its floor on the till: dine-in, takeaway and delivery orders; tables with open tickets that
are added to over time and paid later; options on a dish ("large", "extra shot", "no onions"); a kitchen slip for what
was just ordered; and an optional service charge. Totals, VAT, stock, refunds and reports stay right.

## 2. Decisions

| #   | Question | Decision (recommended) |
| --- | -------- | ---------------------- |
| R1  | Who gets it | Any shop can use the data, but the screens show for the `RESTAURANT_CAFE` profile only (a profile flag `tickets: true`), as with tiles. Another business type does not see tables, tickets or service charge. |
| R2  | Order type | Every café sale has an order type: **Dine-in**, **Takeaway** or **Delivery** (`OrderType` enum on the ticket and the sale; `NULL` for other shops and old sales). Dine-in needs a table; delivery needs a customer and takes a delivery address and note as free text on the order (customers have no address today). A delivery fee is a menu item the shop creates. |
| R3  | Tables | A branch has tables (`DiningTable`: name, optional area such as "Terrace", sort order, active). Owner and Admin manage them in Settings → Tables (`settings.manage`, audited). The till's **Tables** view shows each active table as a tile: free, or its open ticket's total and minutes open. |
| R4  | Open tickets | An open ticket (`Ticket`) is an order not yet paid: branch, order type, table (dine-in), optional customer, delivery address and note, lines, a `version` for edits from two tills, opened by and when. It is stored on the server, so any till in the branch sees it; it belongs to no shift and survives a shift close (the close shows how many are open). Opening a dine-in ticket on a table that already has one opens that ticket instead. A ticket can move to another free table. Takeaway and delivery tickets without a table can be held too and are listed by number. |
| R5  | Paying a ticket | **Pay** on a ticket opens the normal payment panel with its lines; charging calls the existing sale create with the ticket's lines plus `ticketId`, in one transaction that closes the ticket. Stock, VAT, discounts, customers, idempotency and linked shops work as today because it is an ordinary sale. A ticket that changed since the till loaded it is refused (409, reload). Splitting a bill is out of scope. |
| R6  | Cancelling a ticket | A ticket with nothing sent to the kitchen can be cancelled by its till user. One with sent lines needs `sales.void` (Manager and up), with a reason, audited. No stock moves either way (stock moves only when paid). |
| R7  | Options (modifiers) | Option groups in the catalog: a group has a name (EN/AR), a minimum and maximum number of choices (for example "Size", exactly one; "Extras", up to three) and options with a name (EN/AR) and a price change (0 or more, in minor units). A product has any number of groups, in order. Adding such a product at the till opens an options picker; required groups must be filled. The line's unit price is the base price plus its options; the sale line keeps a snapshot of the chosen options (names and prices) so receipts and reports never change later. Products with variants or sold by weight cannot have option groups. |
| R8  | Line notes | Any line can carry a short note (up to 140 characters, "no onions"), printed on the kitchen slip and the receipt. A note does not change the price. |
| R9  | Same item, different options | Two lines of the same product with different options or notes stay separate lines on the ticket, the sale and the receipt. Stock is moved once per product (the quantities of its lines added together), so the stock ledger is unchanged. Scanning or tapping an item without options still adds to its line. |
| R10 | Kitchen slip | **Send to kitchen** prints the lines not yet sent (quantity, name, options, note, table or order type and number, time, waiter) on an 80 mm slip with the browser's print, and marks them sent. Sent lines show a "sent" mark; reducing or removing one needs `sales.void` and prints a "cancelled" slip. No kitchen screen and no printer routing by station. |
| R11 | Service charge | A shop setting (Owner, off by default): a percent (0–25 %) applied to dine-in orders only, shown as its own row before VAT. It is charged on the order's amount after discounts and carries VAT at the shop's rate (as Egyptian and Saudi restaurants charge it). The cashier can remove it from one order (audited on the sale). It is stored on the sale (`serviceChargeMinor`, its VAT inside `vatMinor`); a refund gives back the service charge in proportion to the amount refunded; reports show it in the sales summary and the Z-report as its own line, not as item revenue or profit. |
| R12 | Offline | Tickets and tables need the server. Offline, the café till sells at the counter as today (order type takeaway, no tickets, options and notes from the snapshot, no service charge); the snapshot carries option groups. |
| R13 | Receipts | The receipt shows order type, table, options under each line, notes, and the service charge row. |
| R14 | Migrations | Three, one per PR: (1) option groups, options, product–group links and the sale-line option snapshot and note; (2) tables, tickets and ticket lines, and the sale's order type, ticket link and delivery fields; (3) the shop's service-charge setting and the sale's service charge. No backfill. |

## 3. Out of scope

Split bills and paying part of a ticket; merging tickets; tips; a kitchen display screen and printing by station;
courses and fire times; a floor plan you draw; reservations; delivery zones, drivers and third-party delivery apps;
recipes and ingredient stock; options on weighed items or products with variants; happy-hour pricing.

## 4. Tests

- Unit: option rules (required, min and max, price), line keys for options and notes, service charge and its VAT
  (prices with and without VAT), service-charge share on a partial refund, kitchen-slip lines (only unsent).
- Integration: options on a sale (price, snapshot, stock moved once per product for two option lines); a ticket
  opened, added to from two tills (version conflict), sent, paid into one sale that closes it; cancel with and without
  sent lines (permission, audit); one ticket per table; move table; service charge on dine-in and not on takeaway,
  removed for one order, refunded in part; Z-report and sales summary rows; `expectReconciled` after each.
- E2E: a café opens table 4, orders two cappuccinos (one large with an extra shot) and a croissant with a note, sends
  them to the kitchen, adds a water later, pays with service charge; a takeaway with options paid at once; the till in
  Arabic RTL; a retail shop sees none of it.

## 5. Delivery

Three PRs, merged in order:

1. Option groups and line notes: catalog screens and API, the till picker, separate lines with one stock move per
   product, receipts, offline snapshot (migration 1).
2. Tables, open tickets, order types and the kitchen slip: Settings → Tables, the till's Tables view and ticket bar,
   pay and cancel, shift-close count (migration 2).
3. Service charge: the setting, totals, receipts, refunds, sales summary and Z-report (migration 3); docs and as-built
   note.
