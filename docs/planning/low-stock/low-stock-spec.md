# Reorder Points and Low-Stock Alerts: Specification

Status: **Spec approved by the owner (2026-10-19, every decision as recommended).** Phase 13 hardening.

Source: `docs/product/known-limitations.md` "Inventory" ("no reorder points or low-stock alerts") and the as-built
`modules/inventory` (phase 7).

## 1. Goal

A manager sets a minimum quantity (reorder point) for an item at a branch. When on-hand stock at that branch drops to
or below it, the item shows on a **Low stock** list for that branch, which exports to CSV, and the dashboard shows how
many items are low.

## 2. Decisions

| #   | Question                         | Decision (recommended, approved)                                                                                                                                                                                                         |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Where is the reorder point kept? | A nullable `reorderPoint Int` on the existing per-branch `StockBalance` row. One migration, no new table. `null` = not tracked. The row is created on demand by the same lock-and-insert path every stock write uses (qty 0 stays reconciled). |
| L2  | Unit                             | Per item (product without variants, or each variant) per branch. Whole units, 0 … 1,000,000.                                                                                                                                             |
| L3  | When is an item low?             | `reorderPoint IS NOT NULL AND qty <= reorderPoint`. A point of 0 flags only zero or negative stock.                                                                                                                                       |
| L4  | Who sets it?                     | `inventory.adjust` (same as stock adjustments: Owner, Admin, Manager). Denied attempts are audit-logged like other inventory writes.                                                                                                      |
| L5  | Audit                            | `inventory.reorder_point.set` with `{ branchId, ref, before, after }`. Saving the same value succeeds without an audit row (a settings field, so idempotent rather than an error).                                                                                            |
| L6  | Clearing                         | Sending `reorderPoint: null` stops tracking the item.                                                                                                                                                                                    |
| L7  | Who sees the list?               | `inventory.read`, branch-scoped like the stock list. Archived items are listed only while they still hold stock (same rule as the stock list).                                                                                           |
| L8  | Where is the list?               | `/inventory/low-stock` (inventory sub-page with the branch picker), sorted by shortfall (`reorderPoint − qty`) then name. CSV via `GET /api/inventory/low-stock?branchId&format=csv` (BOM, CRLF, formula-safe; export audit-logged).        |
| L9  | Dashboard                        | A "Low stock" tile for `inventory.read` users with the count at their current branch (session branch, else the first in scope by name, as the inventory pages do). Links to the list.                                                       |
| L10 | Notifications (email/push)       | Not built. The list and the tile are the alert.                                                                                                                                                                                          |
| L11 | "Create PO" from the list        | Not built: the PO editor takes no prefill today, so it is not trivial. Deferred.                                                                                                                                                         |

## 3. API

- `POST /api/inventory/reorder-point` `{ branchId, ref: { productId, variantId? }, reorderPoint: int | null }` → `200 { reorderPoint }`.
- `GET /api/inventory/low-stock?branchId[&format=csv&locale]` → `{ rows: LowStockRow[] }` or a CSV download. Capped at 1,000 rows.

## 4. Tests

- Unit: reorder-point input schema, "is low" rule.
- Integration: set/clear/no-op/audit, permission denial (Cashier), tenant and branch isolation, list after a sale and
  an adjustment, archived items.
- E2E: set a reorder point on the stock list → adjust below → item appears on Low stock, dashboard tile counts it.
