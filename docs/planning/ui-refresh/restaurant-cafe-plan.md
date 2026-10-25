# Restaurant and Café (UI Refresh D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (owner chose inline execution, PRs
> merged in order). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A café runs dine-in, takeaway and delivery orders on the till: options and notes on lines, tables with open
tickets paid later, a kitchen slip, and an optional dine-in service charge.

**Architecture:** Options are catalog data resolved into the sale line's unit price, with a snapshot on `SaleItem`.
Tickets are a new `modules/tickets` module that stores unpaid orders. Paying one goes through the existing
`createSale` with a `ticketId`, so stock, VAT, discounts, idempotency and linked shops are unchanged. The service
charge is one more priced amount in `priceSale`.

**Tech Stack:** Next.js 16 App Router (Server Actions, Cache Components), Prisma 7 on PostgreSQL 16, zod 4, Vitest,
Playwright, EN/AR RTL.

**Spec:** [restaurant-cafe-spec.md](restaurant-cafe-spec.md) (R1–R14).

## Global Constraints

- Screens for tickets, tables and service charge show only for the `RESTAURANT_CAFE` profile (R1). The preset gains
  `tickets: true`; every other preset gets `false`.
- Three migrations, one per PR, created with `npx prisma migrate dev --create-only` and trimmed. Plain `migrate dev`
  drops `POItem_one_line_per_item` (memory). No backfill.
- Money stays integer minor units through `lib/money` and `lineMinor`; no floats.
- A sale line's `unitPriceMinor` is base + options (R7), so refunds, reports and profit read it unchanged.
- Stock moves once per product per sale: the quantities of lines with the same `ref` are added up before
  `recordMovements` (R9). The ledger's no-duplicate-refs rule stays.
- Shops linked to the inventory system: option groups cannot be set (catalog managed there). Lines with the same
  `ref` are still merged into one, with their notes joined by "; ". No tickets change for them (R5 pays an ordinary
  sale).
- Every existing test stays green; non-café shops' numbers and screens do not move.
- Notes are at most 140 characters (R8); service charge is 0–2,500 bp, where 0 means off (R11).

## Review Focus

- Two cappuccinos, one plain and one large with an extra shot: two sale lines, one stock movement of 2, and the
  receipt shows both. Test: Task 2 integration.
- Two tills edit the same ticket: the second save gets 409 `TICKET_CHANGED` and nothing is lost. Test: Task 5
  integration.
- A ticket is paid while another till adds a line to it: the sale matches exactly what was on the ticket when it was
  paid, or the payment is refused. Test: Task 6 integration.
- Service charge on a sale with a sale discount, prices including VAT, then a partial refund: totals and VAT
  reconcile, and repeated partial refunds never give back more service charge than was charged. Test: Task 9
  integration.
- A retail shop: no Tables, no order type, no service charge, and receipts are unchanged. Test: Task 7 E2E.

---

## PR 1: options and notes (branch `ui-refresh/restaurant-options`)

### Task 1: option groups in the catalog (migration 1)

**Files:**
- `prisma/schema.prisma`:
  - `OptionGroup` (orgId, name, nameAr?, minSelect Int, maxSelect Int, sortOrder, isActive);
  - `OptionChoice` (groupId, name, nameAr?, priceDeltaMinor Int ≥ 0, sortOrder, isActive);
  - `ProductOptionGroup` (productId, groupId, sortOrder; unique pair);
  - `SaleItem.options Json?` (the snapshot);
  - `SaleItem.note String?`.
- Migration `restaurant_options`, with CHECKs `minSelect >= 0`, `maxSelect >= GREATEST(minSelect, 1)` and
  `priceDeltaMinor >= 0`.
- `modules/catalog/options.ts`:
  - `listOptionGroups`, `createOptionGroup`, `updateOptionGroup` (choices replaced as a list; a removed choice is
    deactivated, not deleted) and `setProductOptionGroups(ctx, productId, groupIds)`;
  - permission `products.update`, audited `catalog.option_group.created|updated` and
    `catalog.product.option_groups.set`;
  - refused for a KG product, a product with variants, or a linked shop (`UNIT_NOT_SUPPORTED`,
    `VARIANTS_NOT_SUPPORTED`, `MANAGED_BY_INVENTORY`).
