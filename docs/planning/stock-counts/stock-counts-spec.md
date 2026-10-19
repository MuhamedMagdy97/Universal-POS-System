# Stock Counts (Count Sessions): Specification

Status: **Spec approved by the owner (2026-10-19, every decision as recommended).** Phase 13 hardening.

Source: `docs/product/known-limitations.md` "Inventory" ("no stock counts or count sessions") and the as-built
`modules/inventory` (phase 7). Single-item corrections stay on the existing adjust dialog (`COUNT_CORRECTION`).

## 1. Goal

A manager counts the shelves of one branch — everything, one category, or a chosen list of items — by scanning or
searching, reviews expected vs counted, and posts. Posting writes the differences to the stock ledger in one
transaction, without losing sales that happened while the count was open.

## 2. Decisions

| #   | Question                          | Decision (recommended, approved)                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | What is a count?                  | A `StockCount` for one branch with status `DRAFT → COUNTING → POSTED`, or `CANCELLED` from `DRAFT`/`COUNTING`. Posted and cancelled counts are read-only.                                                                                                                                                                                  |
| C2  | Scope                             | `FULL` (every stockable item at the branch), `CATEGORY` (a category and its sub-categories, resolved when an item is counted) or `ITEMS` (a list chosen while the count is a draft). Counting an item outside the scope is refused (`ITEM_NOT_IN_COUNT`).                                                                                  |
| C3  | One open count per branch         | At most one `DRAFT`/`COUNTING` count per branch (partial unique index). Two open counts over the same item would each post their own difference and correct it twice.                                                                                                                                                                    |
| C4  | Entering quantities               | Scan or search on the counting screen. A scan (Enter) adds 1 to the item's counted quantity; typing a quantity in the row replaces it (0 … 1,000,000, Arabic-Indic digits accepted). A count can be cleared. Counting is blind: the counting screen does not show on-hand.                                                                 |
| C5  | Expected quantity                 | **Snapshotted when the item is first counted** (`expectedQty` = on-hand at that moment). Clearing the count clears the snapshot, so a recount takes a new one. Why: the counter counts the shelf as it was at that moment, so the variance is `counted − expected-at-that-moment`.                                                         |
| C6  | Posting against live stock        | Posting applies `qtyDelta = counted − expected` to the **on-hand at posting time**, under the balance row lock. A sale of 2 between counting and posting stays in the ledger: the result is `counted − 2`, not `counted`. The review screen shows expected, movements since (on-hand now − expected), counted, and the difference posted. |
| C7  | Uncounted items                   | Left unchanged (no movement). The review says how many in-scope items were not counted; to zero an item, count it as 0.                                                                                                                                                                                                                   |
| C8  | Ledger rows                       | `reason = ADJUSTMENT`, `adjustmentReason = COUNT_CORRECTION`, `refType = "StockCount"`, `refId = count id`, one row per line with a non-zero difference. No new `MovementReason` value: a new value would need the `InventoryMovement_reason_direction` CHECK re-created, which purchase returns also re-creates (last migration wins and silently drops the other's value). The ledger shows these rows as "Stock count". |
| C9  | Negative result                   | Posting blocks a line that would leave on-hand below zero (same as adjustments): `409 INSUFFICIENT_STOCK` lists the lines; clear and recount them. Archived items may only lose stock (ledger rule); a count that would add stock to one is refused (`ITEM_NOT_SELLABLE`).                                                                  |
| C10 | Idempotency                       | Posting locks the count row and checks `COUNTING`; posting an already-posted count replays its result (`replayed: true`, 200) and writes nothing. Lines, balances, ledger rows, status and audit commit in one transaction.                                                                                                                 |
| C11 | Permissions                       | `inventory.adjust` creates, edits, counts, posts and cancels; `inventory.read` views counts. Denied writes are audit-logged (shared `requirePermission`).                                                                                                                                                                                   |
| C12 | Linked shops                      | Refused with `409 MANAGED_BY_INVENTORY` (shared write guard before, and `assertBuiltIn` inside, the posting transaction). The screens hide the actions.                                                                                                                                                                                    |
| C13 | Audit                             | `inventory.count.created`, `inventory.count.started`, `inventory.count.cancelled`, `inventory.count.posted` (`{ branchId, lines, totalDelta }`). Individual count entries are not audited (the posted lines are the record).                                                                                                              |
| C14 | Scope of queries                  | Every query filters by `orgId`; the count's branch must be in the caller's branch scope (else 404).                                                                                                                                                                                                                                        |
| C15 | Not built                         | Count sheets/printing, multiple counters per item with reconciliation, freezing sales during a count, partial posting, recount workflows, cost/variance value reports.                                                                                                                                                                   |

## 3. Data

- `StockCount { id, orgId, branchId, status, scope, categoryId?, note?, createdByUserId, postedByUserId?, postedAt?, cancelledAt?, createdAt, updatedAt }`.
- `StockCountLine { id, orgId, countId, productId, variantId?, countedQty?, expectedQty?, countedAt?, onHandAtPost?, qtyDelta? }`, one line per item per count (unique, `NULLS NOT DISTINCT`). `countedQty` and `expectedQty` are both set or both null (CHECK).

## 4. API

- `GET /api/inventory/counts?branchId` → `{ rows }` (newest first, last 50).
- `POST /api/inventory/counts` `{ branchId, scope, categoryId?, note? }` → `201 { id }`.
- `GET /api/inventory/counts/:id` → count with lines (expected and on-hand included: `inventory.read`).
- `POST /api/inventory/counts/:id/items` `{ refs }` (draft, `ITEMS` scope) → `200 { items }`. `DELETE` with `{ ref }` removes one (`204`).
- `POST /api/inventory/counts/:id/start` → `204`.
- `POST /api/inventory/counts/:id/lines` `{ ref, add?: int, set?: int | null }` → `200 { countedQty }` (exactly one of `add`/`set`; `set: null` clears).
- `POST /api/inventory/counts/:id/post` → `201 { lines, totalDelta, replayed }` (`200` on a replay).
- `POST /api/inventory/counts/:id/cancel` → `204`.

## 5. Screens (`/inventory/counts`, EN/AR, RTL)

- List with "New count" (scope picker: full / category / chosen items).
- Count page by status: draft (pick items for `ITEMS`, Start, Cancel), counting (scan/search box, counted rows with
  quantity box and clear, Review), review (expected, since, counted, difference, uncounted total, Post, Back),
  posted/cancelled (read-only summary).

## 6. Tests

- Unit: input schemas, the difference rule.
- Integration: full flow and ledger rows, a sale during counting (difference applied to live on-hand), scope refusals,
  one open count per branch, replayed post, negative refusal, permissions, branch/tenant isolation, linked shop refused.
- E2E: create a full count → scan an item twice → type a quantity → review → post → stock and ledger updated.
