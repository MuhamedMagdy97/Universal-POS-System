# Restaurant and Café (UI Refresh D): As Built

Built 2026-10-25 against [restaurant-cafe-spec.md](restaurant-cafe-spec.md) and
[restaurant-cafe-plan.md](restaurant-cafe-plan.md), in three stacked PRs: options and notes, tables and tickets, and
the service charge.

## What exists

- **Options** (migration `restaurant_options`): Catalog → Options manages option groups (minimum and maximum picks,
  choices with an extra price, EN/AR; a removed choice is deactivated). An item's page has an Option groups card.
  Weighed items, items with variants and linked shops cannot have options. Sellable items, search, tiles and the
  offline snapshot carry their active groups.
- **Sale lines** carry the chosen options (`SaleItem.options` snapshot; `unitPriceMinor` is base + options) and a
  note of up to 140 characters. One item with other options or another note is its own line; stock moves once per
  item for sales, refunds and voids (`stockLinesOf`). A linked shop still sends one line per item, notes joined.
- **Till**: the options picker (the first choice of a "pick one" group is preset; Add shows the price), a Note button
  per line, options and notes on the screen receipt, the printed receipt, the refund screen and offline receipts.
- **Tables and tickets** (migration `restaurant_tickets`): Settings → Tables per branch (café shops; Owner and
  Admin, audited; a table with an open ticket cannot be removed). `modules/sales/tickets.ts` opens, saves, sends,
  moves and cancels tickets with a `version` (409 `TICKET_CHANGED` on a stale save); one open ticket per table
  (partial unique index). Lines are stored per kitchen send; taking back what was sent needs `sales.void` and prints
  a cancelled slip.
- **Café till**: the Tables view is the start screen (tiles by area with total and minutes open, held takeaway and
  delivery orders below). The ticket bar picks the order type, takes a delivery address, and has Hold, Send to
  kitchen (an 80 mm kitchen slip of only what is new), Move and Cancel. Paying saves the ticket and sells exactly its
  lines in one transaction that closes it; the sale and receipt show the order type and table. The shift close says
  how many tickets stay open.
- **Service charge** (migration `restaurant_service_charge`): an Owner setting on Settings → Shop (café shops,
  0–25 %, audited). Dine-in orders get it on the amount after discounts, priced with VAT at the shop's rate, as a
  row the cashier can remove for one order (audited on the sale). Refunds give back a proportional share,
  cumulatively, the last full refund taking the exact remainder; the Returns screen shows the same amount. The sales
  summary has a Service charge column and the Z-report a service charge line; product and profit reports leave it
  out.

## After the final review

- A ticket payment or a sale with a service charge is never queued offline when the network drops mid-charge (it
  could never replay); the till asks to try again with the same key.
- A linked shop can pay a ticket with one item under two notes.
- An offline sale whose option was archived before it reached the server is kept as sold and flagged
  `OPTIONS_CHANGED` for the review list.
- A table with an open ticket cannot be removed; picking a busy table adds what was rung up to its ticket instead of
  replacing it; line discounts survive Hold and Send; a sent line's note cannot be edited.
- Refunds and voids of a sale with two option lines of one item move stock once (fixed in PR 1).

Known and left for later: a scan typed while the previous lookup is still running can be cleared (a till behaviour
that predates D); moving a ticket onto a table another till takes at the same moment answers 500 rather than 409
(the unique index still holds); floor tiles show totals without the service charge; floor errors are generic; a
ticket payment retried after a lost response shows "already paid" rather than its receipt; `Sale.ticketId` has no
foreign key; sale lines come back in random order (pre-existing).

## Deviations from the plan

| Plan | As built | Why |
| ---- | -------- | --- |
| `modules/tickets` | `modules/sales/tickets.ts` | Paying a ticket runs inside the sale transaction and shares sales' guards |
| Shift-close count from `registers/shifts.ts` | From the till page | It is only a note on the close screen |
| Review fixes per PR | On the top branch (PR 3), except the stock fix in PR 1 | The PRs merge back to back |

## Tests

Unit: `sales-options.test.ts`, `sales-totals.test.ts` (service charge), `pos-till-helpers.test.ts` (cart keys,
notes), `pos-tickets.test.ts`, `returns-helpers.test.ts` (refund share). Integration: `catalog-options.test.ts`,
`sale-options.test.ts` (lines, refund, void, offline, archived option), `dining-tables.test.ts`, `tickets.test.ts`,
`ticket-payment.test.ts`, `service-charge.test.ts`, the linked-shop ticket case in `inventory-sale-posting.test.ts`.
E2E: `cafe-options.spec.ts` and `cafe-tickets.spec.ts` (table 4 from order to payment with a 12 % service charge, a
second till, a held takeaway, Arabic); `ui-quality.spec.ts` checks a retail till has none of it.