- `modules/catalog/schemas.ts`:
  - `OptionGroupInput`;
  - `SellableItem.optionGroups?: OptionGroupView[]`, where
    `OptionGroupView = { id; name; nameAr; minSelect; maxSelect; choices: { id; name; nameAr; priceDeltaMinor }[] }`.
    Only active groups and choices are included, loaded by `resolveRefs`, search and browse.
- Catalog → Options page (`app/(app)/catalog/options`), copying the categories manager.
- The product form gets an "Option groups" checklist, hidden for KG items and items with variants.
- i18n `catalog.options.*`.

Tests:
- integration `catalog-options.test.ts`: create, update, link, refusals, audit, cashier denied;
- unit `catalog-validation.test.ts`: min/max rules.

### Task 2: sale lines with options and notes

**Files:**
- `modules/sales/schemas.ts`: `SaleLineInput` gains `options?: Uuid[]` (max 20) and `note?: string` (trimmed, 1–140,
  empty means absent).
- `modules/sales/options.ts` (new, pure):
  - `resolveOptions(item: SellableItem, optionIds: string[]): { unitPriceMinor; snapshot: OptionSnapshot[] }`.
    It throws 422 `OPTIONS_INVALID` when a choice is unknown or inactive, a group is below its min or above its max,
    or a choice repeats.
  - `OptionSnapshot = { group; groupAr; name; nameAr; priceDeltaMinor }`.
  - `lineKeyOf(ref, optionIds, note)`: options sorted by id.
- `modules/sales/create.ts`:
  - `mergeLines` keys by `lineKeyOf`; a linked shop keys by ref and joins notes.
  - Price each line with `resolveOptions`.
  - Store `options` and `note` on `SaleItem`.
  - `recordMovements` and `reserveSale` get lines aggregated by ref. The negative-stock flag maps back by ref.
  - `loadSale` lines gain `options: OptionSnapshot[]` and `note: string | null`.
- `modules/sales/offline.ts`: compare the device price against base + options.
- `modules/sales/receipt.ts` and `receipt-print.tsx`: options under the line ("+ Large 5.00"), then the note.
- `returns-view.ts` lines carry options and note for the refund screen.

Tests:
- unit `sales-options.test.ts`: resolveOptions min/max/unknown/price, lineKeyOf;
- integration `sale-options.test.ts`:
  - two option lines of one product: two lines, one movement, receipt;
  - refund one of them;
  - invalid options refused (422);
  - a note-only line separate from a plain one;
  - an offline replay with options;
  - `expectReconciled`.

### Task 3: the till picker and notes

**Files:**
- `app/(app)/pos/_lib/till.ts`:
  - `TillItem.optionGroups?`;
  - `CartLine.options?: string[]`, `CartLine.optionLabels?: OptionSnapshot[]`, `CartLine.note?: string`;
  - cart keys become `cartKey(line)` (ref + options + note), used everywhere `lineKey` keys a cart line;
  - `addToCart(cart, item, qty, label?, picked?: { options; labels; unitPriceMinor })`;
  - `setLineNote(cart, key, note)`.
- `app/(app)/pos/_components/options-picker.tsx` (new): a dialog with one fieldset per group (radio when max is 1,
  checkboxes otherwise), the running price, and Add disabled until the minimums are met. Esc closes it.
- `till.tsx`: adding an item with groups opens the picker; a "Note" button on the selected line; the charge body sends
  `options` and `note`.
- `_lib/offline.ts` / `offline-snapshot.ts`: snapshot items carry `optionGroups`; `buildOfflineSale` prices options.
- i18n `pos.options.*` and `pos.note.*`.

Tests:
- unit `pos-till-helpers.test.ts`: cart keys, a picked price, a note splits a line;
- E2E `cafe-options.spec.ts`: a café sells a large cappuccino with an extra shot and a croissant with a note; the
  receipt shows both; works in Arabic.

Then the full gate. PR 1.

---

## PR 2: tables, tickets, kitchen slip (branch `ui-refresh/restaurant-tickets`)

### Task 4: tables (migration 2)

**Files:**
- `prisma/schema.prisma`:
  - `DiningTable` (orgId, branchId, name, area?, sortOrder, isActive; unique branch + name);
  - `Ticket` (orgId, branchId, number Int, orderType `OrderType`, tableId?, customerId?, deliveryAddress?,
    deliveryNote?, status `TicketStatus` OPEN/PAID/CANCELLED, version Int, openedById, openedAt, closedAt?, saleId?,
    cancelReason?);
  - `TicketLine` (ticketId, productId, variantId?, qty, options String[], note?, sentAt?, sortOrder);
  - `Sale` gains `orderType OrderType?`, `ticketId?`, `tableName?`, `deliveryAddress?` and `deliveryNote?`;
  - `Organization.lastTicketNo Int @default(0)`.
