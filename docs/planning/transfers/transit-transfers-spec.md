# Two-Step (In-Transit) Transfers: Specification

Status: **Spec approved by the owner (2026-10-20, every decision as recommended).** Phase 13 hardening.

Source: `docs/product/known-limitations.md` "Inventory" ("no two-step (in-transit) transfers") and the as-built
instant transfer in `modules/inventory/transfer.ts` (`docs/planning/phase-7/inventory-as-built.md`, D1, D6, D7, I-7).

## 1. Goal

A branch sends goods to another branch. Stock leaves the source when the goods leave (the van is loaded), and arrives at
the destination only when someone there counts what came off the van and receives it. While the goods are on the road
they are on hand nowhere; the destination's stock list shows them as "incoming".

## 2. Decisions

| #   | Question                  | Decision (recommended, approved)                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Instant transfer          | **Kept, and stays the default** on the transfer form ("Move now"). A second choice, "Send in transit", creates a two-step transfer. Shops with one building per branch (or one person doing both ends) keep today's one-click flow; nothing about instant transfers changes.                                                                                                                                                  |
| T2  | What is a transit transfer | A `StockTransfer` document from one branch to another with status `SENT → RECEIVED`, or `SENT → CANCELLED`. There is no draft: the document is created by sending. Received and cancelled transfers are read-only.                                                                                                                                                                                                       |
| T3  | Send                      | One transaction: create the transfer and its lines, write one `TRANSFER_OUT` row per line at the source (`policy: block`, so the source cannot go negative), audit `inventory.transfer.sent`. Ledger rows carry `transferGroupId = transfer id` and `refType = "StockTransfer"`, `refId = transfer id`.                                                                                                                   |
| T4  | Receive                   | One transaction, once per transfer, covering every line: received quantity `0 … sent` per line. One `TRANSFER_IN` row per line for the **sent** quantity at the destination, then, for each short line, one `ADJUSTMENT` row for `−(sent − received)` with the line's shortfall reason. Status `RECEIVED`, audit `inventory.transfer.received`. A transfer is received once; there is no second partial receipt.        |
| T5  | Shortfall                 | **Written off at the destination** (recommended over returning it to the source). Goods that did not arrive are not on the source's shelf either, so putting them back there would make the source's stock wrong until its next count. A write-off at the destination records the loss where it was found, with a reason, and shows in the destination's item history and adjustment totals like any other write-off. Shortfall reasons: `DAMAGED`, `LOST_OR_STOLEN`, `OTHER` (needs a note, ledger CHECK). |
| T6  | Over-receipt              | Refused (`received ≤ sent`, `QTY_OVER_SENT`). Extra goods that arrive are a different problem (a wrong pick); the receiver records them with an adjustment (`FOUND`) after receiving.                                                                                                                                                                                                                                   |
| T7  | Cancel                    | Only while `SENT`, by the **source** side (`inventory.transfer` at the source branch). One `TRANSFER_IN` row per line back at the source for the sent quantity, status `CANCELLED`, audit `inventory.transfer.cancelled`. A cancel of a cancelled transfer replays (`replayed: true`). The destination cannot cancel; if goods never came, it receives 0 with `LOST_OR_STOLEN`.                                           |
| T8  | In transit is not on hand | In-transit quantity is never in `StockBalance` and never in `getOnHand`, so the till, low stock, counts and reconciliation see only shelf stock. The stock list adds an **Incoming** column at the destination: the sum of sent quantities on `SENT` transfers to that branch.                                                                                                                                           |
| T9  | Idempotency               | Send: the client generates the transfer id (as for instant transfers) and keeps it across retries. A retry with the same content replays (`200`, `replayed: true`); different content is `409 IDEMPOTENCY_CONFLICT`. A concurrent duplicate loses on the primary key and replays the winner. An id already used by an instant transfer is an `IDEMPOTENCY_CONFLICT`. Receive: the client sends a `receiveKey`; a retry with the same key on a received transfer replays its result, a different key is `409 TRANSFER_STATE`. |
| T10 | Concurrency               | Receive and cancel lock the transfer row (`SELECT … FOR UPDATE`) before any balance row and re-check the status, so a receive racing a cancel (or a second receive) applies exactly one. Balance rows are then locked in the global order (D7) through `applyLines`. Send locks only source balance rows.                                                                                                                    |
| T11 | Permissions & scope       | Send: `inventory.transfer`, source branch in the caller's scope, destination any active branch of the org (same as D6). Receive: `inventory.transfer` **or** `inventory.adjust`, destination branch in scope (a receiver writes off the shortfall, which is an adjustment). Cancel: `inventory.transfer`, source in scope. Read: `inventory.read`, either branch in scope; the lists show only branches in scope. Anything else is 404 (like an unknown id). Denied writes are audit-logged. |
| T12 | Linked shops              | Every write is refused with `409 MANAGED_BY_INVENTORY` (shared guard before, and `assertBuiltIn` inside, each transaction). Screens hide the actions.                                                                                                                                                                                                                                                                      |
| T13 | Archived items            | May be sent, received and cancelled (`TRANSFER_OUT`/`TRANSFER_IN` and write-offs are allowed for archived stock, as-built D8).                                                                                                                                                                                                                                                                                         |
| T14 | Reference                 | The transfer id; screens and the note show its first 8 characters uppercased (e.g. `TR-3F9A12BC`). No separate number sequence.                                                                                                                                                                                                                                                                                        |
| T15 | Transfer note             | An A4 print from the transfer page: shop header, reference, from/to branches, sent date and sender, lines with SKU and quantity sent (and received/short once received), note, and signature lines for "Sent by" and "Received by".                                                                                                                                                                                     |
| T16 | Not built                 | Several partial receipts per transfer, editing a sent transfer, approval before send, carrier/tracking fields, transfer cost or valuation, returning a shortfall to the source, receiving more than sent.                                                                                                                                                                                                                 |

## 3. Data

- `StockTransfer { id (= transfer id from the client), orgId, fromBranchId, toBranchId, status, note?, sentByUserId,
  sentAt, receivedByUserId?, receivedAt?, receiveKey?, receiveNote?, cancelledByUserId?, cancelledAt?, createdAt,
  updatedAt }`. CHECKs: from ≠ to; `RECEIVED ⇔ receivedAt and receiveKey set`; `CANCELLED ⇔ cancelledAt set`; note
  lengths ≤ 500.
- `StockTransferLine { id, orgId, transferId, productId, variantId?, qtySent, qtyReceived?, shortfallReason? }`, one line
  per item per transfer (unique, `NULLS NOT DISTINCT`). CHECKs: `qtySent 1 … 1,000,000`; `qtyReceived` null or
  `0 … qtySent`; `shortfallReason` set exactly when `qtyReceived < qtySent`, and only `DAMAGED`, `LOST_OR_STOLEN` or
  `OTHER`.
- No new `MovementReason` value and no change to the reason CHECKs: transit transfers use `TRANSFER_OUT`, `TRANSFER_IN`
  and `ADJUSTMENT`. The existing unique index `InventoryMovement_transfer_line_once` (one OUT and one IN per item per
  group) holds: a transfer gets one `TRANSFER_IN` per item, either at the destination (receive) or at the source
  (cancel), never both.

## 4. API

- `POST /api/inventory/transfers` `{ transferId, fromBranchId, toBranchId, lines: [{ ref, qty }], note? }` → `201
  { transferId, replayed }` (`200` on a replay).
- `GET /api/inventory/transfers?branchId&direction=outgoing|incoming&status?` → `{ rows }` (newest first, last 50).
- `GET /api/inventory/transfers/:id` → transfer with lines.
- `POST /api/inventory/transfers/:id/receive` `{ receiveKey, lines: [{ ref, qtyReceived, shortfallReason? }], note? }`
  → `201 { replayed, received, shortfall }` (`200` on a replay). Every line exactly once.
- `POST /api/inventory/transfers/:id/cancel` → `200 { replayed }`.

Errors: `SAME_BRANCH`, `DUPLICATE_LINE`, `INSUFFICIENT_STOCK` (send), `IDEMPOTENCY_CONFLICT`, `TRANSFER_STATE`
(receive/cancel when not `SENT`), `QTY_OVER_SENT`, `LINES_MISMATCH` (receive lines ≠ transfer lines),
`SHORTFALL_REASON` (missing, or given on a full line), note required for `OTHER`.

## 5. Screens (`/inventory/transfers`, EN/AR, RTL)

- Transfer form (`/inventory/transfer`): a "Move now / Send in transit" choice; sending in transit opens the new
  transfer's page.
- Transfers list: outgoing and incoming tabs for the chosen branch, status chips, link to each transfer.
- Transfer page: header (reference, from, to, status, dates, people, note), lines (sent; received and short once
  received), Print transfer note, Cancel (source, `SENT`), and the receive form (destination, `SENT`): received
  quantity per line prefilled with the sent quantity, a shortfall reason per short line, note, Receive.
- Stock list: Incoming column.

## 6. Tests

- Unit: receive input rules (shortfall reason, over-sent, OTHER needs note), reference format.
- Integration: send → receive in full; partial receipt (TRANSFER_IN + write-off rows, balances); receive 0; cancel
  returns stock; receive after cancel and cancel after receive refused; replays for send, receive, cancel; racing
  receive/receive and receive/cancel apply once; send cannot overdraw; incoming on the stock list and not on hand;
  tenant isolation and branch scope (send, receive, cancel, read); linked shop refused; reconcile cache vs ledger.
- E2E: admin sends in transit from branch A, receives at branch B with one short line, prints the note; Arabic RTL
  check on the transfers list.