- Migration `restaurant_tickets`, with the partial unique index `Ticket_one_open_per_table` on `(tableId)` where
  `status = 'OPEN' AND tableId IS NOT NULL`.
- `modules/org/tables.ts`: `listTables(ctx, branchId)`, `saveTables(ctx, branchId, rows)` (add, rename, reorder,
  deactivate), `settings.manage`, audited `settings.tables.updated`.
- Settings → Tables page, with branch tabs as on Settings → Branches; shown only for café shops.
- Preset flag `tickets`.

Tests: integration `dining-tables.test.ts` covering save, rename, deactivate, a duplicate name refused, a cashier
denied, and branch scope.

### Task 5: tickets

**Files:**
- `modules/tickets/` (new: `index.ts`, `schemas.ts`, `tickets.ts`, `errors.ts`). Every function checks
  `sales.create` and the branch:
  - `openTicket(ctx, { branchId, orderType, tableId?, customerId?, deliveryAddress?, deliveryNote? })`. It returns the
    table's open ticket if one exists, and refuses dine-in without a table and delivery without a customer.
  - `saveTicketLines(ctx, id, { version, lines })`. It replaces unsent lines. A sent line's qty may only go down, or
    the line be removed, with `sales.void`. Each such change is audited as `ticket.line.cancelled` and returned in
    `cancelled[]` for the slip.
  - `sendToKitchen(ctx, id, version)` stamps `sentAt` on unsent lines and returns `KitchenSlip { ticketNumber;
    orderType; tableName; waiter; at; lines: { qty; name; nameAr; options; note }[] }`.
  - `moveTicket(ctx, id, version, tableId)`: the target must be free.
  - `cancelTicket(ctx, id, version, reason?)`: a reason and `sales.void` are needed if any line was sent; audited.
  - `listOpenTickets(ctx, branchId)` returns `{ id; number; orderType; tableId; tableName; totalMinor; openedAt;
    lineCount }`, with the total priced via `priceSale` and options.
  - `getTicket(ctx, id)`.
  - A stale `version` gives 409 `TICKET_CHANGED`; a closed ticket gives 409 `TICKET_CLOSED`.
- Ticket numbers come from `Organization.lastTicketNo` (`UPDATE … RETURNING`).
- `app/(app)/pos/ticket-actions.ts`: Server Actions wrapping each function.

Tests: integration `tickets.test.ts`:
- open (and the second open on a table returns the same ticket);
- two tills and a version conflict;
- send, then lower a sent line with and without `sales.void`;
- move to a busy table refused;
- cancel with and without sent lines;
- cross-branch refused.

### Task 6: paying a ticket

**Files:**
- `modules/sales/schemas.ts`: `SaleInput` gains `ticket?: { id; version }`, `orderType?`, `deliveryAddress?` and
  `deliveryNote?`.
- `create.ts`:
  - with `ticket`: lock the ticket `FOR UPDATE`; it must be OPEN at that version, and the merged sale lines must equal
    its lines (ref, qty, options, note), else 409 `TICKET_CHANGED`;
  - the sale takes the ticket's order type, table name, customer and delivery fields;
  - the ticket becomes PAID with `saleId` and `closedAt`, in the same transaction;
  - idempotent replay returns the same sale.
- `loadSale` and the receipt add `orderType`, `tableName` and `delivery`.
- `modules/registers/shifts.ts`: the close preview carries `openTickets` (count per branch).

Tests: integration `ticket-payment.test.ts`:
- pay into one sale and close the ticket;
- a stale version refused;
- lines that differ refused;
- double pay with one key replays, a second key is refused as closed;
- the sale's order type and table;
- `expectReconciled`.

### Task 7: the till floor

**Files:**
- `app/(app)/pos/_components/tables-view.tsx` (new): table tiles grouped by area (free or open: total and minutes),
  plus open takeaway and delivery tickets by number.
- `ticket-bar.tsx` (new):
  - the order type segmented control (Dine-in, Takeaway, Delivery);
  - the table or ticket name;
  - Hold (save), Send to kitchen (save, send, print), Move, Cancel ticket.
- `app/(app)/_components/kitchen-print.tsx` (new, 80 mm, built like `receipt-print.tsx`), with the "cancelled" slip
  variant.
- `till.tsx`:
  - for a café, the Tables view is the start screen;
  - opening a ticket loads its lines into the cart, and sent lines show a mark;
  - Pay sends `ticket`;
  - counter sales send `orderType: "TAKEAWAY"`;
  - offline hides tables and tickets.
- `close-shift.tsx`: an "N open tickets" note.
- i18n `pos.ticket.*`, `pos.tables.*`, `kitchen.*`, `settings.tables.*`.

Tests:
- unit `pos-tickets.test.ts`: ticket total, which lines go on the kitchen slip;
- E2E `cafe-tickets.spec.ts`:
  - table 4: order, send, add a water later, send again, pay;
  - takeaway hold and pay;
  - a second browser sees the open ticket;
  - Arabic;
  - a retail shop sees no Tables.

Then the full gate. PR 2.

---

## PR 3: service charge (branch `ui-refresh/restaurant-service`)

### Task 8: the setting and the totals (migration 3)

**Files:**
- `prisma/schema.prisma`: `Organization.serviceChargeBp Int @default(0)`, `Sale.serviceChargeMinor Int @default(0)`
  and `Refund.serviceChargeMinor Int @default(0)`.
- Migration `restaurant_service_charge` with a CHECK of 0–2500.
- `modules/org/service-charge.ts`: get and update, Owner only (`shop.manage`), audited
  `settings.service_charge.updated`; a card on Settings → Shop for café shops.
- `modules/sales/totals.ts`: `priceSale(lines, saleDiscount, rateBp, pricesIncludeVat, serviceChargeBp = 0)`.
  - The service charge's shelf amount is `percentOfBp(Σ line amounts after all discounts, serviceChargeBp)`.
  - It is priced like a VAT-applicable line at `rateBp` (VAT included or added per `pricesIncludeVat`).
  - `PricedSale` gains `serviceCharge: PricedLine | null`, and its net and VAT are inside `subtotalMinor`, `vatMinor`
    and `totalMinor`.
- `create.ts`:
  - `SaleInput.serviceCharge?: boolean` (default true);
  - applied when `orderType === "DINE_IN"`, `org.serviceChargeBp > 0` and not switched off;
  - stored as `serviceChargeMinor` (its gross);
  - the audit metadata says `serviceChargeRemoved: true` when the cashier switched it off.
- Till: a service-charge row on dine-in with a remove/restore toggle, and `previewCart` takes the bp. Receipt and
  print: a "Service charge 12%" row.

Tests:
- unit `sales-totals.test.ts`: service charge with VAT included and added, after a sale discount, at 0 bp;
- integration `service-charge.test.ts`: dine-in charged, takeaway not, removed (audited), setting Owner only.

### Task 9: refunds and reports

**Files:**
- `modules/sales/refunds.ts`:
  - a refund gives back service charge in proportion:
    `share = round(serviceChargeMinor × refundedLineGross ÷ Σ lineTotalMinor)`;
  - the last refund that returns everything left gives back the remainder exactly, and the share is capped at what
    is left;
  - its VAT is `vatInGross` (prices including VAT) or the part of the share that is VAT;
  - stored on `Refund.serviceChargeMinor`, and inside the refund's totals.
- Reports:
  - the sales summary gains a `serviceChargeMinor` column (net of refunds);
  - the Z-report and the close preview get a service-charge line;
  - product, category and profit reports exclude the service charge, since it is on no line.
- `docs/user/cashier.md` (tables, tickets, options, kitchen slip, service charge) and `docs/product/known-limitations.md`
  (spec §3).

Tests: integration in `service-charge.test.ts`:
- partial refunds summing exactly to the charge;
- the Z-report and sales summary rows;
- profit unchanged;
- `expectReconciled`.

### Task 10: verification and PR 3

- [ ] Full gate (lint, typecheck, format:check, vitest, playwright).
- [ ] Write the as-built note `restaurant-cafe-as-built.md`, mark the spec built, update phase status and the README
  row.
- [ ] Final whole-branch review on opus; fix pass.
- [ ] Open PRs 1–3 against `main` with auto-merge (merge commit) and confirm CI is green.
